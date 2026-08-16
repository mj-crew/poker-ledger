import { z } from "zod";
import { query, tx } from "../db.js";
import { requireCap } from "../auth.js";
import { settle } from "../lib/settlement.js";
import { allocateProrata } from "../lib/prorata.js";
import { parseClubggExport } from "../lib/clubgg-import.js";
import { computePayouts } from "../lib/payouts.js";

async function transfersFor(periodId) {
  return (
    await query(
      `SELECT s.*, f.name AS from_name, r.name AS to_name
       FROM settlements s JOIN players f ON f.id=s.from_player_id JOIN players r ON r.id=s.to_player_id
       WHERE s.period_id=$1 ORDER BY s.amount_cents DESC`,
      [periodId]
    )
  ).rows;
}

// ClubGG weekly chip allocation (real $). Configurable in Settings.
async function allocationCents() {
  const r = await query("SELECT value_cents FROM app_settings WHERE key='clubgg_allocation_cents'");
  return r.rows[0]?.value_cents ?? 200000;
}

export default async function settlementRoutes(app) {
  app.get("/settlement/periods", { preHandler: [app.authenticate] }, async () => {
    const { rows } = await query("SELECT * FROM settlement_periods ORDER BY id DESC");
    return rows;
  });

  // ClubGG week: each active player's current chip stack, net vs the allocation,
  // their tournament (ledger) balance, and the combined total that will settle.
  app.get("/clubgg/week", { preHandler: [app.authenticate] }, async () => {
    const alloc = await allocationCents();
    const rows = (await query(
      `SELECT p.id AS player_id, p.name, p.clubgg_balance_cents, p.clubgg_rake_cents, p.clubgg_allocation_cents, p.clubgg_interim_cents,
              (SELECT max(handle) FROM handle_aliases h WHERE h.player_id=p.id AND h.platform='clubgg') AS clubgg_handle,
              COALESCE(pb.balance_cents, 0) AS ledger_balance_cents
       FROM players p LEFT JOIN player_balances pb ON pb.player_id=p.id
       WHERE p.active=TRUE ORDER BY p.name`
    )).rows;
    // Effective stack: the end-of-week balance once entered (settlement day),
    // otherwise the midweek position, otherwise the allocation (nothing played).
    // Net = (effective − allocation) + rake paid (rebated back).
    const players = rows.map((r) => {
      const effective = r.clubgg_balance_cents ?? r.clubgg_interim_cents ?? r.clubgg_allocation_cents;
      const net = (effective - r.clubgg_allocation_cents) + r.clubgg_rake_cents;
      return { ...r, net_cents: net, combined_cents: (r.ledger_balance_cents || 0) + net };
    });
    return { allocation_cents: alloc, net_sum: players.reduce((s, p) => s + p.net_cents, 0), players };
  });

  // Live ClubGG chip balances (from balance screenshots) — visible to everyone,
  // shown in the GG-style card view. Highest balance first.
  app.get("/clubgg/balances", { preHandler: [app.authenticate] }, async () => {
    const { rows } = await query(
      `SELECT p.id AS player_id, p.first_name, p.clubgg_interim_cents, p.clubgg_gg_id,
              (SELECT max(handle) FROM handle_aliases h WHERE h.player_id=p.id AND h.platform='clubgg') AS screen_name
       FROM players p WHERE p.active=TRUE
       ORDER BY p.clubgg_interim_cents DESC NULLS LAST, p.first_name`
    );
    return rows.filter((r) => r.screen_name); // only members with a ClubGG name
  });

  // Weekly rake collected = total allocated chips − current chips in play (live:
  // interim balances; at settlement: finishing stacks). Visible to everyone.
  app.get("/clubgg/rake", { preHandler: [app.authenticate] }, async () => {
    const r = (await query(
      `SELECT COALESCE(SUM(clubgg_allocation_cents), 0)::int AS allocated_cents,
              COALESCE(SUM(COALESCE(clubgg_balance_cents, clubgg_interim_cents, clubgg_allocation_cents)), 0)::int AS chips_cents
       FROM players WHERE active=TRUE`
    )).rows[0];
    return { allocated_cents: r.allocated_cents, chips_cents: r.chips_cents, rake_cents: r.allocated_cents - r.chips_cents };
  });

  // Save the entered ClubGG allocation + finishing stacks + rake (settles at lock).
  const clubggBody = z.object({
    balances: z.array(z.object({
      player_id: z.number().int(),
      clubgg_balance_cents: z.number().int().min(0).nullable(), // null until settlement day
      clubgg_rake_cents: z.number().int().min(0).default(0),
      clubgg_allocation_cents: z.number().int().min(0).optional(),
      clubgg_interim_cents: z.number().int().min(0).nullable().optional(), // set only when present
    })),
  });
  app.put("/clubgg/week", { preHandler: [app.authenticate, requireCap("settlement.lock")] }, async (req) => {
    const b = clubggBody.parse(req.body);
    const dflt = await allocationCents();
    await tx(async (c) => {
      for (const x of b.balances)
        await c.query(
          `UPDATE players SET clubgg_balance_cents=$1, clubgg_rake_cents=$2, clubgg_allocation_cents=$3,
                  clubgg_interim_cents = CASE WHEN $5 THEN $6 ELSE clubgg_interim_cents END WHERE id=$4`,
          [x.clubgg_balance_cents, x.clubgg_rake_cents ?? 0, x.clubgg_allocation_cents ?? dflt, x.player_id,
           x.clubgg_interim_cents !== undefined, x.clubgg_interim_cents ?? null]
        );
    });
    return { ok: true };
  });

  // Import the weekly ClubGG club export (.xlsx). Stats-only data (gg_* tables,
  // replaced per week so re-uploads are safe) — the money ledger is untouched.
  // Tournament prizes are RE-PAID by the house payout structure (Settings), by
  // actual finishing position, because the club redistributes chips right after
  // each tournament regardless of what ClubGG's own payout table says.
  // If the export is for the week just gone, finishing stacks + rake are also
  // pre-filled into the settlement columns (admin can still edit before lock).
  const importBody = z.object({
    data: z.string().min(1),                       // base64 xlsx
    import_stats: z.boolean().default(true),       // → gg_* tables (My Stats / Results)
    populate_balances: z.boolean().default(false), // → settlement finishing stack + rake
  });
  app.post("/clubgg/import", { preHandler: [app.authenticate, requireCap("settlement.lock")] }, async (req, reply) => {
    const { data, import_stats, populate_balances } = importBody.parse(req.body);
    let parsed;
    try {
      parsed = parseClubggExport(Buffer.from(data, "base64"));
    } catch (e) {
      return reply.code(400).send({ error: e.message || "Could not parse the file" });
    }
    const { period, tournaments, cash_sessions, balances, overview } = parsed;

    const structure = (await query(
      "SELECT payload FROM payout_structures WHERE is_default=TRUE ORDER BY id LIMIT 1"
    )).rows[0]?.payload;
    if (!structure) return reply.code(500).send({ error: "No default payout structure configured" });

    // Match export rows to players: by stored GG id first, then by ClubGG
    // nickname (and remember the id for next time). Unmatched rows are kept
    // (player_id NULL) and reported so the admin can fix the member profile.
    const ps = (await query(
      `SELECT p.id, p.name, p.clubgg_gg_id,
              (SELECT max(h.handle) FROM handle_aliases h WHERE h.player_id=p.id AND h.platform='clubgg') AS clubgg_handle
       FROM players p`
    )).rows;
    const byGgId = new Map(ps.filter((p) => p.clubgg_gg_id).map((p) => [p.clubgg_gg_id, p]));
    const byNick = new Map(ps.filter((p) => p.clubgg_handle).map((p) => [p.clubgg_handle.toLowerCase(), p]));
    const learned = new Map(); // player_id -> gg_id to remember
    const unmatched = new Set();
    const matchId = (gg_id, nickname) => {
      const p = byGgId.get(gg_id) || byNick.get(String(nickname || "").toLowerCase());
      if (!p) { unmatched.add(`${nickname} (${gg_id})`); return null; }
      if (!p.clubgg_gg_id && !learned.has(p.id)) learned.set(p.id, gg_id);
      return p.id;
    };

    const warnings = [];
    let resultRows = 0;
    // House prizes per tournament are needed for the reconciliation even when
    // stats aren't being written, so compute them up-front.
    const housePrizes = new Map(); // tournament -> amounts[]
    for (const t of tournaments) {
      const { amounts, warnings: w } = computePayouts(structure, t.entries, t.pool_cents);
      w.forEach((x) => warnings.push(`${t.title}: ${x}`));
      housePrizes.set(t, amounts);
    }

    if (import_stats) await tx(async (c) => {
      await c.query("DELETE FROM gg_tournaments WHERE week_start=$1", [period.week_start]);
      await c.query("DELETE FROM gg_cash_sessions WHERE week_start=$1", [period.week_start]);

      for (const t of tournaments) {
        const amounts = housePrizes.get(t);
        const tr = await c.query(
          `INSERT INTO gg_tournaments (title, game_type, buyin_cents, fee_cents, entries, pool_cents, played_on, started_at, week_start, week_end)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [t.title, t.game_type, t.buyin_cents, t.fee_cents, t.entries, t.pool_cents, t.played_on,
           t.started_at, period.week_start, period.week_end]
        );
        for (const p of t.players) {
          const house = amounts[p.finish_position - 1] ?? 0;
          await c.query(
            `INSERT INTO gg_tournament_results (tournament_id, player_id, gg_id, nickname, finish_position,
               reentries, invested_cents, gg_prize_cents, house_prize_cents, net_cents, hands)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [tr.rows[0].id, matchId(p.gg_id, p.nickname), p.gg_id, p.nickname, p.finish_position,
             p.reentries, p.invested_cents, p.gg_prize_cents, house, house - p.invested_cents, p.hands]
          );
          resultRows++;
        }
      }

      for (const s of cash_sessions) {
        await c.query(
          `INSERT INTO gg_cash_sessions (player_id, gg_id, nickname, table_name, game_type, bb_cents,
             played_on, started_at, hands, buyin_cents, pnl_cents, rake_cents, week_start, week_end)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [matchId(s.gg_id, s.nickname), s.gg_id, s.nickname, s.table_name, s.game_type, s.bb_cents,
           s.played_on, s.started_at, s.hands, s.buyin_cents, s.pnl_cents, s.rake_cents,
           period.week_start, period.week_end]
        );
      }

      for (const [pid, ggId] of learned) await c.query("UPDATE players SET clubgg_gg_id=$1 WHERE id=$2", [ggId, pid]);
    });

    // ---- Reconciliation -----------------------------------------------------
    // Stats and the settlement balances are populated independently (different
    // sheets), so they must be checked against each other. Two questions:
    //   1. Did we read the file correctly?  parsed cash + ClubGG-prize MTT net
    //      must equal Club Overview's own P&L per player.
    //   2. Do the balances agree with the stats?  (finishing stack − allocation)
    //      must equal cash P&L + house tournament net.
    // Anything off is reported for review rather than silently accepted.
    const ggByPlayerKey = (gg_id, nickname) =>
      byGgId.get(gg_id)?.id ?? byNick.get(String(nickname || "").toLowerCase())?.id ?? null;

    const cashByGg = new Map(), rakeByGg = new Map();
    for (const s of cash_sessions) {
      cashByGg.set(s.gg_id, (cashByGg.get(s.gg_id) || 0) + s.pnl_cents);
      rakeByGg.set(s.gg_id, (rakeByGg.get(s.gg_id) || 0) + s.rake_cents);
    }
    const ggMttByGg = new Map(), houseMttByGg = new Map();
    for (const t of tournaments) {
      const amounts = housePrizes.get(t);
      for (const p of t.players) {
        ggMttByGg.set(p.gg_id, (ggMttByGg.get(p.gg_id) || 0) + (p.gg_prize_cents - p.invested_cents));
        houseMttByGg.set(p.gg_id, (houseMttByGg.get(p.gg_id) || 0) + ((amounts[p.finish_position - 1] ?? 0) - p.invested_cents));
      }
    }

    const parse_check = [];   // our parse vs ClubGG's own P&L
    const fee_check = [];     // Club Overview Fee vs summed session rake
    for (const o of overview) {
      const mine = (cashByGg.get(o.gg_id) || 0) + (ggMttByGg.get(o.gg_id) || 0);
      if (mine !== o.pnl_cents) {
        parse_check.push({ nickname: o.nickname, ours_cents: mine, clubgg_cents: o.pnl_cents, diff_cents: mine - o.pnl_cents });
      }
      const sessionRake = rakeByGg.get(o.gg_id) || 0;
      if (sessionRake !== o.fee_cents) {
        fee_check.push({ nickname: o.nickname, overview_fee_cents: o.fee_cents, sessions_cents: sessionRake, diff_cents: o.fee_cents - sessionRake });
      }
    }

    // Settlement side: finishing stack (Club Member Balance) + rake (Club
    // Overview "Fee") vs what the stats say the player's week was worth.
    const allocs = new Map((await query("SELECT id, clubgg_allocation_cents FROM players")).rows.map((r) => [r.id, r.clubgg_allocation_cents]));
    const feeByGg = new Map(overview.map((o) => [o.gg_id, o.fee_cents]));
    const prefill = [];       // rows we would/did write
    const balance_check = []; // stats vs balances mismatches
    for (const b of balances) {
      const pid = ggByPlayerKey(b.gg_id, b.nickname);
      if (!pid) continue;
      const rake = feeByGg.get(b.gg_id) || 0;
      prefill.push({ player_id: pid, gg_id: b.gg_id, nickname: b.nickname, chips_cents: b.chips_cents, rake_cents: rake });
      const chipDelta = b.chips_cents - (allocs.get(pid) ?? 0);
      const statsNet = (cashByGg.get(b.gg_id) || 0) + (houseMttByGg.get(b.gg_id) || 0);
      if (chipDelta !== statsNet) {
        balance_check.push({
          nickname: b.nickname, chip_delta_cents: chipDelta, stats_net_cents: statsNet,
          diff_cents: chipDelta - statsNet,
        });
      }
    }

    let prefilled = 0;
    if (populate_balances) {
      await tx(async (c) => {
        for (const p of prefill) {
          await c.query("UPDATE players SET clubgg_balance_cents=$1, clubgg_rake_cents=$2 WHERE id=$3",
            [p.chips_cents, p.rake_cents, p.player_id]);
          prefilled++;
        }
      });
    }

    return {
      period,
      imported_stats: import_stats,
      tournaments: import_stats ? tournaments.length : 0,
      results: resultRows,
      cash_sessions: import_stats ? cash_sessions.length : 0,
      populated_balances: populate_balances,
      prefilled,
      prefill_available: prefill.length,
      unmatched: [...unmatched],
      warnings,
      parse_check,
      fee_check,
      balance_check,
      balanced: parse_check.length === 0 && fee_check.length === 0 && balance_check.length === 0,
    };
  });

  app.get("/settlement/periods/:id", { preHandler: [app.authenticate] }, async (req, reply) => {
    const id = Number(req.params.id);
    const period = (await query("SELECT * FROM settlement_periods WHERE id=$1", [id])).rows[0];
    if (!period) return reply.code(404).send({ error: "Not found" });
    return { ...period, transfers: await transfersFor(id) };
  });

  // Lock the week: snapshot current balances, compute minimal transfers, freeze them.
  const lockBody = z.object({ label: z.string().optional(), starts_on: z.string().optional(), ends_on: z.string().optional() });
  app.post("/settlement/periods/lock", { preHandler: [app.authenticate, requireCap("settlement.lock")] }, async (req, reply) => {
    const b = lockBody.parse(req.body ?? {});
    // A prior week must have started fresh (balances reset) before locking a new one,
    // otherwise last week's debts would be double-counted into this week's transfers.
    const unreset = (await query("SELECT id, label FROM settlement_periods WHERE balances_reset_at IS NULL ORDER BY id")).rows;
    if (unreset.length) {
      const p = unreset[0];
      return reply.code(400).send({ error: `Start the new week (reset balances) for "${p.label ?? "#" + p.id}" before locking another week.` });
    }
    // Combine the tournament ledger balance with each player's ClubGG net
    // (their chip stack minus the weekly allocation). ClubGG is written to the
    // ledger here so the combined total settles and the weekly reset zeroes it.
    const combined = new Map();
    const tournamentsBal = new Map(); // tournaments-only part, kept for the recap snapshot
    for (const r of (await query("SELECT player_id, balance_cents FROM player_balances")).rows) {
      combined.set(r.player_id, (combined.get(r.player_id) || 0) + r.balance_cents);
      tournamentsBal.set(r.player_id, r.balance_cents);
    }
    // Claimed expenses for this week are covered prorata by each player's rake
    // share and reimbursed to whoever claimed them (stays zero-sum).
    const players = (await query("SELECT id AS player_id, clubgg_balance_cents, clubgg_interim_cents, clubgg_rake_cents, clubgg_allocation_cents FROM players WHERE active=TRUE")).rows;
    // Settlement locks on END-OF-WEEK balances only. A lingering midweek
    // position with no finishing stack means the table isn't ready to lock.
    const pending = players.filter((p) => p.clubgg_balance_cents == null && p.clubgg_interim_cents != null);
    if (pending.length) {
      return reply.code(400).send({ error: "Enter the ClubGG end-of-week balances first — some players only have a midweek position." });
    }
    const claimed = {};
    let totalClaimed = 0;
    if (b.starts_on && b.ends_on) {
      for (const e of (await query(
        "SELECT player_id, amount_cents FROM expenses WHERE player_id IS NOT NULL AND status='approved' AND played_on BETWEEN $1 AND $2",
        [b.starts_on, b.ends_on]
      )).rows) { claimed[e.player_id] = (claimed[e.player_id] || 0) + e.amount_cents; totalClaimed += e.amount_cents; }
    }
    const shares = allocateProrata(players.map((p) => ({ id: p.player_id, weight: p.clubgg_rake_cents })), totalClaimed);
    const clubggNet = new Map();
    for (const p of players) {
      // NULL finishing stack = didn't touch their chips → stack is the allocation.
      const finishing = p.clubgg_balance_cents ?? p.clubgg_allocation_cents;
      const net = (finishing - p.clubgg_allocation_cents) + p.clubgg_rake_cents
        - (shares[p.player_id] || 0) + (claimed[p.player_id] || 0);
      clubggNet.set(p.player_id, net);
      combined.set(p.player_id, (combined.get(p.player_id) || 0) + net);
    }
    const nonzero = [...combined].map(([player_id, balance_cents]) => ({ player_id, balance_cents })).filter((x) => x.balance_cents !== 0);
    if (nonzero.length === 0) return reply.code(400).send({ error: "Nothing to settle — all balances are zero." });

    const { transfers, balanced, residual_cents } = settle(nonzero);
    if (!balanced) {
      return reply.code(400).send({ error: `Balances don't net to zero (off by $${residual_cents / 100}). Check the ClubGG stacks and adjustments.` });
    }
    const period = await tx(async (c) => {
      // Fold ClubGG results into the ledger so the reset offsets them too.
      for (const [pid, net] of clubggNet)
        if (net !== 0)
          await c.query("INSERT INTO ledger_entries (player_id, kind, amount_cents, note) VALUES ($1,'clubgg',$2,$3)",
            [pid, net, `ClubGG week — ${b.label ?? "settlement"}`]);
      const p = (
        await c.query(
          "INSERT INTO settlement_periods (label, starts_on, ends_on, status, locked_at) VALUES ($1,$2,$3,'locked',now()) RETURNING *",
          [b.label ?? null, b.starts_on ?? null, b.ends_on ?? null]
        )
      ).rows[0];
      for (const t of transfers) {
        await c.query(
          "INSERT INTO settlements (period_id, from_player_id, to_player_id, amount_cents) VALUES ($1,$2,$3,$4)",
          [p.id, t.from_player_id, t.to_player_id, t.amount_cents]
        );
      }
      // Snapshot each player's settlement line for the weekly recap on My
      // Balance — the live columns are wiped by the reset, this copy isn't.
      for (const pl of players) {
        const tourney = tournamentsBal.get(pl.player_id) || 0;
        const net = clubggNet.get(pl.player_id) || 0;
        await c.query(
          `INSERT INTO settlement_recaps (period_id, player_id, allocation_cents, finishing_cents, rake_cents,
             expense_share_cents, expense_claimed_cents, clubgg_net_cents, tournaments_cents, total_cents)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [p.id, pl.player_id, pl.clubgg_allocation_cents, pl.clubgg_balance_cents, pl.clubgg_rake_cents,
           shares[pl.player_id] || 0, claimed[pl.player_id] || 0, net, tourney, tourney + net]
        );
      }
      return p;
    });
    return reply.code(201).send({ ...period, transfers: await transfersFor(period.id) });
  });

  // Payer marks their transfer paid.
  app.post("/settlements/:id/mark-paid", { preHandler: [app.authenticate] }, async (req, reply) => {
    const id = Number(req.params.id);
    const s = (await query("SELECT * FROM settlements WHERE id=$1", [id])).rows[0];
    if (!s) return reply.code(404).send({ error: "Not found" });
    if (s.from_player_id !== req.user.id && req.user.role !== "admin")
      return reply.code(403).send({ error: "Only the payer can mark this paid" });
    const { rows } = await query(
      `UPDATE settlements SET payer_marked_at=now(),
         status=CASE WHEN receiver_confirmed_at IS NOT NULL THEN 'confirmed' ELSE 'paid' END
       WHERE id=$1 RETURNING *`,
      [id]
    );
    return rows[0];
  });

  // Receiver confirms they got the money.
  app.post("/settlements/:id/confirm", { preHandler: [app.authenticate] }, async (req, reply) => {
    const id = Number(req.params.id);
    const s = (await query("SELECT * FROM settlements WHERE id=$1", [id])).rows[0];
    if (!s) return reply.code(404).send({ error: "Not found" });
    if (s.to_player_id !== req.user.id && req.user.role !== "admin")
      return reply.code(403).send({ error: "Only the receiver can confirm this" });
    const { rows } = await query(
      "UPDATE settlements SET receiver_confirmed_at=now(), status='confirmed' WHERE id=$1 RETURNING *",
      [id]
    );
    return rows[0];
  });

  // Start a new week: zero out everyone's running balance now, regardless of whether
  // the transfers have been paid/confirmed. The unpaid transfers stay tracked as debts.
  app.post("/settlement/periods/:id/reset-balances", { preHandler: [app.authenticate, requireCap("settlement.reset")] }, async (req, reply) => {
    const id = Number(req.params.id);
    const period = (await query("SELECT * FROM settlement_periods WHERE id=$1", [id])).rows[0];
    if (!period) return reply.code(404).send({ error: "Not found" });
    if (period.balances_reset_at) return reply.code(409).send({ error: "This week's balances have already been reset." });

    const transfers = await transfersFor(id);
    const alloc = await allocationCents();
    await tx(async (c) => {
      for (const t of transfers) {
        // Offset each player's snapshot so balances return to zero for the new week.
        await c.query("INSERT INTO ledger_entries (player_id, kind, amount_cents, note) VALUES ($1,'settlement',$2,$3)", [t.from_player_id, t.amount_cents, `New week — ${period.label ?? "period " + id}`]);
        await c.query("INSERT INTO ledger_entries (player_id, kind, amount_cents, note) VALUES ($1,'settlement',$2,$3)", [t.to_player_id, -t.amount_cents, `New week — ${period.label ?? "period " + id}`]);
      }
      // Re-allocate ClubGG chips for the new week: allocation back to default,
      // rake cleared, and both stack readings emptied — the finishing stack
      // stays NULL until settlement day, midweek until the first screenshot.
      await c.query("UPDATE players SET clubgg_allocation_cents=$1, clubgg_balance_cents=NULL, clubgg_interim_cents=NULL, clubgg_rake_cents=0", [alloc]);
      await c.query("UPDATE settlement_periods SET balances_reset_at=now() WHERE id=$1", [id]);
    });
    return { ok: true };
  });

  // Mark the period fully settled — a record that everyone has paid/confirmed.
  // Balances are handled separately by reset-balances; this only flips the status.
  app.post("/settlement/periods/:id/settle", { preHandler: [app.authenticate, requireCap("settlement.settle")] }, async (req, reply) => {
    const id = Number(req.params.id);
    const period = (await query("SELECT * FROM settlement_periods WHERE id=$1", [id])).rows[0];
    if (!period) return reply.code(404).send({ error: "Not found" });
    if (period.status === "settled") return reply.code(409).send({ error: "Already marked settled" });

    const transfers = await transfersFor(id);
    const unconfirmed = transfers.filter((t) => t.status !== "confirmed");
    if (unconfirmed.length && req.body?.force !== true) {
      return reply.code(400).send({ error: `${unconfirmed.length} transfer(s) not yet confirmed. Pass force to mark settled anyway.` });
    }
    await query("UPDATE settlement_periods SET status='settled' WHERE id=$1", [id]);
    return { ok: true };
  });
}

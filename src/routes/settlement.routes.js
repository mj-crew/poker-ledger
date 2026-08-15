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
    // Net = (finishing stack − allocation) + rake paid (rebated back).
    const players = rows.map((r) => {
      const net = (r.clubgg_balance_cents - r.clubgg_allocation_cents) + r.clubgg_rake_cents;
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
              COALESCE(SUM(COALESCE(clubgg_interim_cents, clubgg_balance_cents)), 0)::int AS chips_cents
       FROM players WHERE active=TRUE`
    )).rows[0];
    return { allocated_cents: r.allocated_cents, chips_cents: r.chips_cents, rake_cents: r.allocated_cents - r.chips_cents };
  });

  // Save the entered ClubGG allocation + finishing stacks + rake (settles at lock).
  const clubggBody = z.object({
    balances: z.array(z.object({
      player_id: z.number().int(),
      clubgg_balance_cents: z.number().int().min(0),
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
  const importBody = z.object({ data: z.string().min(1) }); // base64 xlsx
  app.post("/clubgg/import", { preHandler: [app.authenticate, requireCap("settlement.lock")] }, async (req, reply) => {
    const { data } = importBody.parse(req.body);
    let parsed;
    try {
      parsed = parseClubggExport(Buffer.from(data, "base64"));
    } catch (e) {
      return reply.code(400).send({ error: e.message || "Could not parse the file" });
    }
    const { period, tournaments, cash_sessions, balances } = parsed;

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
    await tx(async (c) => {
      await c.query("DELETE FROM gg_tournaments WHERE week_start=$1", [period.week_start]);
      await c.query("DELETE FROM gg_cash_sessions WHERE week_start=$1", [period.week_start]);

      for (const t of tournaments) {
        const { amounts, warnings: w } = computePayouts(structure, t.entries, t.pool_cents);
        w.forEach((x) => warnings.push(`${t.title}: ${x}`));
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

    // Settlement pre-fill — only when this is the current/just-finished week,
    // so importing an old export for stats can't clobber live settlement inputs.
    const recent = (Date.now() - new Date(period.week_end + "T00:00:00").getTime()) / 86400000 <= 7;
    let prefilled = 0;
    if (recent) {
      const rakeByPlayer = new Map();
      for (const s of cash_sessions) {
        const pid = byGgId.get(s.gg_id)?.id ?? [...learned.entries()].find(([, g]) => g === s.gg_id)?.[0]
          ?? byNick.get(String(s.nickname || "").toLowerCase())?.id;
        if (pid) rakeByPlayer.set(pid, (rakeByPlayer.get(pid) || 0) + s.rake_cents);
      }
      await tx(async (c) => {
        for (const b of balances) {
          const pid = byGgId.get(b.gg_id)?.id ?? byNick.get(String(b.nickname || "").toLowerCase())?.id;
          if (!pid) continue;
          await c.query("UPDATE players SET clubgg_balance_cents=$1, clubgg_rake_cents=$2 WHERE id=$3",
            [b.chips_cents, rakeByPlayer.get(pid) || 0, pid]);
          prefilled++;
        }
      });
    }

    return {
      period,
      tournaments: tournaments.length,
      results: resultRows,
      cash_sessions: cash_sessions.length,
      unmatched: [...unmatched],
      warnings,
      prefilled: recent ? prefilled : 0,
      prefill_skipped: !recent,
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
    for (const r of (await query("SELECT player_id, balance_cents FROM player_balances")).rows)
      combined.set(r.player_id, (combined.get(r.player_id) || 0) + r.balance_cents);
    // Claimed expenses for this week are covered prorata by each player's rake
    // share and reimbursed to whoever claimed them (stays zero-sum).
    const players = (await query("SELECT id AS player_id, clubgg_balance_cents, clubgg_rake_cents, clubgg_allocation_cents FROM players WHERE active=TRUE")).rows;
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
      const net = (p.clubgg_balance_cents - p.clubgg_allocation_cents) + p.clubgg_rake_cents
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
      // Re-allocate ClubGG chips for the new week (everyone back to the default allocation, rake cleared).
      await c.query("UPDATE players SET clubgg_allocation_cents=$1, clubgg_balance_cents=$1, clubgg_rake_cents=0", [alloc]);
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

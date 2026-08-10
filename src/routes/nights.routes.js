import { z } from "zod";
import { query, tx } from "../db.js";
import { requireCap } from "../auth.js";
import { computePayouts, assignPayouts, totalEntries } from "../lib/payouts.js";

// Load the payout structure payload for a tournament (its own, else the default).
async function loadStructure(tournamentId) {
  const { rows } = await query(
    `SELECT COALESCE(ps.payload, dps.payload) AS payload
     FROM tournaments t
     LEFT JOIN payout_structures ps ON ps.id = t.payout_structure_id
     LEFT JOIN payout_structures dps ON dps.is_default = TRUE
     WHERE t.id = $1`,
    [tournamentId]
  );
  if (!rows[0]?.payload) throw new Error("No payout structure configured");
  return rows[0].payload;
}

async function tournamentDetail(id) {
  const t = (await query("SELECT * FROM tournaments WHERE id=$1", [id])).rows[0];
  if (!t) return null;
  const players = (
    await query(
      `SELECT tp.*, p.name, p.username
       FROM tournament_players tp JOIN players p ON p.id=tp.player_id
       WHERE tp.tournament_id=$1 ORDER BY tp.finish_position NULLS LAST, p.name`,
      [id]
    )
  ).rows;
  return { ...t, players };
}

export default async function nightRoutes(app) {
  // ---- Nights ----
  app.get("/nights", { preHandler: [app.authenticate] }, async () => {
    const { rows } = await query(
      `SELECT n.*, COUNT(t.id)::int AS tournament_count
       FROM nights n LEFT JOIN tournaments t ON t.night_id=n.id
       GROUP BY n.id ORDER BY n.played_on DESC, n.id DESC`
    );
    return rows;
  });

  const nightBody = z.object({ played_on: z.string(), label: z.string().optional(), notes: z.string().optional() });
  app.post("/nights", { preHandler: [app.authenticate, requireCap("nights.manage")] }, async (req, reply) => {
    const b = nightBody.parse(req.body);
    const { rows } = await query(
      "INSERT INTO nights (played_on, label, notes) VALUES ($1,$2,$3) RETURNING *",
      [b.played_on, b.label ?? null, b.notes ?? null]
    );
    return reply.code(201).send(rows[0]);
  });

  const patchNight = z.object({ status: z.enum(["open", "closed"]).optional(), label: z.string().optional() });
  app.patch("/nights/:id", { preHandler: [app.authenticate, requireCap("nights.manage")] }, async (req, reply) => {
    const id = Number(req.params.id);
    const b = patchNight.parse(req.body);
    const sets = [], vals = [];
    for (const [k, v] of Object.entries(b)) { sets.push(`${k}=$${sets.length + 1}`); vals.push(v); }
    if (sets.length) { vals.push(id); await query(`UPDATE nights SET ${sets.join(",")} WHERE id=$${vals.length}`, vals); }
    const { rows } = await query("SELECT * FROM nights WHERE id=$1", [id]);
    return rows[0] ?? reply.code(404).send({ error: "Not found" });
  });

  app.get("/nights/:id", { preHandler: [app.authenticate] }, async (req, reply) => {
    const id = Number(req.params.id);
    const night = (await query("SELECT * FROM nights WHERE id=$1", [id])).rows[0];
    if (!night) return reply.code(404).send({ error: "Night not found" });
    const tourneys = (await query("SELECT id FROM tournaments WHERE night_id=$1 ORDER BY seq", [id])).rows;
    night.tournaments = await Promise.all(tourneys.map((t) => tournamentDetail(t.id)));
    return night;
  });

  // ---- Tournaments (standalone — no 'nights') ----
  app.get("/tournaments", { preHandler: [app.authenticate] }, async () => {
    const { rows } = await query(
      `SELECT t.*,
              (SELECT json_agg(x) FROM (
                 SELECT tp.player_id, tp.entries, tp.reentries, tp.invested_cents,
                        tp.finish_position, tp.play_prize_cents, tp.payout_cents, p.name, p.username
                 FROM tournament_players tp JOIN players p ON p.id=tp.player_id
                 WHERE tp.tournament_id=t.id ORDER BY tp.finish_position NULLS LAST, p.name
               ) x) AS players
       FROM tournaments t
       ORDER BY t.played_on DESC NULLS LAST, t.starts_at DESC NULLS LAST, t.id DESC
       LIMIT 200`
    );
    return rows.map((r) => ({ ...r, players: r.players || [] }));
  });

  const createTourney = z.object({
    game_type: z.string().optional(),
    tournament_type: z.string().default("Regular"),
    buyin_cents: z.number().int().min(0),
    reentry_cents: z.number().int().min(0).default(0),
    payout_structure_id: z.number().int().optional(),
    starts_at: z.string().optional(),
    late_reg_minutes: z.number().int().min(0).optional(),
    played_on: z.string().optional(),
  });
  app.post("/tournaments", { preHandler: [app.authenticate, requireCap("nights.manage")] }, async (req, reply) => {
    const b = createTourney.parse(req.body);
    const { rows } = await query(
      `INSERT INTO tournaments (game_type, tournament_type, buyin_cents, reentry_cents, payout_structure_id, starts_at, late_reg_minutes, played_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8::date, CURRENT_DATE)) RETURNING *`,
      [b.game_type ?? null, b.tournament_type, b.buyin_cents, b.reentry_cents, b.payout_structure_id ?? null, b.starts_at ?? null, b.late_reg_minutes ?? null, b.played_on ?? null]
    );
    return reply.code(201).send(rows[0]);
  });

  // Cancel (delete) a tournament — only while not finalized (no ledger written yet).
  app.delete("/tournaments/:id", { preHandler: [app.authenticate, requireCap("nights.manage")] }, async (req, reply) => {
    const id = Number(req.params.id);
    const t = (await query("SELECT status FROM tournaments WHERE id=$1", [id])).rows[0];
    if (!t) return reply.code(404).send({ error: "Not found" });
    if (t.status === "finalized") return reply.code(409).send({ error: "Can't cancel a finalized tournament." });
    await query("DELETE FROM tournaments WHERE id=$1", [id]); // tournament_players cascade
    return { ok: true };
  });

  // ---- Tournaments ----
  const tourneyBody = z.object({
    seq: z.number().int().min(1).default(1),
    game_type: z.string().optional(),
    tournament_type: z.string().default("Regular"),
    buyin_cents: z.number().int().min(0),
    reentry_cents: z.number().int().min(0).default(0),
    payout_structure_id: z.number().int().optional(),
    starts_at: z.string().optional(),          // ISO datetime
    late_reg_minutes: z.number().int().min(0).optional(),
  });
  app.post("/nights/:id/tournaments", { preHandler: [app.authenticate, requireCap("nights.manage")] }, async (req, reply) => {
    const nightId = Number(req.params.id);
    const b = tourneyBody.parse(req.body);
    const { rows } = await query(
      `INSERT INTO tournaments (night_id, seq, game_type, tournament_type, buyin_cents, reentry_cents, payout_structure_id, starts_at, late_reg_minutes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [nightId, b.seq, b.game_type ?? null, b.tournament_type, b.buyin_cents, b.reentry_cents, b.payout_structure_id ?? null, b.starts_at ?? null, b.late_reg_minutes ?? null]
    );
    return reply.code(201).send(rows[0]);
  });

  const patchTourney = z.object({
    status: z.enum(["draft", "live", "reconciled", "finalized"]).optional(),
    rego_open: z.boolean().optional(),
    game_type: z.string().optional(),
    buyin_cents: z.number().int().min(0).optional(),
    reentry_cents: z.number().int().min(0).optional(),
    starts_at: z.string().optional(),
    late_reg_minutes: z.number().int().min(0).optional(),
  });
  app.patch("/tournaments/:id", { preHandler: [app.authenticate, requireCap("tournaments.live")] }, async (req, reply) => {
    const id = Number(req.params.id);
    const b = patchTourney.parse(req.body);
    const sets = [], vals = [];
    for (const [k, v] of Object.entries(b)) { sets.push(`${k}=$${sets.length + 1}`); vals.push(v); }
    if (sets.length) { vals.push(id); await query(`UPDATE tournaments SET ${sets.join(",")} WHERE id=$${vals.length}`, vals); }
    return (await tournamentDetail(id)) ?? reply.code(404).send({ error: "Not found" });
  });

  app.get("/tournaments/:id", { preHandler: [app.authenticate] }, async (req, reply) => {
    return (await tournamentDetail(Number(req.params.id))) ?? reply.code(404).send({ error: "Not found" });
  });

  // Upsert the player list + their entries/re-entries; recompute invested. Used live.
  const playersBody = z.object({
    players: z.array(z.object({
      player_id: z.number().int(),
      entries: z.number().int().min(0).default(1),
      reentries: z.number().int().min(0).default(0),
    })),
  });
  app.put("/tournaments/:id/players", { preHandler: [app.authenticate, requireCap("tournaments.live")] }, async (req, reply) => {
    const id = Number(req.params.id);
    const b = playersBody.parse(req.body);
    const t = (await query("SELECT buyin_cents, reentry_cents, status FROM tournaments WHERE id=$1", [id])).rows[0];
    if (!t) return reply.code(404).send({ error: "Not found" });
    if (t.status === "finalized") return reply.code(409).send({ error: "Tournament is completed — results are locked." });
    await tx(async (c) => {
      const keepIds = b.players.map((p) => p.player_id);
      // remove players no longer listed
      await c.query(
        `DELETE FROM tournament_players WHERE tournament_id=$1 AND NOT (player_id = ANY($2::bigint[]))`,
        [id, keepIds.length ? keepIds : [0]]
      );
      for (const p of b.players) {
        const invested = p.entries * t.buyin_cents + p.reentries * t.reentry_cents;
        await c.query(
          `INSERT INTO tournament_players (tournament_id, player_id, entries, reentries, invested_cents)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (tournament_id, player_id)
           DO UPDATE SET entries=EXCLUDED.entries, reentries=EXCLUDED.reentries, invested_cents=EXCLUDED.invested_cents`,
          [id, p.player_id, p.entries, p.reentries, invested]
        );
      }
    });
    return tournamentDetail(id);
  });

  // Set finishing positions and compute payouts (does not touch the ledger yet).
  const resultsBody = z.object({
    results: z.array(z.object({ player_id: z.number().int(), finish_position: z.number().int().min(1).nullable() })),
  });
  app.put("/tournaments/:id/results", { preHandler: [app.authenticate, requireCap("results.enter")] }, async (req, reply) => {
    const id = Number(req.params.id);
    const b = resultsBody.parse(req.body);
    const tstatus = (await query("SELECT status FROM tournaments WHERE id=$1", [id])).rows[0]?.status;
    if (tstatus === "finalized") return reply.code(409).send({ error: "Tournament is completed — results are locked." });
    const rows = (await query("SELECT player_id, entries, reentries, invested_cents FROM tournament_players WHERE tournament_id=$1", [id])).rows;
    if (!rows.length) return reply.code(400).send({ error: "No players in this tournament" });

    const structure = await loadStructure(id);
    const field = totalEntries(rows);
    const pool = rows.reduce((s, r) => s + r.invested_cents, 0);

    const posById = new Map(b.results.map((r) => [r.player_id, r.finish_position]));
    const ranked = rows
      .map((r) => ({ player_id: r.player_id, finish_position: posById.get(r.player_id) ?? null }))
      .filter((r) => r.finish_position != null);
    const { assignments, warnings } = assignPayouts(structure, field, pool, ranked);
    const payoutById = new Map(assignments.map((a) => [a.player_id, a.payout_cents]));

    await tx(async (c) => {
      for (const r of rows) {
        await c.query(
          "UPDATE tournament_players SET finish_position=$1, payout_cents=$2 WHERE tournament_id=$3 AND player_id=$4",
          [posById.get(r.player_id) ?? null, payoutById.get(r.player_id) ?? 0, id, r.player_id]
        );
      }
      // Auto mode clears any prior manual/chop override.
      await c.query("UPDATE tournaments SET status='reconciled', payouts_manual=FALSE WHERE id=$1", [id]);
    });
    const detail = await tournamentDetail(id);
    return { ...detail, field, pool_cents: pool, warnings };
  });

  // Manual/chop payouts: the players cut a deal, so the admin enters payouts by
  // hand. Saved as-is; finalize will trust these instead of the structure.
  const chopBody = z.object({
    players: z.array(z.object({
      player_id: z.number().int(),
      finish_position: z.number().int().min(1).nullable().optional(),
      payout_cents: z.number().int().min(0),
    })),
  });
  app.put("/tournaments/:id/payouts", { preHandler: [app.authenticate, requireCap("results.enter")] }, async (req, reply) => {
    const id = Number(req.params.id);
    const b = chopBody.parse(req.body);
    const tstatus = (await query("SELECT status FROM tournaments WHERE id=$1", [id])).rows[0]?.status;
    if (tstatus === undefined) return reply.code(404).send({ error: "Not found" });
    if (tstatus === "finalized") return reply.code(409).send({ error: "Tournament is completed — results are locked." });

    const rows = (await query("SELECT player_id, invested_cents FROM tournament_players WHERE tournament_id=$1", [id])).rows;
    if (!rows.length) return reply.code(400).send({ error: "No players in this tournament" });
    const pool = rows.reduce((s, r) => s + r.invested_cents, 0);
    const byId = new Map(b.players.map((p) => [p.player_id, p]));

    await tx(async (c) => {
      for (const r of rows) {
        const p = byId.get(r.player_id);
        await c.query(
          "UPDATE tournament_players SET finish_position=$1, payout_cents=$2 WHERE tournament_id=$3 AND player_id=$4",
          [p?.finish_position ?? null, p?.payout_cents ?? 0, id, r.player_id]
        );
      }
      await c.query("UPDATE tournaments SET status='reconciled', payouts_manual=TRUE WHERE id=$1", [id]);
    });

    const paid = b.players.reduce((s, p) => s + p.payout_cents, 0);
    const warnings = paid !== pool
      ? [`Manual payouts total $${paid / 100} but the pool is $${pool / 100} (off by $${Math.abs(paid - pool) / 100}). Balance them before completing.`]
      : [];
    const detail = await tournamentDetail(id);
    return { ...detail, pool_cents: pool, paid_cents: paid, warnings };
  });

  // Finalize ("Complete"): recompute payouts from the finishing positions and the
  // current structure, require every paid place to be filled, then write the ledger
  // (buy-in negative, payout positive) once and lock the tournament.
  app.post("/tournaments/:id/finalize", { preHandler: [app.authenticate, requireCap("results.enter")] }, async (req, reply) => {
    const id = Number(req.params.id);
    const t = (await query("SELECT status, payouts_manual FROM tournaments WHERE id=$1", [id])).rows[0];
    if (!t) return reply.code(404).send({ error: "Not found" });
    if (t.status === "finalized") return reply.code(409).send({ error: "Already finalized" });

    const rows = (await query("SELECT player_id, entries, reentries, invested_cents, finish_position, payout_cents FROM tournament_players WHERE tournament_id=$1", [id])).rows;
    if (!rows.length) return reply.code(400).send({ error: "No players in this tournament" });
    const pool = rows.reduce((s, r) => s + r.invested_cents, 0);

    // Determine each player's payout: from the structure (auto) or as stored (manual chop).
    const payoutById = new Map();
    if (t.payouts_manual) {
      for (const r of rows) payoutById.set(r.player_id, r.payout_cents ?? 0);
    } else {
      const structure = await loadStructure(id);
      const { assignments, amounts } = assignPayouts(
        structure, totalEntries(rows), pool,
        rows.map((r) => ({ player_id: r.player_id, finish_position: r.finish_position }))
      );
      // Every paid place (1..k) must be assigned to exactly one player.
      const k = amounts.length;
      const filled = new Set(rows.filter((r) => r.finish_position != null).map((r) => r.finish_position));
      const missing = [];
      for (let p = 1; p <= k; p++) if (!filled.has(p)) missing.push(p);
      if (missing.length) {
        const ord = (n) => { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
        return reply.code(400).send({
          error: `This field pays ${k} place${k > 1 ? "s" : ""}. Enter the ${missing.map(ord).join(" and ")} finisher${missing.length > 1 ? "s" : ""} before completing.`,
        });
      }
      for (const a of assignments) payoutById.set(a.player_id, a.payout_cents);
    }

    const paid = rows.reduce((s, r) => s + (payoutById.get(r.player_id) ?? 0), 0);
    if (paid !== pool) {
      return reply.code(400).send({
        error: t.payouts_manual
          ? `Manual payouts total $${paid / 100} but the pool is $${pool / 100} (off by $${Math.abs(paid - pool) / 100}). Adjust them to add up to the pool.`
          : `Reconciliation failed: payouts $${paid / 100} ≠ pool $${pool / 100}. Check the finishing positions.`,
      });
    }

    await tx(async (c) => {
      for (const r of rows) {
        const payout = payoutById.get(r.player_id) ?? 0;
        await c.query("UPDATE tournament_players SET payout_cents=$1 WHERE tournament_id=$2 AND player_id=$3", [payout, id, r.player_id]);
        if (r.invested_cents > 0)
          await c.query("INSERT INTO ledger_entries (player_id, tournament_id, kind, amount_cents, note) VALUES ($1,$2,'buyin',$3,'buy-in')", [r.player_id, id, -r.invested_cents]);
        if (payout > 0)
          await c.query("INSERT INTO ledger_entries (player_id, tournament_id, kind, amount_cents, note) VALUES ($1,$2,'payout',$3,'prize')", [r.player_id, id, payout]);
      }
      await c.query("UPDATE tournaments SET status='finalized' WHERE id=$1", [id]);
    });
    return { ok: true };
  });

  // Reopen a completed tournament for corrections: reverse its ledger rows and drop
  // it back to 'reconciled' (editable). Blocked if its week is already locked/settled.
  app.post("/tournaments/:id/reopen", { preHandler: [app.authenticate, requireCap("results.enter")] }, async (req, reply) => {
    const id = Number(req.params.id);
    const t = (await query("SELECT status FROM tournaments WHERE id=$1", [id])).rows[0];
    if (!t) return reply.code(404).send({ error: "Not found" });
    if (t.status !== "finalized") return reply.code(409).send({ error: "Only completed tournaments can be reopened." });

    const locked = (await query(
      `SELECT sp.status FROM settlement_periods sp JOIN tournaments t ON t.id=$1
       WHERE sp.status IN ('locked','settled') AND t.played_on BETWEEN sp.starts_on AND sp.ends_on LIMIT 1`,
      [id]
    )).rows[0];
    if (locked) return reply.code(409).send({ error: `This tournament's week is ${locked.status} — unlock the week first, then reopen.` });

    await tx(async (c) => {
      await c.query("DELETE FROM ledger_entries WHERE tournament_id=$1", [id]);
      await c.query("UPDATE tournaments SET status='reconciled' WHERE id=$1", [id]);
    });
    return { ok: true };
  });
}

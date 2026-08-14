import { query } from "../db.js";
import { computePayouts, totalEntries } from "../lib/payouts.js";

// Live dashboard feed: tournaments currently in play, with the pool and what each
// paid place is worth right now. The front-end polls this every few seconds.
export default async function liveRoutes(app) {
  app.get("/live", { preHandler: [app.authenticate] }, async () => {
    // The board: tournaments that are live or being reconciled (running now, any
    // date), plus tournaments COMPLETED TODAY. Completed ones drop off tomorrow.
    const tourneys = (
      await query(
        `SELECT t.*,
                COALESCE(t.payout_structure_id, (SELECT id FROM payout_structures WHERE is_default)) AS eff_structure_id
         FROM tournaments t
         WHERE t.status IN ('live','reconciled')
            OR (t.status='finalized' AND t.played_on = CURRENT_DATE)
         ORDER BY t.played_on DESC, t.starts_at NULLS LAST, t.id`
      )
    ).rows;

    const out = [];
    for (const t of tourneys) {
      const rows = (
        await query(
          `SELECT tp.player_id, tp.entries, tp.reentries, tp.invested_cents, p.name
           FROM tournament_players tp JOIN players p ON p.id=tp.player_id
           WHERE tp.tournament_id=$1 ORDER BY p.name`,
          [t.id]
        )
      ).rows;
      const structure = (await query("SELECT payload FROM payout_structures WHERE id=$1", [t.eff_structure_id])).rows[0]?.payload;
      const field = totalEntries(rows);
      const pool = rows.reduce((s, r) => s + r.invested_cents, 0);
      let places = [], warnings = [];
      if (structure && pool > 0) {
        const res = computePayouts(structure, field, pool);
        places = res.amounts.map((amt, i) => ({ place: i + 1, amount_cents: amt }));
        warnings = res.warnings;
      }
      // Player-facing lifecycle phase for the pill.
      const phase =
        t.status === "finalized" ? "completed"
        : t.status === "live" && t.rego_open ? "rego_open"
        : "rego_closed"; // live & rego closed, or reconciled (results being entered)

      const lateRegClose = t.starts_at && t.late_reg_minutes != null
        ? new Date(new Date(t.starts_at).getTime() + t.late_reg_minutes * 60000).toISOString()
        : null;

      out.push({
        id: t.id, seq: t.seq, game_type: t.game_type, tournament_type: t.tournament_type,
        buyin_cents: t.buyin_cents, reentry_cents: t.reentry_cents,
        status: t.status, rego_open: t.rego_open, phase,
        starts_at: t.starts_at, late_reg_minutes: t.late_reg_minutes, late_reg_close: lateRegClose,
        played_on: t.played_on,
        entries: field, players_count: rows.length, pool_cents: pool,
        players: rows, places, warnings,
      });
    }
    return { tournaments: out };
  });

  // Group standings — everyone's current net balance (tournaments + ClubGG net),
  // outstanding and unsettled. ClubGG net = interim stack − allocation.
  app.get("/standings", { preHandler: [app.authenticate] }, async () => {
    const { rows } = await query(
      `SELECT pb.player_id, pb.name,
              pb.balance_cents + COALESCE(p.clubgg_interim_cents - p.clubgg_allocation_cents, 0) AS balance_cents
       FROM player_balances pb JOIN players p ON p.id = pb.player_id
       ORDER BY balance_cents DESC, pb.name`
    );
    return rows;
  });
}

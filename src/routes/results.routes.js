import { query } from "../db.js";

// Results archive — every completed (finalized) tournament, newest first, with the
// full finishing order and each player's buy-ins / payout / net. Visible to everyone.
export default async function resultsRoutes(app) {
  app.get("/results", { preHandler: [app.authenticate] }, async (req) => {
    const limit = Math.min(Number(req.query?.limit) || 200, 500);
    const { rows } = await query(
      `SELECT t.id, t.game_type, t.tournament_type, t.buyin_cents, t.reentry_cents, t.played_on,
              (SELECT COALESCE(SUM(invested_cents),0) FROM tournament_players WHERE tournament_id=t.id) AS pool_cents,
              (SELECT COUNT(*)::int FROM tournament_players WHERE tournament_id=t.id) AS players_count,
              (SELECT COALESCE(SUM(entries+reentries),0) FROM tournament_players WHERE tournament_id=t.id) AS total_entries,
              (SELECT json_agg(x) FROM (
                 SELECT tp.player_id, p.name, tp.entries, tp.reentries, tp.invested_cents,
                        tp.finish_position, tp.payout_cents,
                        (tp.payout_cents - tp.invested_cents) AS net_cents
                 FROM tournament_players tp JOIN players p ON p.id=tp.player_id
                 WHERE tp.tournament_id=t.id
                 ORDER BY tp.finish_position NULLS LAST, p.name
               ) x) AS players
       FROM tournaments t
       WHERE t.status='finalized'
       ORDER BY t.played_on DESC, t.id DESC
       LIMIT $1`,
      [limit]
    );
    return rows;
  });
}

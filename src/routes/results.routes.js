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

    // Imported ClubGG tournaments, mapped to the same card shape. Payouts are
    // the HOUSE re-computed prizes (what actually changed hands), not ClubGG's.
    const gg = (await query(
      `SELECT g.id, g.title, g.game_type, g.buyin_cents, g.played_on, g.pool_cents, g.entries AS total_entries,
              (SELECT COUNT(*)::int FROM gg_tournament_results WHERE tournament_id=g.id) AS players_count,
              (SELECT json_agg(x) FROM (
                 SELECT r.player_id, COALESCE(p.name, r.nickname) AS name, 1 AS entries, r.reentries,
                        r.invested_cents, r.finish_position, r.house_prize_cents AS payout_cents, r.net_cents
                 FROM gg_tournament_results r LEFT JOIN players p ON p.id=r.player_id
                 WHERE r.tournament_id=g.id
                 ORDER BY r.finish_position
               ) x) AS players
       FROM gg_tournaments g
       ORDER BY g.played_on DESC, g.id DESC
       LIMIT $1`,
      [limit]
    )).rows;

    const all = [
      ...rows.map((r) => ({ ...r, platform: "pokerstars" })),
      ...gg.map((r) => ({
        ...r,
        id: `gg-${r.id}`, // avoid key collisions with app tournaments
        tournament_type: "ClubGG",
        reentry_cents: null,
        platform: "clubgg",
      })),
    ];
    all.sort((a, b) => (a.played_on < b.played_on ? 1 : a.played_on > b.played_on ? -1 : 0));
    return all;
  });
}

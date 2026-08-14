import { query } from "../db.js";

// "My Account": current balance, recent ledger movements, and settlement transfers
// where the logged-in player pays or receives.
export default async function accountRoutes(app) {
  app.get("/account", { preHandler: [app.authenticate] }, async (req) => {
    const me = req.user.id;

    const balance = (await query("SELECT balance_cents FROM player_balances WHERE player_id=$1", [me])).rows[0]?.balance_cents ?? 0;
    const clubgg = (await query("SELECT clubgg_interim_cents FROM players WHERE id=$1", [me])).rows[0]?.clubgg_interim_cents ?? null;

    const ledger = (
      await query(
        `SELECT le.id, le.kind, le.amount_cents, le.note, le.created_at,
                t.game_type, t.played_on
         FROM ledger_entries le
         LEFT JOIN tournaments t ON t.id=le.tournament_id
         WHERE le.player_id=$1 ORDER BY le.created_at DESC, le.id DESC LIMIT 100`,
        [me]
      )
    ).rows;

    // Transfers involving me, newest period first.
    const owe = (
      await query(
        `SELECT s.id, s.amount_cents, s.status, s.payer_marked_at, s.receiver_confirmed_at,
                sp.label AS period, sp.status AS period_status, r.name AS to_name
         FROM settlements s JOIN players r ON r.id=s.to_player_id
         JOIN settlement_periods sp ON sp.id=s.period_id
         WHERE s.from_player_id=$1 ORDER BY s.id DESC`,
        [me]
      )
    ).rows;

    const owed = (
      await query(
        `SELECT s.id, s.amount_cents, s.status, s.payer_marked_at, s.receiver_confirmed_at,
                sp.label AS period, sp.status AS period_status, f.name AS from_name
         FROM settlements s JOIN players f ON f.id=s.from_player_id
         JOIN settlement_periods sp ON sp.id=s.period_id
         WHERE s.to_player_id=$1 ORDER BY s.id DESC`,
        [me]
      )
    ).rows;

    return { balance_cents: balance, clubgg_interim_cents: clubgg, ledger, i_owe: owe, owed_to_me: owed };
  });

  // Lifetime / period performance stats for the logged-in player, computed from
  // the immutable tournament record (survives weekly balance resets). Optional
  // ?from=YYYY-MM-DD&to=YYYY-MM-DD filter on the tournament's played_on date.
  app.get("/account/stats", { preHandler: [app.authenticate] }, async (req) => {
    const me = req.user.id;
    const { from, to } = req.query || {};
    const cond = ["tp.player_id = $1", "t.status = 'finalized'"];
    const params = [me];
    const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
    if (isDate(from)) { params.push(from); cond.push(`t.played_on >= $${params.length}`); }
    if (isDate(to)) { params.push(to); cond.push(`t.played_on <= $${params.length}`); }

    const row = (await query(
      `SELECT
         COUNT(*)::int                                             AS tournaments,
         COALESCE(SUM(tp.entries + tp.reentries), 0)::int          AS entries,
         COALESCE(SUM(tp.invested_cents), 0)::int                  AS invested_cents,
         COALESCE(SUM(tp.payout_cents), 0)::int                    AS won_cents,
         COALESCE(SUM(tp.payout_cents - tp.invested_cents), 0)::int AS net_cents,
         COUNT(*) FILTER (WHERE tp.payout_cents > 0)::int          AS cashes,
         COALESCE(MAX(tp.payout_cents), 0)::int                    AS biggest_cash_cents,
         COALESCE(MAX(tp.payout_cents - tp.invested_cents), 0)::int AS best_net_cents,
         MIN(t.played_on)                                          AS first_played,
         MAX(t.played_on)                                          AS last_played
       FROM tournament_players tp JOIN tournaments t ON t.id = tp.tournament_id
       WHERE ${cond.join(" AND ")}`,
      params
    )).rows[0];

    return row;
  });
}

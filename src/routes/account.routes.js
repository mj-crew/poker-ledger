import { z } from "zod";
import { query } from "../db.js";

// "My Account": current balance, recent ledger movements, and settlement transfers
// where the logged-in player pays or receives.
export default async function accountRoutes(app) {
  // Self-service: the logged-in player's own editable details (not screen names).
  app.get("/account/me", { preHandler: [app.authenticate] }, async (req) => {
    return (await query(
      "SELECT id, first_name, last_name, phone, email, payid, username, name, (SELECT max(handle) FROM handle_aliases h WHERE h.player_id=players.id AND h.platform='clubgg') AS clubgg_handle FROM players WHERE id=$1",
      [req.user.id]
    )).rows[0];
  });

  const meBody = z.object({
    first_name: z.string().min(1).optional(),
    last_name: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().optional(),
    payid: z.string().optional(),
  });
  app.patch("/account/me", { preHandler: [app.authenticate] }, async (req) => {
    const b = meBody.parse(req.body);
    const id = req.user.id;
    await query(
      `UPDATE players SET first_name=COALESCE($1,first_name), last_name=COALESCE($2,last_name),
              phone=COALESCE($3,phone), email=COALESCE($4,email), payid=COALESCE($5,payid),
              name = COALESCE($1,first_name) || ' [' || username || ']' WHERE id=$6`,
      [b.first_name ?? null, b.last_name ?? null, b.phone ?? null, b.email ?? null, b.payid ?? null, id]
    );
    return (await query("SELECT id, first_name, last_name, phone, email, payid, username, name FROM players WHERE id=$1", [id])).rows[0];
  });
  app.get("/account", { preHandler: [app.authenticate] }, async (req) => {
    const me = req.user.id;

    const balance = (await query("SELECT balance_cents FROM player_balances WHERE player_id=$1", [me])).rows[0]?.balance_cents ?? 0;
    const cg = (await query("SELECT clubgg_interim_cents, clubgg_allocation_cents FROM players WHERE id=$1", [me])).rows[0] || {};

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
                sp.label AS period, sp.status AS period_status, r.name AS to_name, r.payid AS to_payid
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

    return {
      balance_cents: balance,
      clubgg_interim_cents: cg.clubgg_interim_cents ?? null,
      clubgg_allocation_cents: cg.clubgg_allocation_cents ?? null,
      ledger, i_owe: owe, owed_to_me: owed,
    };
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

    // ---- ClubGG tournaments (imported weekly; prizes already re-paid by the
    // house structure, so the same tile set as PokerStars applies).
    const ggCond = ["r.player_id = $1"];
    const ggParams = [me];
    if (isDate(from)) { ggParams.push(from); ggCond.push(`t.played_on >= $${ggParams.length}`); }
    if (isDate(to)) { ggParams.push(to); ggCond.push(`t.played_on <= $${ggParams.length}`); }
    const ggWhere = ggCond.join(" AND ");

    const gg_mtt = (await query(
      `SELECT
         COUNT(*)::int                                              AS tournaments,
         COALESCE(SUM(1 + r.reentries), 0)::int                     AS entries,
         COALESCE(SUM(r.invested_cents), 0)::int                    AS invested_cents,
         COALESCE(SUM(r.house_prize_cents), 0)::int                 AS won_cents,
         COALESCE(SUM(r.net_cents), 0)::int                         AS net_cents,
         COUNT(*) FILTER (WHERE r.house_prize_cents > 0)::int       AS cashes,
         COALESCE(MAX(r.house_prize_cents), 0)::int                 AS biggest_cash_cents,
         COALESCE(MAX(r.net_cents), 0)::int                         AS best_net_cents,
         MIN(t.played_on) AS first_played, MAX(t.played_on) AS last_played
       FROM gg_tournament_results r JOIN gg_tournaments t ON t.id = r.tournament_id
       WHERE ${ggWhere}`,
      ggParams
    )).rows[0];
    gg_mtt.by_game = (await query(
      `SELECT t.game_type, COUNT(*)::int AS tournaments, COALESCE(SUM(r.net_cents),0)::int AS net_cents
       FROM gg_tournament_results r JOIN gg_tournaments t ON t.id = r.tournament_id
       WHERE ${ggWhere} GROUP BY t.game_type ORDER BY tournaments DESC`,
      ggParams
    )).rows;

    // ---- ClubGG cash games. bb/100 uses per-session blind size so mixed
    // stakes stay honest: sum(pnl/bb) ÷ hands × 100.
    const cCond = ["s.player_id = $1"];
    const cParams = [me];
    if (isDate(from)) { cParams.push(from); cCond.push(`s.played_on >= $${cParams.length}`); }
    if (isDate(to)) { cParams.push(to); cCond.push(`s.played_on <= $${cParams.length}`); }
    const cWhere = cCond.join(" AND ");

    const gg_cash = (await query(
      `SELECT
         COUNT(*)::int                              AS sessions,
         COALESCE(SUM(s.hands), 0)::int             AS hands,
         COALESCE(SUM(s.pnl_cents), 0)::int         AS net_cents,
         COALESCE(SUM(s.rake_cents), 0)::int        AS rake_cents,
         COALESCE(SUM(s.buyin_cents), 0)::int       AS buyin_cents,
         COALESCE(MAX(s.pnl_cents), 0)::int         AS best_cents,
         COALESCE(MIN(s.pnl_cents), 0)::int         AS worst_cents,
         COALESCE(SUM(s.pnl_cents::float / NULLIF(s.bb_cents, 0)), 0) AS bb_won,
         MIN(s.played_on) AS first_played, MAX(s.played_on) AS last_played
       FROM gg_cash_sessions s WHERE ${cWhere}`,
      cParams
    )).rows[0];
    gg_cash.by_game = (await query(
      `SELECT s.game_type, COUNT(*)::int AS sessions, COALESCE(SUM(s.hands),0)::int AS hands,
              COALESCE(SUM(s.pnl_cents),0)::int AS net_cents
       FROM gg_cash_sessions s WHERE ${cWhere} GROUP BY s.game_type ORDER BY hands DESC`,
      cParams
    )).rows;

    // Legacy top-level fields kept (PokerStars block) + the two new blocks.
    return { ...row, gg_mtt, gg_cash };
  });
}

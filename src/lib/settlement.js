// Settlement engine — turn net balances into a small set of transfers.
// Greedy min-cash-flow: repeatedly match the biggest debtor to the biggest
// creditor. Produces at most N-1 transfers (home-game practical minimum).

/**
 * @param balances array of {player_id, name?, balance_cents}. Positive = owed money
 *                 (receives), negative = owes money (pays). Should sum to ~0.
 * @param opts.epsilon_cents ignore balances with |value| below this (default 0).
 * @returns {{ transfers:{from_player_id,to_player_id,amount_cents}[], balanced:boolean, residual_cents:number }}
 */
export function settle(balances, opts = {}) {
  const eps = opts.epsilon_cents ?? 0;
  const total = balances.reduce((s, b) => s + b.balance_cents, 0);

  const debtors = balances
    .filter((b) => b.balance_cents < -eps)
    .map((b) => ({ id: b.player_id, amt: -b.balance_cents })) // amt owed (positive)
    .sort((a, b) => b.amt - a.amt);
  const creditors = balances
    .filter((b) => b.balance_cents > eps)
    .map((b) => ({ id: b.player_id, amt: b.balance_cents }))
    .sort((a, b) => b.amt - a.amt);

  const transfers = [];
  let di = 0, ci = 0;
  while (di < debtors.length && ci < creditors.length) {
    const d = debtors[di], c = creditors[ci];
    const pay = Math.min(d.amt, c.amt);
    if (pay > 0) {
      transfers.push({ from_player_id: d.id, to_player_id: c.id, amount_cents: pay });
    }
    d.amt -= pay;
    c.amt -= pay;
    if (d.amt <= eps) di++;
    if (c.amt <= eps) ci++;
  }

  return { transfers, balanced: total === 0, residual_cents: total };
}

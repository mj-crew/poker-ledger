// Payout engine. Money in integer cents. Pure functions, no I/O.
//
// Consumes a payout_structures.payload of the "tiered_percent" shape:
//   { type:"tiered_percent", field_by:"entries",
//     tiers:[ {min,max,places:[pct,...]}, ... ] }
// Payouts are exact to the cent (no $-step rounding); the winner absorbs the
// sub-cent remainder so the places always sum to the pool.

/**
 * Field size for tier selection = TOTAL entries incl. re-entries across all players.
 * @param rows array of {entries, reentries}
 */
export function totalEntries(rows) {
  return rows.reduce((s, r) => s + (r.entries ?? 0) + (r.reentries ?? 0), 0);
}

/**
 * Prize pool in cents = sum of every buy-in and re-entry paid.
 * @param rows array of {entries, reentries}
 */
export function poolCentsFor(rows, buyinCents, reentryCents) {
  return rows.reduce(
    (s, r) => s + (r.entries ?? 0) * buyinCents + (r.reentries ?? 0) * (reentryCents ?? buyinCents),
    0
  );
}

/** Pick the tier whose [min,max] contains fieldSize (max=null means open-ended). */
export function tierFor(structure, fieldSize) {
  const t = structure.tiers.find(
    (t) => fieldSize >= t.min && (t.max === null || t.max === undefined || fieldSize <= t.max)
  );
  if (!t) throw new Error(`No payout tier for field size ${fieldSize}`);
  return t;
}

/**
 * Compute the real-cash payout for each paid place.
 * Rule: each lower place is its exact percentage of the pool, rounded to the
 * nearest cent; the winner takes the remainder so payouts always sum EXACTLY
 * to the pool (to the cent — no dollar-step rounding).
 *
 * @returns {{ amounts:number[], warnings:string[] }} amounts[0] = 1st place.
 */
export function computePayouts(structure, fieldSize, poolCents) {
  const pct = tierFor(structure, fieldSize).places;
  const warnings = [];

  if (poolCents < 0) throw new Error("Pool cannot be negative");
  if (pct.length === 1) return { amounts: [poolCents], warnings };

  const amounts = new Array(pct.length);
  let others = 0;
  for (let i = 1; i < pct.length; i++) {
    amounts[i] = Math.round((poolCents * pct[i]) / 100); // exact to the cent
    others += amounts[i];
  }
  amounts[0] = poolCents - others; // winner absorbs the sub-cent remainder

  if (amounts[0] < 0) {
    warnings.push(
      `Pool ${poolCents}c too small for ${pct.length} paid places — winner share is negative.`
    );
  } else if (amounts[0] < amounts[1]) {
    warnings.push(
      `Winner share (${amounts[0]}c) is below 2nd place (${amounts[1]}c) — check field size / pool.`
    );
  }
  return { amounts, warnings };
}

/**
 * Map computed place-amounts onto players by their ACTUAL finishing position.
 * 1st (finish_position 1) → amounts[0], 2nd → amounts[1], and so on. A player
 * whose position falls outside the paid places — or who has no position yet —
 * gets nothing. This is what makes progressive entry safe: recording only the
 * bust-outs (e.g. 6th, 7th, 8th) pays no one until the paid places are filled.
 * @param players array of {player_id, finish_position} (1 = winner).
 * @returns array of {player_id, finish_position, payout_cents}. Unpaid places get 0.
 */
export function assignPayouts(structure, fieldSize, poolCents, players) {
  const { amounts, warnings } = computePayouts(structure, fieldSize, poolCents);
  const out = players
    .filter((p) => p.finish_position != null)
    .map((p) => ({
      player_id: p.player_id,
      finish_position: p.finish_position,
      payout_cents: amounts[p.finish_position - 1] ?? 0,
    }));
  return { assignments: out, amounts, warnings };
}

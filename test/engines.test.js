import { test } from "node:test";
import assert from "node:assert/strict";
import { computePayouts, assignPayouts, totalEntries, poolCentsFor } from "../src/lib/payouts.js";
import { settle } from "../src/lib/settlement.js";

const HOUSE = {
  type: "tiered_percent",
  step_cents: 500,
  rounding: "up_lower_places_winner_absorbs",
  field_by: "entries",
  tiers: [
    { min: 1, max: 5, places: [100] },
    { min: 6, max: 10, places: [70, 30] },
    { min: 11, max: null, places: [45, 35, 20] },
  ],
};
const D = (dollars) => dollars * 100;

test("payouts always sum exactly to the pool and stay $5-clean", () => {
  for (const n of [1, 3, 5, 6, 8, 10, 11, 15, 20, 45]) {
    const pool = n * D(35);
    const { amounts } = computePayouts(HOUSE, n, pool);
    assert.equal(amounts.reduce((a, b) => a + b, 0), pool, `field ${n} sum`);
    for (const a of amounts) assert.equal(a % 500, 0, `field ${n} step-clean`);
  }
});

test("known payout values (buy-in $35)", () => {
  assert.deepEqual(computePayouts(HOUSE, 5, D(175)).amounts, [D(175)]);
  assert.deepEqual(computePayouts(HOUSE, 8, D(280)).amounts, [D(195), D(85)]);
  assert.deepEqual(computePayouts(HOUSE, 10, D(350)).amounts, [D(245), D(105)]);
  assert.deepEqual(computePayouts(HOUSE, 11, D(385)).amounts, [D(170), D(135), D(80)]);
  assert.deepEqual(computePayouts(HOUSE, 20, D(700)).amounts, [D(315), D(245), D(140)]);
});

test("tier boundaries: 5->1 place, 6->2 places, 11->3 places", () => {
  assert.equal(computePayouts(HOUSE, 5, D(175)).amounts.length, 1);
  assert.equal(computePayouts(HOUSE, 6, D(210)).amounts.length, 2);
  assert.equal(computePayouts(HOUSE, 11, D(385)).amounts.length, 3);
});

test("assignPayouts maps place-amounts to finishers, unpaid get 0", () => {
  const players = [
    { player_id: 1, finish_position: 2 },
    { player_id: 2, finish_position: 1 },
    { player_id: 3, finish_position: 3 },
  ];
  const { assignments } = assignPayouts(HOUSE, 8, D(280), players);
  const byId = Object.fromEntries(assignments.map((a) => [a.player_id, a.payout_cents]));
  assert.equal(byId[2], D(195)); // winner
  assert.equal(byId[1], D(85));  // 2nd
  assert.equal(byId[3], 0);      // 3rd unpaid in a 2-place field
});

test("progressive entry: recording only the bust-outs pays no one", () => {
  // 8-entry field pays 2 places. Only 6th/7th/8th entered so far -> zero payouts,
  // because prize follows the ACTUAL position, not the order finishes were typed.
  const players = [
    { player_id: 1, finish_position: 6 },
    { player_id: 2, finish_position: 7 },
    { player_id: 3, finish_position: 8 },
  ];
  const { assignments } = assignPayouts(HOUSE, 8, D(280), players);
  for (const a of assignments) assert.equal(a.payout_cents, 0, `pos ${a.finish_position} unpaid`);
  // Then the winner and runner-up land -> they get paid, 6th/7th/8th still 0.
  const full = assignPayouts(HOUSE, 8, D(280), [...players, { player_id: 9, finish_position: 1 }, { player_id: 10, finish_position: 2 }]);
  const byId = Object.fromEntries(full.assignments.map((a) => [a.player_id, a.payout_cents]));
  assert.equal(byId[9], D(195));
  assert.equal(byId[10], D(85));
  assert.equal(byId[1], 0);
});

test("field size counts total entries incl. re-entries, and pool sums all buy-ins", () => {
  // 4 players, but 3 re-entries => 7 total entries -> crosses into the 6-10 (2 places) tier.
  const rows = [
    { entries: 1, reentries: 2 },
    { entries: 1, reentries: 1 },
    { entries: 1, reentries: 0 },
    { entries: 1, reentries: 0 },
  ];
  assert.equal(totalEntries(rows), 7);
  const pool = poolCentsFor(rows, D(35), D(35)); // 7 * $35
  assert.equal(pool, D(245));
  const { amounts } = computePayouts(HOUSE, totalEntries(rows), pool);
  assert.equal(amounts.length, 2); // 2 places because 7 entries, not 1 (4 unique players)
  assert.equal(amounts.reduce((a, b) => a + b, 0), pool);
});

test("settlement nets to minimal transfers and balances", () => {
  // Mirrors the workbook's weekly example (dollars):
  // George +550, Will +250, Peter +25 receive; five players -150 and Sleiman -75 pay.
  const balances = [
    { player_id: 1, balance_cents: D(-150) }, // Noel
    { player_id: 2, balance_cents: D(25) },   // Peter
    { player_id: 3, balance_cents: D(-150) }, // Michal
    { player_id: 4, balance_cents: D(-150) }, // Toby
    { player_id: 5, balance_cents: D(-150) }, // Dan
    { player_id: 6, balance_cents: D(-75) },  // Sleiman
    { player_id: 7, balance_cents: D(-150) }, // GrinderMB
    { player_id: 8, balance_cents: D(550) },  // George
    { player_id: 9, balance_cents: D(250) },  // Will
  ];
  const { transfers, balanced, residual_cents } = settle(balances);
  assert.equal(balanced, true);
  assert.equal(residual_cents, 0);
  // Every payer's total paid == what they owed; every receiver's total == owed to them.
  const paid = {}, recv = {};
  for (const t of transfers) {
    paid[t.from_player_id] = (paid[t.from_player_id] || 0) + t.amount_cents;
    recv[t.to_player_id] = (recv[t.to_player_id] || 0) + t.amount_cents;
  }
  for (const b of balances) {
    if (b.balance_cents < 0) assert.equal(paid[b.player_id], -b.balance_cents);
    if (b.balance_cents > 0) assert.equal(recv[b.player_id], b.balance_cents);
  }
  // Practical minimum: at most N-1 transfers.
  assert.ok(transfers.length <= balances.length - 1);
});

// End-to-end smoke test against a running API (http://localhost:4000) + seeded DB.
// Drives: login -> change password -> create night/tournament -> live entries ->
// verify live payouts -> results -> finalize -> standings -> settlement lock ->
// two-sided confirm -> settle -> standings back to zero.
const BASE = process.env.BASE || "http://localhost:4000";
let token = null;
const H = (body) => ({ ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: "Bearer " + token } : {}) });
const $ = (c) => "$" + (c / 100);

async function call(method, path, body) {
  const res = await fetch(BASE + "/api" + path, { method, headers: H(body), body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${data.error || JSON.stringify(data)}`);
  return data;
}
const ok = (m) => console.log("  \x1b[32m✓\x1b[0m " + m);
const fail = (m) => { console.log("  \x1b[31m✗ " + m + "\x1b[0m"); process.exitCode = 1; };
function eq(a, b, m) { a === b ? ok(`${m} (${a})`) : fail(`${m}: expected ${b}, got ${a}`); }

const run = async () => {
  console.log("1. Auth");
  const login = await call("POST", "/auth/login", { username: "eMJey55", password: process.env.ADMIN_PW || "changeme" });
  token = login.token;
  eq(login.player.role, "admin", "logged in as admin");
  if (login.player.must_change_password) {
    await call("POST", "/auth/change-password", { current_password: process.env.ADMIN_PW || "changeme", new_password: "smoke-pass-123" });
    ok("changed temp password");
    token = (await call("POST", "/auth/login", { username: "eMJey55", password: "smoke-pass-123" })).token;
  }

  console.log("2. Roster");
  const players = await call("GET", "/players");
  eq(players.length, 12, "roster has 12 players");
  const others = players.filter((p) => p.username !== "eMJey55").slice(0, 7);
  const field = [players.find((p) => p.username === "eMJey55"), ...others]; // 8 players

  console.log("3. Night + tournament");
  const night = await call("POST", "/nights", { played_on: "2026-07-29", label: "Smoke Night" });
  const t = await call("POST", `/nights/${night.id}/tournaments`, {
    seq: 1, game_type: "NLHE", tournament_type: "Regular", buyin_cents: 3500, reentry_cents: 3500,
  });
  await call("PATCH", `/tournaments/${t.id}`, { status: "live" });
  ok(`created night ${night.id}, tournament ${t.id}, set live`);

  console.log("4. Live entries (8 players, freezeout)");
  await call("PUT", `/tournaments/${t.id}/players`, {
    players: field.map((p) => ({ player_id: p.id, entries: 1, reentries: 0 })),
  });
  const live = await call("GET", "/live");
  const lt = live.tournaments.find((x) => x.id === t.id);
  eq(lt.entries, 8, "live field size");
  eq(lt.pool_cents, 28000, "live pool $280");
  eq(lt.places.map((p) => p.amount_cents).join(","), "19500,8500", "live payouts 1st $195 / 2nd $85");

  console.log("5. Results + finalize");
  const results = await call("PUT", `/tournaments/${t.id}/results`, {
    results: field.map((p, i) => ({ player_id: p.id, finish_position: i + 1 })),
  });
  eq(results.pool_cents, 28000, "results pool");
  await call("POST", `/tournaments/${t.id}/finalize`);
  ok("finalized (zero-sum passed, ledger written)");

  console.log("6. Standings (should sum to zero)");
  let standings = await call("GET", "/standings");
  const total = standings.reduce((s, x) => s + x.balance_cents, 0);
  eq(total, 0, "standings net to zero");
  const winner = standings.find((x) => x.player_id === field[0].id);
  eq(winner.balance_cents, 16000, "winner net +$160 ($195 - $35)");

  console.log("7. Settlement: lock");
  const period = await call("POST", "/settlement/periods/lock", { label: "Smoke Week" });
  ok(`locked period ${period.id} with ${period.transfers.length} transfer(s)`);
  const tTotal = period.transfers.reduce((s, x) => s + x.amount_cents, 0);
  eq(tTotal, 16000 + 5000, "transfers total = money owed to the two cashers");

  console.log("8. Two-sided confirm (admin acts for both) + settle");
  for (const tr of period.transfers) {
    await call("POST", `/settlements/${tr.id}/mark-paid`);
    await call("POST", `/settlements/${tr.id}/confirm`);
  }
  ok("all transfers marked paid + confirmed");
  await call("POST", `/settlement/periods/${period.id}/settle`);
  ok("period settled");

  console.log("9. Standings back to zero");
  standings = await call("GET", "/standings");
  const allZero = standings.every((x) => x.balance_cents === 0);
  allZero ? ok("every balance is $0 after settle") : fail("balances not cleared: " + JSON.stringify(standings.filter((x) => x.balance_cents !== 0)));

  console.log(process.exitCode ? "\n\x1b[31mSMOKE FAILED\x1b[0m" : "\n\x1b[32mSMOKE PASSED — full cycle works end to end.\x1b[0m");
};

run().catch((e) => { console.error("\x1b[31m" + e.message + "\x1b[0m"); process.exit(1); });

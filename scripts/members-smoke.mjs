// Verify the Members flow: admin creates an account, the new member logs in,
// is forced to change password, can read the roster, and is blocked from admin actions.
const BASE = process.env.BASE || "http://localhost:4000";
const call = async (method, path, token, body) => {
  const res = await fetch(BASE + "/api" + path, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};
const ok = (m) => console.log("  \x1b[32m✓\x1b[0m " + m);
const fail = (m) => { console.log("  \x1b[31m✗ " + m + "\x1b[0m"); process.exitCode = 1; };

const run = async () => {
  const admin = (await call("POST", "/auth/login", null, { username: "eMJey55", password: "changeme" })).data.token;
  admin ? ok("admin logged in") : fail("admin login failed");

  const uname = "smoketest_" + Math.random().toString(36).slice(2, 7);
  const create = await call("POST", "/players", admin, { name: "Smoke Tester", username: uname, role: "player", temp_password: "temp123" });
  create.status === 201 ? ok("admin created member " + uname) : fail("create failed: " + JSON.stringify(create.data));

  const login = await call("POST", "/auth/login", null, { username: uname, password: "temp123" });
  login.data.player?.must_change_password === true ? ok("member login flags must_change_password") : fail("must_change not set");
  const mtok = login.data.token;

  const change = await call("POST", "/auth/change-password", mtok, { current_password: "temp123", new_password: "member-pass-1" });
  change.status === 200 ? ok("member changed password") : fail("change-password failed");

  const roster = await call("GET", "/players", mtok);
  roster.status === 200 && Array.isArray(roster.data) ? ok("member can read roster (" + roster.data.length + ")") : fail("roster read failed");

  const forbidden = await call("POST", "/players", mtok, { name: "x", username: "x", role: "player", temp_password: "temp123" });
  forbidden.status === 403 ? ok("member blocked from admin action (403)") : fail("expected 403, got " + forbidden.status);

  console.log(process.exitCode ? "\n\x1b[31mMEMBERS SMOKE FAILED\x1b[0m" : "\n\x1b[32mMEMBERS SMOKE PASSED\x1b[0m");
};
run().catch((e) => { console.error(e); process.exit(1); });

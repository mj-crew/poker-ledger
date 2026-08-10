// Verify the capability system end to end against the running API, using a
// throwaway superadmin so it doesn't need anyone's real password. Cleans up after.
import bcrypt from "bcryptjs";
import { pool } from "../src/db.js";

const BASE = process.env.BASE || "http://localhost:4000";
const SUPER = "permtest_super", ADMIN = "permtest_admin";

const call = async (method, path, token, body) => {
  const res = await fetch(BASE + "/api" + path, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};
const ok = (m) => console.log("  \x1b[32m✓\x1b[0m " + m);
const bad = (m) => { console.log("  \x1b[31m✗ " + m + "\x1b[0m"); process.exitCode = 1; };
const expect = (cond, m) => (cond ? ok(m) : bad(m));

async function cleanup() {
  await pool.query("DELETE FROM nights WHERE label = 'PermTest Night'");
  await pool.query("DELETE FROM players WHERE username IN ($1,$2)", [SUPER, ADMIN]);
}

async function main() {
  await cleanup();
  await pool.query(
    "INSERT INTO players (name, username, role, password_hash, must_change_password) VALUES ('PermTest Super',$1,'superadmin',$2,FALSE)",
    [SUPER, await bcrypt.hash("superpass", 10)]
  );

  const superTok = (await call("POST", "/auth/login", null, { username: SUPER, password: "superpass" })).data.token;
  expect(!!superTok, "temp superadmin logged in");

  // Superadmin creates an admin — starts with NO capabilities.
  const created = await call("POST", "/players", superTok, { name: "PermTest Admin", username: ADMIN, role: "admin", temp_password: "adminpass" });
  expect(created.status === 201 && created.data.role === "admin", "superadmin created an admin");
  expect(Array.isArray(created.data.capabilities) && created.data.capabilities.length === 0, "new admin has zero capabilities");
  const adminId = created.data.id;

  const adminTok = (await call("POST", "/auth/login", null, { username: ADMIN, password: "adminpass" })).data.token;

  // Without nights.manage the admin cannot create a night.
  let r = await call("POST", "/nights", adminTok, { played_on: "2026-08-01", label: "PermTest Night" });
  expect(r.status === 403, "admin blocked from creating a night (no capability)");

  // Superadmin grants nights.manage.
  r = await call("PATCH", `/players/${adminId}`, superTok, { capabilities: ["nights.manage"] });
  expect(r.status === 200 && r.data.capabilities.includes("nights.manage"), "superadmin granted nights.manage");

  // Now the admin can create a night (enforced fresh from DB, no re-login).
  r = await call("POST", "/nights", adminTok, { played_on: "2026-08-01", label: "PermTest Night" });
  expect(r.status === 201, "admin can now create a night");

  // But still cannot lock settlement (no that capability).
  r = await call("POST", "/settlement/periods/lock", adminTok, { label: "x" });
  expect(r.status === 403, "admin still blocked from locking settlement");

  // And cannot change anyone's role/permissions (superadmin-only).
  r = await call("PATCH", `/players/${adminId}`, adminTok, { role: "player" });
  expect(r.status === 403, "admin blocked from changing roles (escalation prevented)");

  // Superadmin revokes the capability — access removed immediately.
  await call("PATCH", `/players/${adminId}`, superTok, { capabilities: [] });
  r = await call("POST", "/nights", adminTok, { played_on: "2026-08-01", label: "PermTest Night" });
  expect(r.status === 403, "revoking nights.manage blocks the admin again");

  await cleanup();
  console.log(process.exitCode ? "\n\x1b[31mPERMS SMOKE FAILED\x1b[0m" : "\n\x1b[32mPERMS SMOKE PASSED — grant/revoke + escalation guards all work.\x1b[0m");
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await cleanup(); await pool.end(); } catch {} process.exit(1); });

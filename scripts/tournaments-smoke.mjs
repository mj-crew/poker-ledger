// Verify standalone tournaments (no nights): create → list → live. Cleans up.
import bcrypt from "bcryptjs";
import { pool } from "../src/db.js";
const BASE = process.env.BASE || "http://localhost:4000";
const U = "tsmoke_super", MARK = "SMOKE_TEST_TOURNEY";
const call = async (m, p, tok, body) => {
  const res = await fetch(BASE + "/api" + p, { method: m, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(tok ? { authorization: "Bearer " + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};
const ok = (m) => console.log("  \x1b[32m✓\x1b[0m " + m);
const bad = (m) => { console.log("  \x1b[31m✗ " + m + "\x1b[0m"); process.exitCode = 1; };
const cleanup = async () => { await pool.query("DELETE FROM tournaments WHERE game_type=$1", [MARK]); await pool.query("DELETE FROM players WHERE username=$1", [U]); };

const run = async () => {
  await cleanup();
  await pool.query("INSERT INTO players (name, username, role, password_hash, must_change_password) VALUES ('TSmoke Super',$1,'superadmin',$2,FALSE)", [U, await bcrypt.hash("pw", 10)]);
  const tok = (await call("POST", "/auth/login", null, { username: U, password: "pw" })).data.token;
  tok ? ok("logged in") : bad("login failed");

  const startsAt = new Date(Date.now() + 3600_000).toISOString();
  const c = await call("POST", "/tournaments", tok, { game_type: MARK, tournament_type: "Regular", buyin_cents: 3500, reentry_cents: 3500, played_on: new Date().toISOString().slice(0, 10), starts_at: startsAt, late_reg_minutes: 60 });
  c.status === 201 ? ok(`created standalone tournament #${c.data.id} (no night_id: ${c.data.night_id === null})`) : bad("create failed: " + JSON.stringify(c.data));
  const id = c.data.id;

  const list = await call("GET", "/tournaments", tok);
  Array.isArray(list.data) && list.data.some((t) => t.id === id) ? ok(`appears in GET /tournaments (${list.data.length} total)`) : bad("not in list");

  await call("PATCH", `/tournaments/${id}`, tok, { status: "live", rego_open: true });
  const live = await call("GET", "/live", tok);
  const lt = live.data.tournaments?.find((t) => t.id === id);
  if (lt && lt.starts_at && lt.late_reg_close) ok(`shows on /live with start + late-reg-close (${lt.phase})`);
  else bad("not on /live or missing time fields: " + JSON.stringify(lt));

  await cleanup();
  console.log(process.exitCode ? "\n\x1b[31mTOURNAMENTS SMOKE FAILED\x1b[0m" : "\n\x1b[32mTOURNAMENTS SMOKE PASSED\x1b[0m");
  await pool.end();
};
run().catch(async (e) => { console.error(e); try { await cleanup(); await pool.end(); } catch {} process.exit(1); });

// Verify the vision endpoint wiring (auth + capability + graceful no-key path)
// without calling Claude. Uses a throwaway superadmin; cleans up after.
import bcrypt from "bcryptjs";
import { pool } from "../src/db.js";
const BASE = process.env.BASE || "http://localhost:4000";
const U = "visiontest_super";
const call = async (m, p, tok, body) => {
  const res = await fetch(BASE + "/api" + p, { method: m, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(tok ? { authorization: "Bearer " + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};
const ok = (m) => console.log("  \x1b[32m✓\x1b[0m " + m);
const bad = (m) => { console.log("  \x1b[31m✗ " + m + "\x1b[0m"); process.exitCode = 1; };

const cleanup = () => pool.query("DELETE FROM players WHERE username=$1", [U]);
const run = async () => {
  await cleanup();
  await pool.query("INSERT INTO players (name, username, role, password_hash, must_change_password) VALUES ('Vision Super',$1,'superadmin',$2,FALSE)", [U, await bcrypt.hash("pw", 10)]);
  const tok = (await call("POST", "/auth/login", null, { username: U, password: "pw" })).data.token;
  tok ? ok("temp superadmin logged in") : bad("login failed");

  // 1x1 transparent PNG
  const px = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const r = await call("POST", "/vision/ingest", tok, { kind: "setup", media_type: "image/png", image_base64: px });
  // With no ANTHROPIC_API_KEY set, expect a clean 503 telling us to configure it.
  if (r.status === 503 && /ANTHROPIC_API_KEY/.test(r.data.error || "")) ok("no key → graceful 503: " + r.data.error);
  else if (r.status === 200) ok("vision returned data (key IS configured): " + JSON.stringify(r.data));
  else bad(`unexpected ${r.status}: ${JSON.stringify(r.data)}`);

  await cleanup();
  console.log(process.exitCode ? "\n\x1b[31mVISION SMOKE FAILED\x1b[0m" : "\n\x1b[32mVISION SMOKE PASSED\x1b[0m");
  await pool.end();
};
run().catch(async (e) => { console.error(e); try { await cleanup(); await pool.end(); } catch {} process.exit(1); });

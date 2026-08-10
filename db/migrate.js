// Apply schema.sql (idempotent-ish: drops nothing; safe on a fresh DB) and,
// with --seed, load seed.sql then set the admin bootstrap password.
//
//   node db/migrate.js           # schema only
//   node db/migrate.js --seed    # schema + roster + admin password
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import bcrypt from "bcryptjs";
import { pool } from "../src/db.js";
import "dotenv/config";

const here = dirname(fileURLToPath(import.meta.url));
const seed = process.argv.includes("--seed");

async function tableExists(name) {
  const { rows } = await pool.query("SELECT to_regclass($1) AS t", [name]);
  return rows[0].t !== null;
}

async function main() {
  if (await tableExists("public.players")) {
    console.log("Schema already present — skipping schema.sql.");
  } else {
    console.log("Applying schema.sql …");
    await pool.query(readFileSync(join(here, "schema.sql"), "utf8"));
    console.log("Schema created.");
  }

  // Idempotent additive migrations (safe to run every time).
  const alters = [
    "ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS rego_open BOOLEAN NOT NULL DEFAULT TRUE",
    "ALTER TABLE settlement_periods ADD COLUMN IF NOT EXISTS balances_reset_at TIMESTAMPTZ",
    "ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ",
    "ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS late_reg_minutes INTEGER",
    // Tournaments are now standalone (no 'nights'): give each its own date, make night_id optional.
    "ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS played_on DATE",
    "ALTER TABLE tournaments ALTER COLUMN night_id DROP NOT NULL",
    "UPDATE tournaments t SET played_on = n.played_on FROM nights n WHERE t.night_id=n.id AND t.played_on IS NULL",
    "UPDATE tournaments SET played_on = COALESCE(starts_at::date, created_at::date, CURRENT_DATE) WHERE played_on IS NULL",
    "ALTER TABLE tournaments ALTER COLUMN played_on SET DEFAULT CURRENT_DATE",
    "ALTER TABLE players ADD COLUMN IF NOT EXISTS capabilities JSONB NOT NULL DEFAULT '[]'::jsonb",
    "ALTER TABLE players DROP CONSTRAINT IF EXISTS players_role_chk",
    "ALTER TABLE players ADD CONSTRAINT players_role_chk CHECK (role IN ('superadmin','admin','player'))",
    // Promote the original admin account to system administrator.
    "UPDATE players SET role='superadmin' WHERE username='eMJey55' AND role='admin'",
    // Manual/chop payouts: when TRUE, payouts were entered by hand (a deal) and
    // finalize trusts the stored amounts instead of recomputing from the structure.
    "ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS payouts_manual BOOLEAN NOT NULL DEFAULT FALSE",
    // ClubGG weekly staking: each player's current chip stack (real $). Manager
    // re-allocates a flat amount every Monday; Sunday's difference settles.
    "ALTER TABLE players ADD COLUMN IF NOT EXISTS clubgg_balance_cents INTEGER NOT NULL DEFAULT 200000",
    // Per-player allocation for the week (can differ from the $2000 default).
    "ALTER TABLE players ADD COLUMN IF NOT EXISTS clubgg_allocation_cents INTEGER NOT NULL DEFAULT 200000",
    // ClubGG cash-game rake the player paid that week — added back to their balance
    // (we rebate our own rake), so it nets out of the settlement.
    "ALTER TABLE players ADD COLUMN IF NOT EXISTS clubgg_rake_cents INTEGER NOT NULL DEFAULT 0",
    // Simple key/value app settings (integer cents). Holds the ClubGG allocation.
    "CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value_cents INTEGER NOT NULL)",
    "INSERT INTO app_settings (key, value_cents) VALUES ('clubgg_allocation_cents', 200000) ON CONFLICT (key) DO NOTHING",
    // Login activity: exact last login, and last-seen (any authed request) for "online".
    "ALTER TABLE players ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ",
    "ALTER TABLE players ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ",
  ];
  for (const a of alters) await pool.query(a);

  if (seed) {
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM players");
    if (rows[0].n === 0) {
      console.log("Seeding roster + payout structure …");
      await pool.query(readFileSync(join(here, "seed.sql"), "utf8"));
    } else {
      console.log(`Players already exist (${rows[0].n}) — skipping seed rows.`);
    }
    const temp = process.env.ADMIN_BOOTSTRAP_PASSWORD || "changeme";
    const hash = await bcrypt.hash(temp, 10);
    const r = await pool.query(
      "UPDATE players SET password_hash=$1, must_change_password=TRUE WHERE role IN ('superadmin','admin') AND password_hash IS NULL RETURNING username",
      [hash]
    );
    if (r.rowCount > 0) {
      console.log(`Set bootstrap password for admin(s): ${r.rows.map((x) => x.username).join(", ")}`);
      console.log(`  -> log in and change it immediately (temp password from ADMIN_BOOTSTRAP_PASSWORD).`);
    }
  }
  await pool.end();
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

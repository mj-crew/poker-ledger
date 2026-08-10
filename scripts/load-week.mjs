// One-off: wipe the app's tournament/settlement data (KEEP players), fix two
// player records, and load the past week's 15 tournaments from the spreadsheet
// with EXACT payouts (reproduce the sheet). Money in integer cents.
import { readFileSync } from "fs";
import { pool, tx } from "../src/db.js";

const SP = "C:/Users/micha/AppData/Local/Temp/claude/C--Users-micha-OneDrive-Plocha-Claude-Playground/d9563101-8c0b-420d-a809-bed21cfca9ed/scratchpad/xl/xl";

// ---- xlsx parse (formula-aware) ----
const shared = [...readFileSync(SP + "/sharedStrings.xml", "utf8").matchAll(/<si>(.*?)<\/si>/gs)]
  .map((m) => [...m[1].matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((x) => x[1]).join("")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#10;/g, " "));
const colToNum = (c) => { let n = 0; for (const ch of c) n = n * 26 + (ch.charCodeAt(0) - 64); return n; };
function grid(file) {
  const xml = readFileSync(`${SP}/worksheets/${file}.xml`, "utf8");
  const rows = {};
  for (const r of xml.matchAll(/<row[^>]*r="(\d+)"[^>]*>(.*?)<\/row>/gs)) {
    const rn = +r[1]; rows[rn] = {};
    for (const c of r[2].matchAll(/<c r="([A-Z]+)\d+"(?:[^>]*t="([^"]*)")?[^>]*>(?:<f[^>]*>.*?<\/f>)?(?:<v>(.*?)<\/v>|<is><t[^>]*>(.*?)<\/t><\/is>)?<\/c>/gs)) {
      let val = c[4] !== undefined ? c[4] : c[3];
      if (val === undefined) continue;
      if (c[2] === "s") val = shared[+val];
      rows[rn][colToNum(c[1])] = String(val).replace(/&amp;/g, "&");
    }
  }
  return rows;
}
const DAYS = {
  sheet2: ["Mon", "2026-07-27"], sheet3: ["Tue", "2026-07-28"], sheet4: ["Wed", "2026-07-29"],
  sheet5: ["Thu", "2026-07-30"], sheet6: ["Fri", "2026-07-31"], sheet7: ["Sat", "2026-08-01"], sheet8: ["Sun", "2026-08-02"],
};
const num = (v) => (v == null || v === "" ? 0 : Number(v));

function parseTournaments() {
  const out = [];
  for (const [file, [, date]] of Object.entries(DAYS)) {
    const g = grid(file);
    for (const rn of Object.keys(g).map(Number).sort((a, b) => a - b)) {
      if (g[rn][1] === "Game Type" && g[rn][2]) {
        const game = g[rn][2], buyin = num(g[rn][6]), reentry = num(g[rn][8]);
        let hdr = null;
        for (let k = rn + 1; k <= rn + 4; k++) if (g[k] && g[k][1] === "Player") { hdr = k; break; }
        if (!hdr) continue;
        const players = [];
        for (let i = 1; i <= 15; i++) {
          const row = g[hdr + i] || {};
          if (row[1] === "Player" || String(row[1] || "").includes("TOTALS")) break;
          const username = row[2], entries = num(row[3]), reentries = num(row[4]), credit = num(row[7]), finish = row[9] ? Number(row[9]) : null;
          if (username && (entries || reentries || credit)) players.push({ username, entries, reentries, credit, finish });
        }
        if (players.length) out.push({ date, game, buyin, reentry, players });
      }
    }
  }
  return out;
}

async function main() {
  const tournaments = parseTournaments();
  console.log(`Parsed ${tournaments.length} tournaments.`);

  await tx(async (c) => {
    // 1) Wipe everything except players / handle_aliases / payout_structures
    for (const t of ["ledger_entries", "settlements", "settlement_periods", "whatsapp_posts", "tournament_players", "tournaments"])
      await c.query(`DELETE FROM ${t}`);
    console.log("Wiped tournament/settlement data (players kept).");

    // 2) Fix Brahim (app had name/username swapped) — real name Brahim, club username GrinderMB
    await c.query("UPDATE players SET name='Brahim', username='GrinderMB' WHERE name='GrinderMB'");
    await c.query("UPDATE handle_aliases SET handle='GrinderMB' WHERE handle='Brahim'");

    // 3) Add Joe (flairwoo85) if missing
    let joe = (await c.query("SELECT id FROM players WHERE username='flairwoo85'")).rows[0];
    if (!joe) {
      joe = (await c.query("INSERT INTO players (name, username, role, must_change_password) VALUES ('Joe','flairwoo85','player',TRUE) RETURNING id")).rows[0];
      await c.query("INSERT INTO handle_aliases (player_id, platform, handle) VALUES ($1,'club','flairwoo85') ON CONFLICT DO NOTHING", [joe.id]);
      console.log("Added Joe (flairwoo85).");
    }

    // username -> player_id
    const map = new Map();
    for (const r of (await c.query("SELECT player_id, handle FROM handle_aliases WHERE platform='club'")).rows) map.set(r.handle, r.player_id);
    const missing = new Set();

    // 4) Load each tournament with EXACT payouts, status finalized, and ledger entries
    for (const t of tournaments) {
      const tid = (await c.query(
        `INSERT INTO tournaments (game_type, tournament_type, buyin_cents, reentry_cents, played_on, status, rego_open)
         VALUES ($1,'Regular',$2,$3,$4::date,'finalized',FALSE) RETURNING id`,
        [t.game, Math.round(t.buyin * 100), Math.round(t.reentry * 100), t.date]
      )).rows[0].id;
      for (const p of t.players) {
        const pid = map.get(p.username);
        if (!pid) { missing.add(p.username); continue; }
        const invested = Math.round((p.entries * t.buyin + p.reentries * t.reentry) * 100);
        const payout = Math.round(p.credit * 100);
        await c.query(
          `INSERT INTO tournament_players (tournament_id, player_id, entries, reentries, invested_cents, finish_position, payout_cents)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [tid, pid, p.entries, p.reentries, invested, p.finish, payout]
        );
        if (invested > 0) await c.query("INSERT INTO ledger_entries (player_id, tournament_id, kind, amount_cents, note) VALUES ($1,$2,'buyin',$3,$4)", [pid, tid, -invested, `${t.game} buy-in`]);
        if (payout > 0) await c.query("INSERT INTO ledger_entries (player_id, tournament_id, kind, amount_cents, note) VALUES ($1,$2,'payout',$3,$4)", [pid, tid, payout, `${t.game} prize`]);
      }
    }
    if (missing.size) console.log("!! Unmatched usernames:", [...missing].join(", "));
  });

  // 5) Verify: app net per player vs sheet
  const bal = (await pool.query("SELECT name, balance_cents FROM player_balances WHERE balance_cents<>0 ORDER BY balance_cents DESC")).rows;
  console.log("\n=== APP NET (from ledger) ===");
  for (const b of bal) console.log(`   ${b.name.padEnd(10)} ${b.balance_cents >= 0 ? "+" : ""}$${b.balance_cents / 100}`);
  console.log("   sum $" + bal.reduce((s, b) => s + b.balance_cents, 0) / 100);
  await pool.end();
}
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });

// Parser for the weekly ClubGG club export (.xlsx). Pure: takes the workbook,
// returns plain data — no DB, no HTTP. Money is chips-at-$1 → integer cents.
//
// Layout facts this relies on (verified against real exports):
// - "MTT Detail" / "Ring Game Detail" are block-per-table: a few "Label : value"
//   rows, a header, player rows (ID like 1234-5678), then a "Total" row.
// - MTT Detail lists players in FINISHING ORDER (winner first) — that's where
//   finish_position comes from. ClubGG's own prize columns are kept as
//   gg_prize; the house re-pays by its own structure elsewhere.
// - A cash table spanning midnight appears once per day with the same
//   start-time; those blocks are aggregated into one session.
import * as XLSX from "xlsx";

const num = (v) => {
  const n = typeof v === "string" ? parseFloat(v.replace(/,/g, "")) : v;
  return Number.isFinite(n) ? n : 0;
};
const cents = (v) => Math.round(num(v) * 100);
const isGgId = (v) => typeof v === "string" && /^\d{4}-\d{4}$/.test(v);

function sheetRows(wb, name) {
  const ws = wb.Sheets[name];
  return ws ? XLSX.utils.sheet_to_json(ws, { header: 1, defval: null }) : [];
}

// "Period : 2026-08-03 ~ 2026-08-09 (UTC +10:00)" — appears on every sheet.
function findPeriod(wb) {
  for (const name of wb.SheetNames) {
    for (const row of sheetRows(wb, name).slice(0, 5)) {
      const m = /Period\s*:\s*(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})/.exec(String(row?.[0] ?? ""));
      if (m) return { week_start: m[1], week_end: m[2] };
    }
  }
  return null;
}

const startOf = (s) => /Start\/End Time\s*:\s*([\d-]+ [\d:]+)/.exec(s)?.[1] ?? null;
const tableOf = (s) => /Table Name\s*:\s*(.*?)\s*,\s*Creator/.exec(s)?.[1] ?? null;

export function parseClubggExport(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const period = findPeriod(wb);
  if (!period) throw new Error("Not a ClubGG weekly export — no 'Period : …' header found.");

  // ---- Tournaments ----------------------------------------------------------
  const tournaments = [];
  {
    let meta = {}, players = [];
    for (const r of sheetRows(wb, "MTT Detail")) {
      const c0 = String(r?.[0] ?? "");
      if (c0.startsWith("Start/End Time")) { meta.started_at = startOf(c0); continue; }
      if (c0.startsWith("Table Name")) { meta.title = tableOf(c0); continue; }
      if (c0.startsWith("Table Information")) {
        meta.game = /Game\s*:\s*MTT\(([^)]+)\)/.exec(c0)?.[1] ?? null;
        const b = /Buy-in\s*:\s*([\d.]+)\s*\+\s*([\d.]+)/.exec(c0);
        meta.buyin = b ? num(b[1]) : 0; meta.fee = b ? num(b[2]) : 0;
        continue;
      }
      if (isGgId(r?.[0])) {
        players.push({
          gg_id: r[0], nickname: r[1],
          buyin: num(r[2]), fee: num(r[4]), rebuy: num(r[6]), refee: num(r[8]),
          hands: Math.round(num(r[10])), gg_prize: num(r[11]) + num(r[12]),
        });
        continue;
      }
      if (c0 === "Total" && players.length) {
        const rows = players.map((p, i) => ({
          ...p,
          finish_position: i + 1, // export order = finishing order, winner first
          reentries: p.buyin > 0 ? Math.round(p.rebuy / p.buyin) : 0,
          invested_cents: cents(p.buyin + p.fee + p.rebuy + p.refee),
          gg_prize_cents: cents(p.gg_prize),
        }));
        tournaments.push({
          title: meta.title || "ClubGG MTT",
          game_type: meta.game,
          buyin_cents: cents(meta.buyin), fee_cents: cents(meta.fee),
          started_at: meta.started_at,
          played_on: meta.started_at ? meta.started_at.slice(0, 10) : period.week_start,
          entries: rows.reduce((s, p) => s + 1 + p.reentries, 0),
          pool_cents: rows.reduce((s, p) => s + cents(p.buyin + p.rebuy), 0),
          players: rows,
        });
        meta = {}; players = [];
      }
    }
  }

  // ---- Cash sessions --------------------------------------------------------
  const byKey = new Map(); // start|table|gg_id → aggregated session
  {
    let meta = {}, block = [];
    const flush = () => {
      for (const p of block) {
        const key = `${meta.started_at}|${meta.table}|${p.gg_id}`;
        const s = byKey.get(key) || {
          gg_id: p.gg_id, nickname: p.nickname, table_name: meta.table,
          game_type: meta.game, bb_cents: meta.bb_cents || 100,
          started_at: meta.started_at,
          played_on: meta.started_at ? meta.started_at.slice(0, 10) : period.week_start,
          hands: 0, buyin_cents: 0, pnl_cents: 0, rake_cents: 0,
        };
        s.hands += Math.round(num(p.hands));
        s.buyin_cents += cents(p.buyin);
        s.pnl_cents += cents(p.pnl);
        s.rake_cents += cents(p.rake);
        byKey.set(key, s);
      }
      block = [];
    };
    for (const r of sheetRows(wb, "Ring Game Detail")) {
      const c0 = String(r?.[0] ?? "");
      if (c0.startsWith("Start/End Time")) { flush(); meta.started_at = startOf(c0); continue; }
      if (c0.startsWith("Table Name")) { meta.table = tableOf(c0); continue; }
      if (c0.startsWith("Table Information")) {
        meta.game = /Game\s*:\s*([^,]+?)\s*,/.exec(c0)?.[1] ?? null;
        const b = /Blinds\s*:\s*([\d.]+)\/([\d.]+)/.exec(c0);
        meta.bb_cents = b ? cents(b[2]) : 100;
        continue;
      }
      if (isGgId(r?.[0])) {
        block.push({ gg_id: r[0], nickname: r[1], buyin: r[2], hands: r[4], rake: r[10], pnl: r[11] });
        continue;
      }
      if (c0 === "Total") flush();
    }
    flush();
  }

  // ---- Finishing balances ("Club Member Balance" → Chips) --------------------
  const balances = [];
  for (const r of sheetRows(wb, "Club Member Balance")) {
    if (isGgId(r?.[7])) balances.push({ gg_id: r[7], nickname: r[8], chips_cents: cents(r[9]) });
  }

  // ---- Club Overview: the authoritative per-player weekly Fee (rake paid) and
  // ClubGG's own P&L. Fee feeds the settlement's rake column; P&L is the
  // cross-check that our parsed tournament+cash figures add up.
  const overview = [];
  for (const r of sheetRows(wb, "Club Overview")) {
    if (isGgId(r?.[7])) {
      overview.push({
        gg_id: r[7], nickname: r[8],
        games: Math.round(num(r[9])), hands: Math.round(num(r[10])),
        fee_cents: cents(r[11]), pnl_cents: cents(r[19]),
      });
    }
  }

  return { period, tournaments, cash_sessions: [...byKey.values()], balances, overview };
}

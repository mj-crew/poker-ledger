import { useEffect, useState } from "react";
import { api, fmt, fmtDate } from "../api";
import { useAuth } from "../auth.jsx";

const MEDAL = { 1: "🥇", 2: "🥈", 3: "🥉" };

// Platform logo before the tournament name (falls back to a suit glyph if the
// image is missing). Same assets as My Balance.
function PlatformLogo({ platform }) {
  const [ok, setOk] = useState(true);
  const [src, glyph, color] = platform === "clubgg" ? ["/clubgg.png", "♣", "#e2e6ee"] : ["/pokerstars.png", "♠", "#d0021b"];
  return ok
    ? <img src={src} alt={platform} title={platform === "clubgg" ? "ClubGG" : "PokerStars"}
        onError={() => setOk(false)} style={{ height: 18, width: "auto", maxWidth: 44, objectFit: "contain", verticalAlign: "middle" }} />
    : <span style={{ color, fontSize: 15, lineHeight: 1 }} title={platform}>{glyph}</span>;
}

// Monday (as a YYYY-MM-DD key) of the week a tournament's date falls in.
function weekKeyOf(playedOn) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(playedOn));
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(playedOn);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + (d.getDay() === 0 ? -6 : 1 - d.getDay()));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function weekLabel(key) {
  const [y, m, d] = key.split("-").map(Number);
  const mon = new Date(y, m - 1, d), sun = new Date(y, m - 1, d + 6);
  const f = (x) => x.toLocaleDateString("en-GB");
  return `${f(mon)} - ${f(sun)}`;
}

export default function Results() {
  const { can } = useAuth();
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");
  const [weekIdx, setWeekIdx] = useState(0); // 0 = most recent week
  const canReopen = can("results.enter");

  function load() { api.get("/results").then(setRows).catch((e) => setErr(e.message)); }
  useEffect(() => { load(); }, []);

  async function reopen(id) {
    if (!confirm("Reopen this tournament for corrections? Its payouts will be reversed and it moves back to the Create tab as editable.")) return;
    setErr("");
    try { await api.post(`/tournaments/${id}/reopen`); load(); }
    catch (e) { setErr(e.message); }
  }

  if (err && !rows) return <div className="err">{err}</div>;
  if (!rows) return <p className="muted">Loading…</p>;

  // Group finalized tournaments into weeks (Mon–Sun), newest week first.
  const byWeek = {};
  for (const t of rows) (byWeek[weekKeyOf(t.played_on)] ||= []).push(t);
  const weekKeys = Object.keys(byWeek).sort().reverse();
  const idx = Math.min(weekIdx, Math.max(0, weekKeys.length - 1));
  const weekRows = weekKeys.length ? byWeek[weekKeys[idx]] : [];

  return (
    <>
      <h1>Results</h1>
      {err && <div className="err" style={{ marginBottom: 12 }}>{err}</div>}

      {weekKeys.length === 0 ? (
        <div className="card muted">No completed tournaments yet. Finalize a tournament and it lands here.</div>
      ) : (
        <div className="row" style={{ marginBottom: 16, alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <button className="ghost small" onClick={() => setWeekIdx((i) => Math.min(i + 1, weekKeys.length - 1))} disabled={idx >= weekKeys.length - 1}>◀ Older</button>
          <strong className="gold">Week {weekLabel(weekKeys[idx])}</strong>
          <span className="muted">· {weekRows.length} tournament{weekRows.length === 1 ? "" : "s"}</span>
          <button className="ghost small" onClick={() => setWeekIdx((i) => Math.max(i - 1, 0))} disabled={idx <= 0}>Newer ▶</button>
          {idx > 0 && <button className="ghost small right" onClick={() => setWeekIdx(0)}>Latest week</button>}
        </div>
      )}

      {weekRows.map((t) => {
        const winner = (t.players || []).find((p) => p.finish_position === 1);
        return (
          <div className="card" key={t.id}>
            <div className="row" style={{ flexWrap: "wrap", alignItems: "center" }}>
              <PlatformLogo platform={t.platform} />
              <strong>{t.platform === "clubgg" ? (t.title || t.game_type || "Tournament") : (t.game_type || "Tournament")}</strong>
              {t.platform === "clubgg" && t.game_type && <span className="badge gray">{t.game_type}</span>}
              {t.platform !== "clubgg" && <span className="badge gray">{t.tournament_type}</span>}
              <span className="lifepill completed"><span className="d" />Completed</span>
              <span className="right row" style={{ gap: 10 }}>
                <span className="muted">{fmtDate(t.played_on)}</span>
                {canReopen && t.platform !== "clubgg" && <button className="small ghost" onClick={() => reopen(t.id)} title="Reverse payouts and edit results">Reopen</button>}
              </span>
            </div>
            <div className="row" style={{ margin: "10px 0", gap: 18, flexWrap: "wrap" }}>
              <span className="muted">Pool <strong>{fmt(t.pool_cents)}</strong></span>
              <span className="muted">{t.total_entries} entries · {t.players_count} players</span>
              <span className="muted">Buy-in {fmt(t.buyin_cents)}{t.reentry_cents ? ` · Re-entry ${fmt(t.reentry_cents)}` : ""}</span>
              {winner && <span className="right">🏆 <strong>{winner.name}</strong> — {fmt(winner.payout_cents)}</span>}
            </div>
            <table>
              <thead>
                <tr><th>Pos</th><th>Player</th><th className="num">Entries</th><th className="num">Re-entries</th><th className="num">Invested</th><th className="num">Payout</th><th className="num">Net</th></tr>
              </thead>
              <tbody>
                {(t.players || []).map((p, i) => (
                  <tr key={p.player_id ?? `${p.name}-${i}`}>
                    <td>{MEDAL[p.finish_position] || (p.finish_position ?? "—")}</td>
                    <td>{p.name}</td>
                    <td className="num">{p.entries}</td>
                    <td className="num">{p.reentries || 0}</td>
                    <td className="num">{fmt(p.invested_cents)}</td>
                    <td className={"num " + (p.payout_cents > 0 ? "pos" : "muted")}>{p.payout_cents > 0 ? fmt(p.payout_cents) : "—"}</td>
                    <td className={"num " + (p.net_cents >= 0 ? "pos" : "neg")}>{fmt(p.net_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </>
  );
}

import { useEffect, useState } from "react";
import { api, fmt, fmtDate } from "../api";
import { useAuth } from "../auth.jsx";

const MEDAL = { 1: "🥇", 2: "🥈", 3: "🥉" };

export default function Results() {
  const { can } = useAuth();
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");
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

  return (
    <>
      <h1>Results</h1>
      <p className="sub" style={{ marginBottom: 16 }}>Every completed tournament, newest first. Locked once finalized.</p>
      {err && <div className="err" style={{ marginBottom: 12 }}>{err}</div>}

      {rows.length === 0 && <div className="card muted">No completed tournaments yet. Finalize a tournament and it lands here.</div>}

      {rows.map((t) => {
        const winner = (t.players || []).find((p) => p.finish_position === 1);
        return (
          <div className="card" key={t.id}>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <strong>{t.game_type || "Tournament"}</strong>
              <span className="badge gray">{t.tournament_type}</span>
              <span className="lifepill completed"><span className="d" />Completed</span>
              <span className="right row" style={{ gap: 10 }}>
                <span className="muted">{fmtDate(t.played_on)}</span>
                {canReopen && <button className="small ghost" onClick={() => reopen(t.id)} title="Reverse payouts and edit results">Reopen</button>}
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
                {(t.players || []).map((p) => (
                  <tr key={p.player_id}>
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

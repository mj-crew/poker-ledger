import { useEffect, useState } from "react";
import { api, fmt, fmtDate, fmtDateTime } from "../api";
import { useAuth } from "../auth.jsx";
import LifePill, { phaseOf } from "../components/LifePill.jsx";
import ScreenshotButton from "../components/ScreenshotButton.jsx";
import TournamentStatus from "../components/TournamentStatus.jsx";

const MEDAL = ["🥇", "🥈", "🥉", "4th", "5th"];

// Condensed, portrait card of what's running — for screenshotting into WhatsApp.
function ShareCard({ rows, now }) {
  const running = rows.filter((t) => t.phase !== "completed");
  return (
    <div className="sharewrap">
      <div className="sharecard" id="share-card">
        <div className="sc-head">
          <img className="sc-logo" src="/logo.png" alt="" onError={(e) => { e.currentTarget.style.display = "none"; }} />
          <div>
            <div className="sc-brand">Flawless Poker <span className="suit">9♦&nbsp;4♦</span></div>
            <div className="sc-when">{fmtDate(new Date())}</div>
          </div>
        </div>
        {running.length === 0 ? (
          <div className="sc-empty">No tournaments running right now.</div>
        ) : running.map((t) => (
          <div className="sc-item" key={t.id}>
            <div className="sc-game">{t.game_type || "Tournament"} <span className="sc-type">· {t.tournament_type}</span></div>
            <div className="sc-meta">
              <span>💵 Buy-in <b>{fmt(t.buyin_cents)}</b></span>
              <span>👥 <b className="pos">{t.entries}</b></span>
              <span>🏆 Pool <b className="prize">{fmt(t.pool_cents)}</b></span>
            </div>
            {t.places?.length > 0 && (
              <div className="sc-pay">
                {t.places.map((p) => (
                  <span key={p.place}>{MEDAL[p.place - 1] || `${p.place}.`}&nbsp;<b className="prize">{fmt(p.amount_cents)}</b></span>
                ))}
              </div>
            )}
            <div className="sc-status"><TournamentStatus t={t} now={now} /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

const TYPES = ["Regular", "Satellite", "Freeroll", "Bounty", "Mixed Game", "Other"];
const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export default function AdminTournaments() {
  const { can } = useAuth();
  const [tournaments, setTournaments] = useState(null);
  const [roster, setRoster] = useState([]);
  const [err, setErr] = useState("");
  const [live, setLive] = useState({ tournaments: [] });
  const [now, setNow] = useState(Date.now());
  const [showShare, setShowShare] = useState(false);

  async function load() {
    try {
      const [ts, r] = await Promise.all([api.get("/tournaments"), api.get("/players")]);
      setTournaments(ts); setRoster(r.filter((p) => p.active));
    } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);

  // Live feed (+ 1s tick) drives the share card's pools/entries/countdowns.
  useEffect(() => {
    const loadLive = () => api.get("/live").then(setLive).catch(() => {});
    loadLive();
    const p = setInterval(loadLive, 5000);
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(p); clearInterval(t); };
  }, []);

  if (err) return <div className="err">{err}</div>;
  if (!tournaments) return <p className="muted">Loading…</p>;

  return (
    <>
      <h1>Create a tournament</h1>
      <p className="sub" style={{ marginBottom: 16 }}>Add a tournament, then log entries and results. Live ones show on the dashboard.</p>

      {can("nights.manage") && <CreateTournament reload={load} />}

      <div className="row" style={{ marginTop: 20, marginBottom: 14, flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>Active tournaments</h2>
        <span className="right">
          <button className="ghost small" onClick={() => setShowShare((s) => !s)}>
            {showShare ? "Hide share card" : "📤 Share card"}
          </button>
        </span>
      </div>
      {showShare && (
        <>
          <p className="sub" style={{ margin: "8px 0 0" }}>Condensed view of what's running — screenshot it for the group chat.</p>
          <ShareCard rows={live.tournaments || []} now={now} />
        </>
      )}
      {(() => {
        const active = tournaments.filter((t) => t.status !== "finalized");
        if (active.length === 0) return <div className="card muted">No active tournaments — completed ones are on the <a href="/results">Results</a> tab.</div>;
        return active.map((t) => <TournamentCard key={t.id} t={t} roster={roster} reload={load} can={can} />);
      })()}
    </>
  );
}

function CreateTournament({ reload }) {
  const [game, setGame] = useState("NLHE");
  const [type, setType] = useState("Regular");
  const [buyin, setBuyin] = useState(35);
  const [reentry, setReentry] = useState(35);
  const [startLocal, setStartLocal] = useState("");
  const [lateReg, setLateReg] = useState("");
  const [err, setErr] = useState("");

  async function add(e) {
    e.preventDefault(); setErr("");
    try {
      await api.post("/tournaments", {
        game_type: game, tournament_type: type,
        buyin_cents: Math.round(buyin * 100), reentry_cents: Math.round(reentry * 100),
        played_on: startLocal ? startLocal.slice(0, 10) : localDate(),
        ...(startLocal ? { starts_at: new Date(startLocal).toISOString() } : {}),
        ...(lateReg !== "" ? { late_reg_minutes: Number(lateReg) } : {}),
      });
      setStartLocal(""); setLateReg("");
      reload();
    } catch (e) { setErr(e.message); }
  }

  function applySetup(res) {
    setErr("");
    if (res.game_type) setGame(res.game_type);
    if (res.tournament_type) setType(res.tournament_type);
    if (res.buyin_dollars) {
      setBuyin(res.buyin_dollars);
      setReentry(res.reentry_allowed ? res.buyin_dollars : 0);
    } else if (res.reentry_allowed === false) {
      setReentry(0);
    }
    if (res.start_datetime) setStartLocal(String(res.start_datetime).slice(0, 16));
    if (res.late_reg_minutes != null) setLateReg(String(res.late_reg_minutes));
  }

  return (
    <div className="card">
      <div className="row">
        <h2 style={{ margin: 0 }}>New tournament</h2>
        <span className="right"><ScreenshotButton kind="setup" label="📷 Upload lobby screenshot" onResult={applySetup} /></span>
      </div>
      <form className="row" onSubmit={add} style={{ flexWrap: "wrap", marginTop: 12 }}>
        <div><label>Game</label><input value={game} onChange={(e) => setGame(e.target.value)} /></div>
        <div><label>Type</label><select value={type} onChange={(e) => setType(e.target.value)}>{TYPES.map((x) => <option key={x}>{x}</option>)}</select></div>
        <div style={{ width: 110 }}><label>Buy-in $</label><input type="number" value={buyin} onChange={(e) => setBuyin(+e.target.value)} /></div>
        <div style={{ width: 110 }}><label>Re-entry $</label><input type="number" value={reentry} onChange={(e) => setReentry(+e.target.value)} /></div>
        <div style={{ width: 200 }}><label>Start</label><input type="datetime-local" value={startLocal} onChange={(e) => setStartLocal(e.target.value)} /></div>
        <div style={{ width: 120 }}><label>Late reg (min)</label><input type="number" value={lateReg} onChange={(e) => setLateReg(e.target.value)} /></div>
        <button style={{ alignSelf: "flex-end" }}>Create</button>
      </form>
      {err && <div className="err">{err}</div>}
    </div>
  );
}

function TournamentCard({ t, roster, reload, can }) {
  const canLive = can("tournaments.live");
  const canResults = can("results.enter");
  const [rows, setRows] = useState(
    t.players.map((p) => ({ player_id: p.player_id, name: p.name, entries: p.entries, reentries: p.reentries }))
  );
  const [pick, setPick] = useState("");
  const [finishes, setFinishes] = useState(
    Object.fromEntries(t.players.map((p) => [p.player_id, p.finish_position ?? ""]))
  );
  // Chop mode: enter payouts by hand (dollars) instead of computing from the structure.
  const [chop, setChop] = useState(!!t.payouts_manual);
  const [payouts, setPayouts] = useState(
    Object.fromEntries(t.players.map((p) => [p.player_id, p.payout_cents ? (p.payout_cents / 100).toString() : ""]))
  );
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const available = roster.filter((r) => !rows.some((x) => x.player_id === r.id));
  // Name already includes the screen name as "First [PokerStars name]".
  const PlayerCell = ({ name }) => <td>{name}</td>;
  const totalEntries = rows.reduce((s, r) => s + (+r.entries || 0) + (+r.reentries || 0), 0);
  const pool = rows.reduce((s, r) => s + ((+r.entries || 0) * t.buyin_cents + (+r.reentries || 0) * t.reentry_cents), 0);
  const paidCents = rows.reduce((s, r) => s + (chop
    ? Math.round((parseFloat(payouts[r.player_id]) || 0) * 100)
    : (t.players.find((p) => p.player_id === r.player_id)?.payout_cents || 0)), 0);

  function addPlayer() {
    if (!pick) return;
    const r = roster.find((x) => x.id === +pick);
    setRows([...rows, { player_id: r.id, name: r.name, entries: 1, reentries: 0 }]);
    setPick("");
  }
  function setRow(pid, key, val) { setRows(rows.map((r) => (r.player_id === pid ? { ...r, [key]: val } : r))); }
  function removeRow(pid) { setRows(rows.filter((r) => r.player_id !== pid)); }

  async function saveEntries() {
    setErr(""); setMsg("");
    try {
      await api.put(`/tournaments/${t.id}/players`, {
        players: rows.map((r) => ({ player_id: r.player_id, entries: +r.entries || 0, reentries: +r.reentries || 0 })),
      });
      setMsg("Entries saved."); reload();
    } catch (e) { setErr(e.message); }
  }
  async function saveResults() {
    setErr(""); setMsg("");
    try {
      const res = await api.put(`/tournaments/${t.id}/results`, {
        results: rows.map((r) => ({ player_id: r.player_id, finish_position: finishes[r.player_id] ? +finishes[r.player_id] : null })),
      });
      setMsg(res.warnings?.length ? "⚠ " + res.warnings.join(" ") : "Results saved (draft). Keep adding finishes as players bust; hit Complete when the paid places are in.");
      reload();
    } catch (e) { setErr(e.message); }
  }
  function setPayout(pid, val) { setPayouts((m) => ({ ...m, [pid]: val })); }
  // Split the pool evenly (whole dollars) among players who have a finish entered.
  function splitEvenly() {
    const choppers = rows.filter((r) => String(finishes[r.player_id] ?? "").trim() !== "");
    if (!choppers.length) { setErr("Mark the finishing positions of the players in the deal first, then Split evenly."); return; }
    const sorted = [...choppers].sort((a, b) => (+finishes[a.player_id]) - (+finishes[b.player_id]));
    const poolD = Math.round(pool / 100), n = sorted.length;
    const base = Math.floor(poolD / n), rem = poolD - base * n; // extra $1 to the best finishers
    const next = Object.fromEntries(rows.map((r) => [r.player_id, "0"]));
    sorted.forEach((r, i) => { next[r.player_id] = String(base + (i < rem ? 1 : 0)); });
    setPayouts(next); setErr("");
  }
  async function saveChop() {
    setErr(""); setMsg("");
    try {
      const res = await api.put(`/tournaments/${t.id}/payouts`, {
        players: rows.map((r) => ({
          player_id: r.player_id,
          finish_position: finishes[r.player_id] ? +finishes[r.player_id] : null,
          payout_cents: Math.round((parseFloat(payouts[r.player_id]) || 0) * 100),
        })),
      });
      setMsg(res.warnings?.length ? "⚠ " + res.warnings.join(" ") : "Chop payouts saved. Hit Complete to lock it in.");
      reload();
    } catch (e) { setErr(e.message); }
  }
  async function finalize() {
    setErr(""); setMsg("");
    try { await api.post(`/tournaments/${t.id}/finalize`); setMsg("Completed — ledger updated."); reload(); }
    catch (e) { setErr(e.message); }
  }
  async function setRego(open) {
    setErr("");
    try { await api.patch(`/tournaments/${t.id}`, { status: "live", rego_open: open }); reload(); }
    catch (e) { setErr(e.message); }
  }
  async function cancelTournament() {
    if (!confirm("Cancel this tournament? It will be removed along with any entries logged. This can't be undone.")) return;
    setErr("");
    try { await api.del(`/tournaments/${t.id}`); reload(); }
    catch (e) { setErr(e.message); }
  }

  const finalized = t.status === "finalized";

  function applyEntries(res) {
    setErr(""); setMsg("");
    const byId = new Map(rows.map((r) => [r.player_id, { ...r }]));
    const matched = (res.players || []).filter((p) => p.player_id);
    for (const p of matched) {
      const r = roster.find((x) => x.id === p.player_id);
      const row = byId.get(p.player_id) || (r ? { player_id: r.id, name: r.name, entries: 1, reentries: 0 } : null);
      if (!row) continue;
      row.entries = row.entries || 1;
      row.reentries = p.reentries ?? 0;
      byId.set(p.player_id, row);
    }
    setRows([...byId.values()]);
    const unmatched = (res.players || []).filter((p) => !p.player_id).map((p) => p.handle);
    const bits = [`Matched ${matched.length} player(s) with their re-entries.`];
    if (unmatched.length) bits.push(`⚠ Couldn't match: ${unmatched.join(", ")} — add manually.`);
    setMsg(bits.join(" ") + " Then Save entries.");
  }

  function applyResults(res) {
    setErr(""); setMsg("");
    const byId = new Map(rows.map((r) => [r.player_id, { ...r }]));
    const f = { ...finishes };
    const unmatched = [];
    for (const p of res.players || []) {
      if (!p.player_id) { unmatched.push(p.handle); continue; }
      const r = roster.find((x) => x.id === p.player_id);
      const row = byId.get(p.player_id) || (r ? { player_id: r.id, name: r.name, entries: 1, reentries: 0 } : null);
      if (!row) continue;
      row.entries = row.entries || 1;
      if (p.reentries != null) row.reentries = p.reentries;
      byId.set(p.player_id, row);
      if (p.finish_position) f[p.player_id] = p.finish_position;
    }
    setRows([...byId.values()]);
    setFinishes(f);
    setMsg(`Prefilled players, re-entries & finishes from the results${unmatched.length ? ` — ⚠ unmatched: ${unmatched.join(", ")}` : ""}. Review, then Save entries, then Save results.`);
  }

  return (
    <div className="card">
      <div className="row" style={{ flexWrap: "wrap" }}>
        <strong>{t.game_type || "Tournament"}</strong>
        <span className="badge gray">{t.tournament_type}</span>
        <span className="muted">
          {fmt(t.buyin_cents)} buy-in · Re-entry {fmt(t.reentry_cents)} · {fmtDate(t.played_on)}
          {t.starts_at ? ` · Starts ${fmtDateTime(t.starts_at)}` : ""}
          {t.late_reg_minutes != null ? ` · Late reg ${t.late_reg_minutes}m` : ""}
        </span>
        <span className="right">
          {phaseOf(t) ? <LifePill phase={phaseOf(t)} /> : <span className="badge gray">draft</span>}
        </span>
      </div>

      <div className="row" style={{ margin: "12px 0", gap: 18, alignItems: "center" }}>
        <span className="muted">Total entries <strong>{totalEntries}</strong></span>
        <span className="muted">Pool <strong>{fmt(pool)}</strong></span>
        {!finalized && (
          <span className="right row" style={{ gap: 8 }}>
            {canLive && t.status === "draft" && <button className="small ghost" onClick={() => setRego(true)}>Go live</button>}
            {canLive && t.status === "live" && t.rego_open && <button className="small ghost" onClick={() => setRego(false)}>Close rego</button>}
            {canLive && t.status === "live" && !t.rego_open && <button className="small ghost" onClick={() => setRego(true)}>Re-open rego</button>}
            {can("nights.manage") && <button className="small ghost danger" onClick={cancelTournament} title="Delete this tournament">Cancel</button>}
          </span>
        )}
      </div>

      {!finalized && (
        <table>
          <thead><tr><th>Player</th><th className="num">Entries</th><th className="num">Re-entries</th><th className="num">Invested</th><th className="num">Finish</th><th className="num">Payout</th><th></th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const inv = (+r.entries || 0) * t.buyin_cents + (+r.reentries || 0) * t.reentry_cents;
              const saved = t.players.find((p) => p.player_id === r.player_id);
              return (
                <tr key={r.player_id}>
                  <PlayerCell pid={r.player_id} name={r.name} />
                  <td className="num" style={{ width: 90 }}><input type="number" value={r.entries} onChange={(e) => setRow(r.player_id, "entries", e.target.value)} /></td>
                  <td className="num" style={{ width: 90 }}><input type="number" value={r.reentries} onChange={(e) => setRow(r.player_id, "reentries", e.target.value)} /></td>
                  <td className="num">{fmt(inv)}</td>
                  <td className="num" style={{ width: 80 }}><input type="number" value={finishes[r.player_id] ?? ""} onChange={(e) => setFinishes({ ...finishes, [r.player_id]: e.target.value })} /></td>
                  <td className="num" style={{ width: 110 }}>
                    {chop
                      ? <input type="number" placeholder="$" value={payouts[r.player_id] ?? ""} onChange={(e) => setPayout(r.player_id, e.target.value)} style={{ width: 90 }} />
                      : <span className="pos">{saved?.payout_cents ? fmt(saved.payout_cents) : "—"}</span>}
                  </td>
                  <td className="num"><button className="small ghost" onClick={() => removeRow(r.player_id)}>✕</button></td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={7} className="muted">No players yet.</td></tr>}
          </tbody>
        </table>
      )}

      {finalized && (
        <table>
          <thead><tr><th>Player</th><th className="num">Finish</th><th className="num">Invested</th><th className="num">Payout</th><th className="num">Net</th></tr></thead>
          <tbody>
            {t.players.map((p) => (
              <tr key={p.player_id}>
                <PlayerCell pid={p.player_id} name={p.name} />
                <td className="num">{p.finish_position ?? "—"}</td>
                <td className="num">{fmt(p.invested_cents)}</td>
                <td className="num pos">{fmt(p.payout_cents)}</td>
                <td className={"num " + (p.payout_cents - p.invested_cents >= 0 ? "pos" : "neg")}>{fmt(p.payout_cents - p.invested_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!finalized && (canLive || canResults) && (
        <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
          {canLive && <>
            <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ width: 200 }}>
              <option value="">Add player…</option>
              {available.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <button className="ghost small" onClick={addPlayer} disabled={!pick}>Add</button>
            <ScreenshotButton kind="entries" tournamentId={t.id} label="📷 Upload entries (end of rego)" onResult={applyEntries} />
          </>}
          {canResults && <ScreenshotButton kind="results" tournamentId={t.id} label="📷 Upload results" onResult={applyResults} />}
          {canResults && (
            <button className="small ghost" onClick={() => setChop((v) => !v)}
              style={chop ? { borderColor: "var(--gold)", color: "var(--gold)" } : undefined}
              title="Players cut a deal? Turn on to enter payouts by hand.">
              {chop ? "🤝 Chop: on" : "🤝 Chop"}
            </button>
          )}
          {canResults && chop && (
            <button className="small ghost" onClick={splitEvenly}
              title="Split the pool evenly among the players who have a finishing position entered">Split evenly</button>
          )}
          {canResults && chop && (
            <span className={"badge " + (paidCents === pool ? "ok" : "live")} style={{ alignSelf: "center" }}>
              Payouts {fmt(paidCents)} / Pool {fmt(pool)}
            </span>
          )}
          <div className="right row">
            {canLive && <button className="small" onClick={saveEntries}>Save entries</button>}
            {canResults && (chop
              ? <button className="small" onClick={saveChop}>Save chop</button>
              : <button className="small" onClick={saveResults}>Save results</button>)}
            {canResults && <button className="small pos" onClick={finalize} disabled={t.status !== "reconciled"} title={t.status !== "reconciled" ? "Save results first" : "Write payouts to the ledger and lock the tournament"}>Complete</button>}
          </div>
        </div>
      )}

      {msg && <div className="sub" style={{ marginTop: 8, color: "var(--amber)" }}>{msg}</div>}
      {err && <div className="err">{err}</div>}
    </div>
  );
}

import { useEffect, useState } from "react";
import { api, fmtDateTime, timeAgo } from "../api";

const ORD = ["1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th"];
const sumPct = (places) => places.reduce((s, p) => s + (Number(p) || 0), 0);

// Who's logged in + last login. Polls so "online" stays fresh.
function Activity() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");
  const [, tick] = useState(0); // force re-render so relative times update
  function load() { api.get("/activity").then(setRows).catch((e) => setErr(e.message)); }
  useEffect(() => {
    load();
    const p = setInterval(load, 20000);              // refresh data
    const r = setInterval(() => tick((n) => n + 1), 30000); // refresh "x min ago"
    return () => { clearInterval(p); clearInterval(r); };
  }, []);
  if (err) return <div className="err">{err}</div>;
  if (!rows) return <p className="muted">Loading…</p>;
  const online = rows.filter((r) => r.online).length;
  return (
    <div className="card">
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        <h2 style={{ margin: 0 }}>Login activity</h2>
        <span className="right badge ok">{online} online now</span>
      </div>
      <p className="sub" style={{ margin: "6px 0 12px" }}>Green = active in the last few minutes. Updates automatically.</p>
      <table>
        <thead><tr><th>Player</th><th className="ctr">Status</th><th className="ctr">Last seen</th><th className="ctr">Last login</th></tr></thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}>
              <td>{p.name}<div className="muted" style={{ fontSize: 12 }}>{p.username}</div></td>
              <td className="ctr">{p.online
                ? <span className="badge ok">● online</span>
                : <span className="badge gray">offline</span>}</td>
              <td className="ctr muted">{timeAgo(p.last_seen_at)}</td>
              <td className="ctr muted">{p.last_login_at ? fmtDateTime(p.last_login_at) : "never"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Settings() {
  const [tiers, setTiers] = useState(null);   // [{min, max(''|num), places:[num...]}]
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [alloc, setAlloc] = useState("");     // ClubGG allocation (dollars)
  const [allocBusy, setAllocBusy] = useState(false);
  const [tab, setTab] = useState("config");   // "config" | "activity"

  useEffect(() => {
    api.get("/payout-structure").then((s) => {
      const p = s?.payload;
      setTiers((p?.tiers || []).map((t) => ({ min: t.min, max: t.max ?? "", places: [...t.places] })));
    }).catch((e) => setErr(e.message));
    api.get("/settings/clubgg-allocation").then((r) => setAlloc((r.allocation_cents / 100).toString())).catch(() => {});
  }, []);

  async function saveAlloc() {
    setErr(""); setMsg(""); setAllocBusy(true);
    try {
      const r = await api.put("/settings/clubgg-allocation", { allocation_cents: Math.round((parseFloat(alloc) || 0) * 100) });
      setAlloc((r.allocation_cents / 100).toString());
      setMsg("ClubGG allocation saved. Applies from the next weekly re-allocation.");
      setTimeout(() => setMsg(""), 6000);
    } catch (e) { setErr(e.message); } finally { setAllocBusy(false); }
  }

  function setTier(i, patch) { setTiers((ts) => ts.map((t, j) => (j === i ? { ...t, ...patch } : t))); }
  function setPlace(i, k, val) { setTiers((ts) => ts.map((t, j) => j === i ? { ...t, places: t.places.map((p, m) => (m === k ? val : p)) } : t)); }
  function addPlace(i) { setTiers((ts) => ts.map((t, j) => (j === i ? { ...t, places: [...t.places, 0] } : t))); }
  function removePlace(i) { setTiers((ts) => ts.map((t, j) => (j === i && t.places.length > 1 ? { ...t, places: t.places.slice(0, -1) } : t))); }
  function addTier() { setTiers((ts) => [...ts, { min: "", max: "", places: [100] }]); }
  function removeTier(i) { setTiers((ts) => ts.filter((_, j) => j !== i)); }

  async function save() {
    setErr(""); setMsg(""); setBusy(true);
    try {
      const body = {
        tiers: tiers.map((t) => ({
          min: Number(t.min),
          max: t.max === "" || t.max === null ? null : Number(t.max),
          places: t.places.map((p) => Number(p)),
        })),
      };
      const res = await api.put("/payout-structure", body);
      const p = res.payload;
      setTiers(p.tiers.map((t) => ({ min: t.min, max: t.max ?? "", places: [...t.places] })));
      setMsg("Payout structure saved. It applies to tournaments finalized from now on.");
      setTimeout(() => setMsg(""), 6000);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  const allValid = tiers ? tiers.every((t) => Math.round(sumPct(t.places) * 100) === 10000) : false;

  return (
    <>
      <h1>Settings</h1>
      <div className="row" style={{ gap: 6, marginBottom: 16 }}>
        <button className={"chip" + (tab === "config" ? " on" : "")} onClick={() => setTab("config")}>Payout structure</button>
        <button className={"chip" + (tab === "activity" ? " on" : "")} onClick={() => setTab("activity")}>Activity</button>
      </div>

      {tab === "activity" && <Activity />}
      {tab === "config" && !tiers && <p className="muted">{err || "Loading…"}</p>}
      {tab === "config" && tiers && (
      <>
      <div className="card">
        <h2>Payout structure</h2>
        <p className="sub" style={{ marginTop: 4 }}>
          How each tournament's prize pool splits, by field size (total entries incl. re-entries).
          Each place is paid its exact percentage to the cent; the winner absorbs the sub-cent
          remainder so payouts always sum exactly to the pool.
        </p>

        {tiers.map((t, i) => {
          const s = sumPct(t.places);
          const ok = Math.round(s * 100) === 10000;
          return (
            <div key={i} className="card" style={{ background: "var(--surface-2)", marginTop: 12 }}>
              <div className="row" style={{ alignItems: "flex-end", gap: 10, flexWrap: "wrap" }}>
                <div style={{ width: 90 }}><label>From</label>
                  <input type="number" min="1" value={t.min} onChange={(e) => setTier(i, { min: e.target.value })} /></div>
                <div style={{ width: 110 }}><label>To (blank = +)</label>
                  <input type="number" min="1" placeholder="+" value={t.max} onChange={(e) => setTier(i, { max: e.target.value })} /></div>
                <div className="right">
                  <button className="ghost small" onClick={() => removeTier(i)} title="Remove tier">Remove tier</button>
                </div>
              </div>

              <div className="row" style={{ gap: 10, marginTop: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
                {t.places.map((p, k) => (
                  <div key={k} style={{ width: 84 }}>
                    <label>{ORD[k] || `#${k + 1}`} %</label>
                    <input type="number" min="0" value={p} onChange={(e) => setPlace(i, k, e.target.value)} />
                  </div>
                ))}
                <div className="row" style={{ gap: 6 }}>
                  <button className="ghost small" onClick={() => addPlace(i)}>+ place</button>
                  <button className="ghost small" onClick={() => removePlace(i)} disabled={t.places.length <= 1}>− place</button>
                </div>
                <span className={"badge " + (ok ? "ok" : "live")} style={{ marginLeft: "auto" }}>
                  {t.places.length} paid · sums to {s}%
                </span>
              </div>
            </div>
          );
        })}

        <div className="row" style={{ marginTop: 12, gap: 10 }}>
          <button className="ghost small" onClick={addTier}>+ Add tier</button>
          <span className="right">
            <button onClick={save} disabled={busy || !allValid} title={allValid ? "" : "Every tier must sum to 100%"}>
              {busy ? "Saving…" : "Save structure"}
            </button>
          </span>
        </div>

        {err && <div className="err">{err}</div>}
        {msg && <div className="sub" style={{ color: "var(--pos)", marginTop: 8 }}>{msg}</div>}
      </div>

      <div className="card">
        <h2>ClubGG weekly allocation</h2>
        <p className="sub" style={{ marginTop: 4 }}>
          Chips (real $) allocated to each player every Monday. Sunday's finishing stack minus this,
          plus rebated rake, is their ClubGG result for the week's settlement.
        </p>
        <div className="row" style={{ margin: "14px 0 4px", alignItems: "flex-end", gap: 12 }}>
          <div style={{ width: 220 }}>
            <label>Allocation per player ($)</label>
            <input type="number" min="0" step="50" value={alloc} onChange={(e) => setAlloc(e.target.value)} />
          </div>
          <button onClick={saveAlloc} disabled={allocBusy}>{allocBusy ? "Saving…" : "Save allocation"}</button>
        </div>
      </div>
      </>
      )}
    </>
  );
}

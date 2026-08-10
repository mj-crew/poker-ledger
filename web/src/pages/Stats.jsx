import { useEffect, useState } from "react";
import { api, fmt, fmtDate } from "../api";

// Local YYYY-MM-DD (not UTC, so "today" matches the player's calendar).
const iso = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};
function presetRange(key) {
  const now = new Date(), today = iso(now);
  if (key === "year") return { from: `${now.getFullYear()}-01-01`, to: today };
  if (key === "month") return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: today };
  if (key === "week") {
    const day = now.getDay(), mon = new Date(now);
    mon.setDate(now.getDate() + (day === 0 ? -6 : 1 - day));
    return { from: iso(mon), to: today };
  }
  if (key === "30") {
    const d = new Date(now); d.setDate(now.getDate() - 29);
    return { from: iso(d), to: today };
  }
  return { from: "", to: "" }; // all time
}
const PRESETS = [["all", "All time"], ["year", "This year"], ["month", "This month"], ["week", "This week"], ["30", "Last 30 days"]];

function Tile({ label, value, sub, tone }) {
  return (
    <div className="tile">
      <span className="lbl">{label}</span>
      <div className={"tval " + (tone || "")}>{value}</div>
      {sub && <span className="sub">{sub}</span>}
    </div>
  );
}

export default function Stats() {
  const [preset, setPreset] = useState("all");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [s, setS] = useState(null);
  const [err, setErr] = useState("");

  const usingCustom = preset === "custom";
  const range = usingCustom ? custom : presetRange(preset);

  useEffect(() => {
    const qs = [];
    if (range.from) qs.push(`from=${range.from}`);
    if (range.to) qs.push(`to=${range.to}`);
    api.get("/account/stats" + (qs.length ? "?" + qs.join("&") : ""))
      .then(setS).catch((e) => setErr(e.message));
  }, [range.from, range.to]); // eslint-disable-line react-hooks/exhaustive-deps

  const roi = s && s.invested_cents > 0 ? (s.net_cents / s.invested_cents) * 100 : null;
  const cashRate = s && s.tournaments > 0 ? (s.cashes / s.tournaments) * 100 : null;
  const netTone = s ? (s.net_cents > 0 ? "pos" : s.net_cents < 0 ? "neg" : "") : "";

  return (
    <>
      <h1>Stats</h1>
      <div className="card">
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          <span className="sub" style={{ margin: 0 }}>Your performance across finalized tournaments.</span>
          <span className="right" style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
            {PRESETS.map(([k, lbl]) => (
              <button key={k} className={"chip" + (preset === k ? " on" : "")} onClick={() => setPreset(k)}>{lbl}</button>
            ))}
            <button className={"chip" + (usingCustom ? " on" : "")} onClick={() => setPreset("custom")}>Custom</button>
          </span>
        </div>

        {usingCustom && (
          <div className="row" style={{ gap: 10, margin: "12px 0 2px", flexWrap: "wrap" }}>
            <div><label>From</label><input type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} /></div>
            <div><label>To</label><input type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} /></div>
          </div>
        )}

        {err && <div className="err">{err}</div>}
        {!s ? <p className="muted" style={{ margin: "12px 0 0" }}>Loading…</p> : s.tournaments === 0 ? (
          <p className="muted" style={{ margin: "12px 0 0" }}>No tournaments in this period.</p>
        ) : (
          <>
            <div className="tiles" style={{ marginTop: 14 }}>
              <Tile label="Net P&L" value={fmt(s.net_cents)} tone={netTone} sub={`${s.tournaments} tournament${s.tournaments === 1 ? "" : "s"}`} />
              <Tile label="ROI" value={roi === null ? "—" : `${roi >= 0 ? "+" : ""}${roi.toFixed(1)}%`} tone={netTone} sub="return on buy-ins" />
              <Tile label="Cash rate" value={cashRate === null ? "—" : `${cashRate.toFixed(0)}%`} sub={`in the money ${s.cashes}/${s.tournaments}`} />
              <Tile label="Total buy-ins" value={fmt(s.invested_cents)} sub={`${s.entries} entr${s.entries === 1 ? "y" : "ies"} incl. re-entries`} />
              <Tile label="Total won" value={fmt(s.won_cents)} />
              <Tile label="Biggest cash" value={fmt(s.biggest_cash_cents)} />
              <Tile label="Best result" value={fmt(s.best_net_cents)} tone={s.best_net_cents > 0 ? "pos" : ""} sub="single tournament" />
              <Tile label="Avg buy-in" value={s.entries > 0 ? fmt(Math.round(s.invested_cents / s.entries)) : "—"} />
            </div>
            {s.first_played && (
              <p className="sub" style={{ marginTop: 12 }}>{fmtDate(s.first_played)} → {fmtDate(s.last_played)}</p>
            )}
          </>
        )}
      </div>
    </>
  );
}

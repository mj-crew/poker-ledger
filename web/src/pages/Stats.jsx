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
const tone = (c) => (c > 0 ? "pos" : c < 0 ? "neg" : "");
const pctS = (v, dp = 1) => `${v >= 0 ? "+" : ""}${v.toFixed(dp)}%`;

// Shared tile set for a tournament block (PokerStars or ClubGG — same metrics).
function TournamentTiles({ s }) {
  const roi = s.invested_cents > 0 ? (s.net_cents / s.invested_cents) * 100 : null;
  const cashRate = s.tournaments > 0 ? (s.cashes / s.tournaments) * 100 : null;
  return (
    <div className="tiles" style={{ marginTop: 14 }}>
      <Tile label="Net P&L" value={fmt(s.net_cents)} tone={tone(s.net_cents)} sub={`${s.tournaments} tournament${s.tournaments === 1 ? "" : "s"}`} />
      <Tile label="ROI" value={roi === null ? "—" : pctS(roi)} tone={tone(s.net_cents)} sub="return on buy-ins" />
      <Tile label="Cash rate" value={cashRate === null ? "—" : `${cashRate.toFixed(0)}%`} sub={`in the money ${s.cashes}/${s.tournaments}`} />
      <Tile label="Total buy-ins" value={fmt(s.invested_cents)} sub={`${s.entries} entr${s.entries === 1 ? "y" : "ies"} incl. re-entries`} />
      <Tile label="Total won" value={fmt(s.won_cents)} />
      <Tile label="Biggest cash" value={fmt(s.biggest_cash_cents)} />
      <Tile label="Best result" value={fmt(s.best_net_cents)} tone={s.best_net_cents > 0 ? "pos" : ""} sub="single tournament" />
      <Tile label="Avg buy-in" value={s.entries > 0 ? fmt(Math.round(s.invested_cents / s.entries)) : "—"} />
    </div>
  );
}

// Per-game breakdown under the ClubGG sections (you play mixed games) — same
// tile treatment as the stat cards above it.
function ByGame({ rows, unit }) {
  if (!rows?.length) return null;
  return (
    <>
      <p className="sub" style={{ margin: "16px 0 8px" }}>By game</p>
      <div className="tiles">
        {rows.map((g, i) => (
          <Tile key={g.game_type || i} label={g.game_type || "?"} value={fmt(g.net_cents)}
            tone={tone(g.net_cents)} sub={g[unit]} />
        ))}
      </div>
    </>
  );
}

function Section({ title, badge, note, empty, children }) {
  return (
    <div className="card">
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        <h2 style={{ margin: 0 }}>{title}</h2>
        {badge && <span className="sub gold" style={{ margin: 0 }}>{badge}</span>}
      </div>
      {note && <p className="sub" style={{ margin: "4px 0 0" }}>{note}</p>}
      {empty ? <p className="muted" style={{ margin: "12px 0 0" }}>Nothing in this period.</p> : children}
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

  const gt = s?.gg_mtt, gc = s?.gg_cash;
  // Combined view across everything the club plays.
  const comb = s && {
    net: s.net_cents + (gt?.net_cents ?? 0) + (gc?.net_cents ?? 0),
    tNet: s.net_cents + (gt?.net_cents ?? 0),
    tCount: s.tournaments + (gt?.tournaments ?? 0),
    tInvested: s.invested_cents + (gt?.invested_cents ?? 0),
    tCashes: s.cashes + (gt?.cashes ?? 0),
  };
  const combRoi = comb && comb.tInvested > 0 ? (comb.tNet / comb.tInvested) * 100 : null;
  const combCashRate = comb && comb.tCount > 0 ? (comb.tCashes / comb.tCount) * 100 : null;
  const bb100 = gc && gc.hands > 0 ? (gc.bb_won / gc.hands) * 100 : null;

  return (
    <>
      <h1>My Stats</h1>
      <div className="card">
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          <span className="sub" style={{ margin: 0 }}>Your performance across both platforms.</span>
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
        {!s ? <p className="muted" style={{ margin: "12px 0 0" }}>Loading…</p> : (
          <div className="tiles" style={{ marginTop: 14 }}>
            <Tile label="Net P&L — everything" value={fmt(comb.net)} tone={tone(comb.net)} sub="tournaments + cash, both platforms" />
            <Tile label="Tournament P&L" value={fmt(comb.tNet)} tone={tone(comb.tNet)} sub={`PokerStars + ClubGG · ${comb.tCount} played`} />
            <Tile label="Cash game P&L" value={fmt(gc?.net_cents ?? 0)} tone={tone(gc?.net_cents ?? 0)} sub="ClubGG ring games" />
            <Tile label="Tournament ROI" value={combRoi === null ? "—" : pctS(combRoi)} tone={tone(comb.tNet)} sub="both platforms" />
            <Tile label="Cash rate" value={combCashRate === null ? "—" : `${combCashRate.toFixed(0)}%`} sub={`in the money ${comb.tCashes}/${comb.tCount}`} />
            <Tile label="Total invested" value={fmt(comb.tInvested + (gc?.buyin_cents ?? 0))} sub="buy-ins, all games" />
          </div>
        )}
      </div>

      {s && (
        <>
          <Section title="PokerStars — Tournaments" badge="♠ PokerStars" empty={s.tournaments === 0}>
            <TournamentTiles s={s} />
            {s.first_played && <p className="sub" style={{ marginTop: 12 }}>{fmtDate(s.first_played)} → {fmtDate(s.last_played)}</p>}
          </Section>

          <Section title="ClubGG — Tournaments" badge="♣ ClubGG"
            note="Prizes shown as paid by the house payout structure (positions from ClubGG, payouts re-computed — same split as PokerStars)."
            empty={!gt || gt.tournaments === 0}>
            {gt && (
              <>
                <TournamentTiles s={gt} />
                <ByGame rows={gt.by_game?.map((g) => ({ ...g, count: `${g.tournaments}×` }))} unit="count" />
                {gt.first_played && <p className="sub" style={{ marginTop: 4 }}>{fmtDate(gt.first_played)} → {fmtDate(gt.last_played)}</p>}
              </>
            )}
          </Section>

          <Section title="ClubGG — Cash games" badge="♣ ClubGG" empty={!gc || gc.sessions === 0}>
            {gc && (
              <>
                <div className="tiles" style={{ marginTop: 14 }}>
                  <Tile label="Net P&L" value={fmt(gc.net_cents)} tone={tone(gc.net_cents)} sub={`${gc.sessions} session${gc.sessions === 1 ? "" : "s"}`} />
                  <Tile label="Win rate" value={bb100 === null ? "—" : `${bb100 >= 0 ? "+" : ""}${bb100.toFixed(1)}`} tone={tone(gc.net_cents)} sub="bb / 100 hands" />
                  <Tile label="Hands played" value={gc.hands.toLocaleString()} />
                  <Tile label="Total buy-in" value={fmt(gc.buyin_cents)} sub="table volume" />
                  <Tile label="Rake paid" value={fmt(gc.rake_cents)} />
                  <Tile label="Best session" value={fmt(gc.best_cents)} tone={gc.best_cents > 0 ? "pos" : ""} />
                  <Tile label="Worst session" value={fmt(gc.worst_cents)} tone={gc.worst_cents < 0 ? "neg" : ""} />
                  <Tile label="Avg per session" value={gc.sessions > 0 ? fmt(Math.round(gc.net_cents / gc.sessions)) : "—"} />
                </div>
                <ByGame rows={gc.by_game?.map((g) => ({ ...g, count: `${g.hands} hands` }))} unit="count" />
                {gc.first_played && <p className="sub" style={{ marginTop: 4 }}>{fmtDate(gc.first_played)} → {fmtDate(gc.last_played)}</p>}
              </>
            )}
          </Section>
        </>
      )}
    </>
  );
}

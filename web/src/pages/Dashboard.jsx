import { useEffect, useState, useRef } from "react";
import { api, fmt, runningWeekLabel, runningWeekBounds, transferStatus } from "../api";
import TournamentStatus from "../components/TournamentStatus.jsx";

const toLocal = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s)); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(s); };

// Weekly rake collected (allocated chips − chips in play) minus this week's expenses.
function RakeSummary({ period }) {
  const [rake, setRake] = useState(null);
  const [expWk, setExpWk] = useState(0);
  useEffect(() => {
    api.get("/clubgg/rake").then(setRake).catch(() => {});
    api.get("/expenses").then((rows) => {
      const { start, end } = runningWeekBounds(period);
      setExpWk(rows.filter((x) => x.status === "approved" && (() => { const d = toLocal(x.played_on); return d >= start && d <= end; })()).reduce((s, x) => s + x.amount_cents, 0));
    }).catch(() => {});
  }, [period]);
  if (!rake) return null;
  const net = rake.rake_cents - expWk;
  return (
    <div className="card">
      <h2 style={{ margin: 0 }}>Weekly rake collected</h2>
      <p className="sub" style={{ margin: "4px 0 12px" }}>Rake = allocated chips − chips in play. Expenses come out of it.</p>
      <div className="tiles">
        <div className="tile"><span className="lbl">Rake collected</span><div className="tval">{fmt(rake.rake_cents)}</div></div>
        <div className="tile"><span className="lbl">Expenses</span><div className="tval">{fmt(expWk)}</div></div>
        <div className="tile"><span className="lbl">Net rake</span><div className={"tval " + (net < 0 ? "neg" : "pos")}>{fmt(net)}</div></div>
      </div>
    </div>
  );
}

const PLACE = ["1st", "2nd", "3rd", "4th", "5th"];

// Bright green ✓ when done, bright red ✗ when still outstanding.
const Mark = ({ on }) => <span className={on ? "tick" : "cross"}>{on ? "✓" : "✗"}</span>;

function paysLabel(t) {
  if (!t.places?.length) return <span className="muted">—</span>;
  return t.places.map((p, i) => (
    <span key={p.place}>
      {i > 0 && <span className="muted"> · </span>}
      <span className="muted">{PLACE[p.place - 1]} </span>
      <span className="prize">{fmt(p.amount_cents)}</span>
    </span>
  ));
}

function LobbyTable({ rows, now }) {
  return (
    <table className="lobby fixed">
      <colgroup>
        <col style={{ width: "30%" }} /><col style={{ width: "10%" }} /><col style={{ width: "10%" }} />
        <col style={{ width: "11%" }} /><col style={{ width: "17%" }} /><col style={{ width: "22%" }} />
      </colgroup>
      <thead>
        <tr><th className="ctr">Event</th><th className="ctr">Buy-in</th><th className="ctr">Entries</th><th className="ctr">Prize pool</th><th className="ctr">Payouts</th><th className="ctr">Status</th></tr>
      </thead>
      <tbody>
        {rows.map((t) => (
          <tr key={t.id}>
            <td><div className={"evt " + t.phase}>{t.game_type || "Tournament"} · {t.tournament_type}</div></td>
            <td className="ctr">{fmt(t.buyin_cents)}</td>
            <td className="ctr"><span className="players-badge">{t.entries}</span></td>
            <td className="ctr prize">{fmt(t.pool_cents)}</td>
            <td className="ctr">{paysLabel(t)}</td>
            <td className="ctr"><TournamentStatus t={t} now={now} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function Dashboard() {
  const [live, setLive] = useState({ tournaments: [] });
  const [standings, setStandings] = useState([]);
  const [period, setPeriod] = useState(null);
  const [now, setNow] = useState(Date.now());
  const timer = useRef();

  const [runWeek, setRunWeek] = useState(null); // server's running week (advances only on reset)
  async function load() {
    try {
      const [l, s, ps, rw] = await Promise.all([api.get("/live"), api.get("/standings"), api.get("/settlement/periods"), api.get("/settlement/running-week")]);
      setLive(l); setStandings(s); setRunWeek(rw);
      setPeriod(ps[0] ? await api.get(`/settlement/periods/${ps[0].id}`) : null);
    } catch { /* transient */ }
  }
  useEffect(() => {
    load();
    timer.current = setInterval(load, 4000);
    const tick = setInterval(() => setNow(Date.now()), 1000); // drives countdowns
    return () => { clearInterval(timer.current); clearInterval(tick); };
  }, []);

  const inPlay = live.tournaments.filter((t) => t.phase !== "completed");
  const done = live.tournaments.filter((t) => t.phase === "completed");

  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <div>
          <h1>Dashboard</h1>
        </div>
        {inPlay.length > 0 && <span className="right pill badge live"><span className="dot" /> {inPlay.length} in play</span>}
      </div>

      <div className="card">
        <h2>Currently running</h2>
        {inPlay.length === 0 ? <p className="muted">No tournaments running right now.</p> : <LobbyTable rows={inPlay} now={now} />}
      </div>

      {done.length > 0 && (
        <div className="card">
          <h2>Completed tonight</h2>
          <LobbyTable rows={done} now={now} />
          <p className="sub" style={{ marginTop: 10 }}>Full history is on the <a href="/results">Results</a> tab.</p>
        </div>
      )}

      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Weekly running balance</h2>
          <span className="right sub gold">Week {runningWeekLabel(runWeek ?? period)}</span>
        </div>
        <table className="fixed">
          <colgroup><col style={{ width: "70%" }} /><col style={{ width: "30%" }} /></colgroup>
          <thead><tr><th>Player</th><th className="num">Balance</th></tr></thead>
          <tbody>
            {standings.map((s) => (
              <tr key={s.player_id}>
                <td>{s.name}</td>
                <td className={"num " + (s.balance_cents > 0 ? "pos" : s.balance_cents < 0 ? "neg" : "")}>
                  {fmt(s.balance_cents)}
                </td>
              </tr>
            ))}
            {standings.length === 0 && <tr><td colSpan={2} className="muted">No results yet.</td></tr>}
          </tbody>
        </table>
        <p className="sub" style={{ marginTop: 10 }}>Tournaments + ClubGG combined. Positive = owed to you · Negative = you owe. Settled weekly.</p>
      </div>

      <RakeSummary period={runWeek ?? period} />

      {period?.transfers?.length > 0 && (
        <div className="card">
          <div className="row" style={{ flexWrap: "wrap", gap: 8, marginBottom: 4 }}>
            <h2 style={{ margin: 0 }}>Who pays whom</h2>
            {period.status === "settled"
              ? <span className="badge ok">settled ✓</span>
              : <span className="badge pend">
                  {period.transfers.filter((t) => t.status === "confirmed").length}/{period.transfers.length} confirmed
                </span>}
            <span className="right sub gold">{period.label || `Period #${period.id}`}</span>
          </div>
          <table>
            <thead><tr><th>Payer</th><th>Pays</th><th className="ctr">Amount</th><th className="ctr">Payer marked paid</th><th className="ctr">Receiver confirmed</th><th className="ctr">Status</th></tr></thead>
            <tbody>
              {period.transfers.map((t) => {
                const st = transferStatus(t);
                return (
                <tr key={t.id}>
                  <td>{t.from_name}</td><td>{t.to_name}</td>
                  <td className="ctr">{fmt(t.amount_cents)}</td>
                  <td className="ctr"><Mark on={!!t.payer_marked_at} /></td>
                  <td className="ctr"><Mark on={!!t.receiver_confirmed_at} /></td>
                  <td className="ctr"><span className={"badge " + st.cls}>{st.text}</span></td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

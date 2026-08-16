import { useEffect, useState } from "react";
import { api, fmt, fmtDate, fmtDateTime, transferStatus } from "../api";
import { useAuth } from "../auth.jsx";

function StatusBadge({ t }) {
  const st = transferStatus(t);
  return <span className={"badge " + st.cls}>{st.text}</span>;
}

// Receiver name + a button that reveals their PayID (the number you pay to).
function PayTo({ name, payid }) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <div>{name}</div>
      {payid
        ? (show
            ? <button className="linkbtn" onClick={() => setShow(false)}><strong style={{ color: "var(--gold)" }}>PayID {payid}</strong> · hide</button>
            : <button className="linkbtn" onClick={() => setShow(true)}>💳 Show PayID</button>)
        : <span className="muted" style={{ fontSize: 12 }}>no PayID on file</span>}
    </div>
  );
}

// Loads a brand logo from /public; falls back to a coloured suit glyph if absent.
function BrandIcon({ src, glyph, color, size = 20 }) {
  const [ok, setOk] = useState(true);
  return ok
    ? <img src={src} alt="" onError={() => setOk(false)} style={{ height: size, width: "auto", maxWidth: size * 2.4, objectFit: "contain" }} />
    : <span style={{ color, fontSize: size * 0.85, lineHeight: 1 }}>{glyph}</span>;
}
const tone = (c) => (c > 0 ? "pos" : c < 0 ? "neg" : "");

// One row of the recap breakdown: label left, value right.
function RecapLine({ label, value, cls, strong }) {
  return (
    <div className="recapline">
      <span className={"sub" + (strong ? " strong" : "")} style={{ margin: 0 }}>{label}</span>
      <span className={"num " + (cls || "")} style={{ fontWeight: strong ? 800 : 600 }}>{value}</span>
    </div>
  );
}

// One locked/settled week: your settlement line (frozen at lock), your
// transfers, and the week's transactions. Latest week starts open.
function WeekRecap({ w, me, open }) {
  const r = w.recap;
  const netRakeBack = r ? r.rake_cents - r.expense_share_cents + r.expense_claimed_cents : 0;
  const label = w.label || (w.starts_on ? `${fmtDate(w.starts_on)} - ${fmtDate(w.ends_on)}` : `Week #${w.id}`);
  return (
    <details className="recap" open={open}>
      <summary>
        <span className="gold" style={{ fontWeight: 700 }}>Week {label}</span>
        <span className={"badge " + (w.status === "settled" ? "ok" : "pend")}>{w.status}</span>
        {r && <span className={"right num " + tone(r.total_cents)} style={{ fontWeight: 800 }}>{fmt(r.total_cents)}</span>}
      </summary>

      {r ? (
        <div className="recapgrid">
          <div>
            <p className="sub" style={{ margin: "0 0 6px", fontWeight: 700 }}>ClubGG</p>
            <RecapLine label="Weekly allocation" value={fmt(r.allocation_cents)} />
            <RecapLine label="End of week balance" value={r.finishing_cents != null ? fmt(r.finishing_cents) : "— (no movement)"} />
            <RecapLine label="Full rake contribution" value={fmt(r.rake_cents)} />
            {r.expense_share_cents > 0 && <RecapLine label="Prorata weekly expenses" value={"−" + fmt(r.expense_share_cents)} cls="neg" />}
            {r.expense_claimed_cents > 0 && <RecapLine label="Expenses reimbursed to you" value={fmt(r.expense_claimed_cents)} cls="pos" />}
            <RecapLine label="Net rake back" value={fmt(netRakeBack)} cls={tone(netRakeBack)} />
            <RecapLine label="ClubGG net" value={fmt(r.clubgg_net_cents)} cls={tone(r.clubgg_net_cents)} strong />
          </div>
          <div>
            <p className="sub" style={{ margin: "0 0 6px", fontWeight: 700 }}>Week result</p>
            <RecapLine label="PokerStars tournaments" value={fmt(r.tournaments_cents)} cls={tone(r.tournaments_cents)} />
            <RecapLine label="ClubGG net" value={fmt(r.clubgg_net_cents)} cls={tone(r.clubgg_net_cents)} />
            <RecapLine label="Week total" value={fmt(r.total_cents)} cls={tone(r.total_cents)} strong />
            {w.transfers.length > 0 && <p className="sub" style={{ margin: "12px 0 6px", fontWeight: 700 }}>Your transfers</p>}
            {w.transfers.map((t) => {
              const paying = t.from_player_id === me;
              const st = transferStatus(t);
              return (
                <div className="recapline" key={t.id}>
                  <span className="sub" style={{ margin: 0 }}>{paying ? `You pay ${t.to_name}` : `${t.from_name} pays you`}</span>
                  <span>
                    <span className={"num " + (paying ? "neg" : "pos")} style={{ fontWeight: 700 }}>{fmt(t.amount_cents)}</span>
                    <span className={"badge " + st.cls} style={{ marginLeft: 8 }}>{st.text}</span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="muted" style={{ margin: "10px 0 0" }}>No settlement breakdown stored for this week (recaps start from the first lock after this update).</p>
      )}

      {w.activity.length > 0 && (
        <>
          <p className="sub" style={{ margin: "14px 0 4px", fontWeight: 700 }}>Week activity</p>
          <table className="fixed mini">
            <colgroup><col style={{ width: "20%" }} /><col style={{ width: "18%" }} /><col style={{ width: "42%" }} /><col style={{ width: "20%" }} /></colgroup>
            <thead><tr><th>Date</th><th>Type</th><th>Detail</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {w.activity.map((a, i) => (
                <tr key={i}>
                  <td className="muted">{a.played_on ? fmtDate(a.played_on) : fmtDate(a.created_at)}</td>
                  <td style={{ textTransform: "capitalize" }}>{a.kind}</td>
                  <td className="muted">{a.game_type || a.note || "—"}</td>
                  <td className={"num " + (a.amount_cents >= 0 ? "pos" : "neg")}>{fmt(a.amount_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </details>
  );
}

export default function MyAccount() {
  const { player } = useAuth();
  const [data, setData] = useState(null);
  const [recaps, setRecaps] = useState([]);
  const [err, setErr] = useState("");

  async function load() {
    try { setData(await api.get("/account")); } catch (e) { setErr(e.message); }
    api.get("/account/recaps").then(setRecaps).catch(() => {});
  }
  useEffect(() => { load(); }, []);

  if (err) return <div className="err">{err}</div>;
  if (!data) return <p className="muted">Loading…</p>;

  const bal = data.balance_cents;
  const ggInterim = data.clubgg_interim_cents;  // may be null (no GG balance yet)
  const ggAlloc = data.clubgg_allocation_cents;
  const ggNet = ggInterim != null ? ggInterim - (ggAlloc || 0) : null; // vs allocation
  const total = bal + (ggNet || 0);

  async function act(id, path) {
    try { await api.post(`/settlements/${id}/${path}`); await load(); }
    catch (e) { alert(e.message); }
  }

  return (
    <>
      <h1>My Balance</h1>
      <div className="grid c3" style={{ marginTop: 16 }}>
        <div className="card stat balcard">
          <div className="balmain">
            <span className="lbl">Balance</span>
            <div className={"val " + tone(bal)}>{fmt(bal)}</div>
          </div>
          <BrandIcon src="/pokerstars.png" glyph="♠" color="#d0021b" size={54} />
        </div>
        <div className="card stat balcard">
          <div className="balmain">
            <span className="lbl">Balance</span>
            <div className={"val " + tone(ggNet)}>{ggNet != null ? fmt(ggNet) : "—"}</div>
          </div>
          <BrandIcon src="/clubgg.png" glyph="♣" color="#e2e6ee" size={54} />
        </div>
        <div className="card stat">
          <span className="lbl">Total balance</span>
          <div className={"val " + tone(total)}>{fmt(total)}</div>
        </div>
      </div>

      <div className="card">
        <h2>You pay</h2>
        <table className="fixed">
          <colgroup><col style={{ width: "18%" }} /><col style={{ width: "32%" }} /><col style={{ width: "15%" }} /><col style={{ width: "20%" }} /><col style={{ width: "15%" }} /></colgroup>
          <thead><tr><th>To</th><th>Week</th><th className="num">Amount</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {data.i_owe.map((s) => (
              <tr key={s.id}>
                <td><PayTo name={s.to_name} payid={s.to_payid} /></td><td className="muted">{s.period || "—"}</td>
                <td className="num">{fmt(s.amount_cents)}</td>
                <td><StatusBadge t={s} /></td>
                <td className="num">
                  {!s.payer_marked_at && <button className="small" onClick={() => act(s.id, "mark-paid")}>Mark paid</button>}
                </td>
              </tr>
            ))}
            {data.i_owe.length === 0 && <tr><td colSpan={5} className="muted">Nothing to pay.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>You receive</h2>
        <table className="fixed">
          <colgroup><col style={{ width: "18%" }} /><col style={{ width: "32%" }} /><col style={{ width: "15%" }} /><col style={{ width: "20%" }} /><col style={{ width: "15%" }} /></colgroup>
          <thead><tr><th>From</th><th>Week</th><th className="num">Amount</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {data.owed_to_me.map((s) => (
              <tr key={s.id}>
                <td>{s.from_name}</td><td className="muted">{s.period || "—"}</td>
                <td className="num">{fmt(s.amount_cents)}</td>
                <td><StatusBadge t={s} /></td>
                <td className="num">
                  {!s.receiver_confirmed_at && (
                    <button className="small pos" disabled={!s.payer_marked_at}
                      title={s.payer_marked_at ? "" : "Waiting for payer to mark paid"}
                      onClick={() => act(s.id, "confirm")}>Confirm received</button>
                  )}
                </td>
              </tr>
            ))}
            {data.owed_to_me.length === 0 && <tr><td colSpan={5} className="muted">Nothing incoming.</td></tr>}
          </tbody>
        </table>
      </div>

      {recaps.length > 0 && (
        <div className="card">
          <h2>Weekly settlement recap</h2>
          <p className="sub" style={{ margin: "4px 0 10px" }}>
            Your line of each week's settlement, frozen when the week was locked — allocation, balances, rake,
            expenses and transfers, so you can always go back and check.
          </p>
          {recaps.map((w, i) => <WeekRecap key={w.id} w={w} me={player?.id} open={i === 0} />)}
        </div>
      )}

      <div className="card">
        <h2>Recent activity</h2>
        <table className="fixed">
          <colgroup><col style={{ width: "22%" }} /><col style={{ width: "22%" }} /><col style={{ width: "36%" }} /><col style={{ width: "20%" }} /></colgroup>
          <thead><tr><th>When</th><th>Type</th><th>Detail</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {data.ledger.map((l) => (
              <tr key={l.id}>
                <td className="muted">{fmtDateTime(l.created_at)}</td>
                <td style={{ textTransform: "capitalize" }}>{l.kind}</td>
                <td className="muted">{l.game_type || l.note || "—"}</td>
                <td className={"num " + (l.amount_cents >= 0 ? "pos" : "neg")}>{fmt(l.amount_cents)}</td>
              </tr>
            ))}
            {data.ledger.length === 0 && <tr><td colSpan={4} className="muted">No activity yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

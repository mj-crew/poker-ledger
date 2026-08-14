import { useEffect, useState } from "react";
import { api, fmt, fmtDateTime, transferStatus } from "../api";

function StatusBadge({ t }) {
  const st = transferStatus(t);
  return <span className={"badge " + st.cls}>{st.text}</span>;
}

// Loads a brand logo from /public; falls back to a coloured suit glyph if absent.
function BrandIcon({ src, glyph, color }) {
  const [ok, setOk] = useState(true);
  return ok
    ? <img src={src} alt="" onError={() => setOk(false)} style={{ height: 20, width: 20, objectFit: "contain", borderRadius: 4 }} />
    : <span style={{ color, fontSize: 17, lineHeight: 1 }}>{glyph}</span>;
}
const tone = (c) => (c > 0 ? "pos" : c < 0 ? "neg" : "");

export default function MyAccount() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");

  async function load() {
    try { setData(await api.get("/account")); } catch (e) { setErr(e.message); }
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
        <div className="card stat">
          <span className="lbl" style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
            <BrandIcon src="/pokerstars.png" glyph="♠" color="#d0021b" /> Pokerstars balance
          </span>
          <div className={"val " + tone(bal)}>{fmt(bal)}</div>
          <span className="sub">{bal > 0 ? "Owed to you" : bal < 0 ? "You owe" : "All square"}</span>
        </div>
        <div className="card stat">
          <span className="lbl" style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
            <BrandIcon src="/clubgg.png" glyph="♣" color="#e2e6ee" /> ClubGG balance
          </span>
          <div className={"val " + tone(ggNet)}>{ggNet != null ? fmt(ggNet) : "—"}</div>
          <span className="sub">{ggInterim != null ? `${fmt(ggInterim)} vs ${fmt(ggAlloc)} allocation` : "no balance yet"}</span>
        </div>
        <div className="card stat">
          <span className="lbl">Total balance</span>
          <div className={"val " + tone(total)}>{fmt(total)}</div>
          <span className="sub">Pokerstars + ClubGG</span>
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
                <td>{s.to_name}</td><td className="muted">{s.period || "—"}</td>
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

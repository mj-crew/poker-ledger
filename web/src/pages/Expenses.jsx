import { useEffect, useState } from "react";
import { api, fmt, fmtDate, fileToImagePart } from "../api";
import { useAuth } from "../auth.jsx";

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function weekKeyOf(playedOn) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(playedOn));
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(playedOn);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + (d.getDay() === 0 ? -6 : 1 - d.getDay()));
  return iso(d);
}
function weekLabel(key) {
  const [y, m, d] = key.split("-").map(Number);
  const f = (x) => x.toLocaleDateString("en-GB");
  return `${f(new Date(y, m - 1, d))} - ${f(new Date(y, m - 1, d + 6))}`;
}

export default function Expenses() {
  const { can } = useAuth();
  const canManage = can("settlement.lock");
  const [rows, setRows] = useState(null);
  const [roster, setRoster] = useState([]);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [receipt, setReceipt] = useState(null);

  const [desc, setDesc] = useState("");
  const [amount, setAmount] = useState("");
  const [playerId, setPlayerId] = useState("");
  const [date, setDate] = useState(() => iso(new Date()));
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);

  function load() { api.get("/expenses").then(setRows).catch((e) => setErr(e.message)); }
  useEffect(() => {
    load();
    if (canManage) api.get("/players").then((r) => setRoster(r.filter((p) => p.active))).catch(() => {});
  }, []); // eslint-disable-line

  async function add(e) {
    e.preventDefault(); setErr(""); setMsg(""); setBusy(true);
    try {
      let receipt_data_url;
      if (file) { const { media_type, data } = await fileToImagePart(file); receipt_data_url = `data:${media_type};base64,${data}`; }
      await api.post("/expenses", { description: desc, amount_cents: Math.round((parseFloat(amount) || 0) * 100), player_id: playerId ? +playerId : null, played_on: date, receipt_data_url });
      setMsg("Expense added."); setDesc(""); setAmount(""); setPlayerId(""); setFile(null);
      setTimeout(() => setMsg(""), 4000); load();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function del(id) { if (!confirm("Delete this expense?")) return; try { await api.del(`/expenses/${id}`); load(); } catch (e) { setErr(e.message); } }
  async function viewReceipt(id) { try { const r = await api.get(`/expenses/${id}/receipt`); setReceipt(r.receipt_data_url); } catch (e) { setErr(e.message); } }

  if (!rows) return <><h1>Expenses</h1><p className="muted">{err || "Loading…"}</p></>;

  const byWeek = {};
  for (const x of rows) (byWeek[weekKeyOf(x.played_on)] ||= []).push(x);
  const weekKeys = Object.keys(byWeek).sort().reverse();

  return (
    <>
      <h1>Expenses</h1>
      <p className="sub" style={{ marginBottom: 16 }}>Club spending, deducted from the rake. Everyone can see where the money goes.</p>

      {canManage && (
        <div className="card">
          <h2>Add expense</h2>
          <form className="row" onSubmit={add} style={{ flexWrap: "wrap" }}>
            <div style={{ flex: 2, minWidth: 180 }}><label>Description</label><input value={desc} onChange={(e) => setDesc(e.target.value)} required /></div>
            <div style={{ width: 110 }}><label>Amount $</label><input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required /></div>
            <div style={{ width: 170 }}><label>Allocated to</label>
              <select value={playerId} onChange={(e) => setPlayerId(e.target.value)}>
                <option value="">— (whole club)</option>
                {roster.map((p) => <option key={p.id} value={p.id}>{p.first_name}</option>)}
              </select>
            </div>
            <div style={{ width: 150 }}><label>Date</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
            <div style={{ width: 180 }}><label>Receipt</label><input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] || null)} /></div>
            <button style={{ alignSelf: "flex-end" }} disabled={busy}>{busy ? "Adding…" : "Add"}</button>
          </form>
          {err && <div className="err">{err}</div>}
          {msg && <div className="sub" style={{ color: "var(--pos)", marginTop: 8 }}>{msg}</div>}
        </div>
      )}

      {weekKeys.length === 0 && <div className="card muted">No expenses recorded yet.</div>}
      {weekKeys.map((k) => {
        const items = byWeek[k];
        const total = items.reduce((s, x) => s + x.amount_cents, 0);
        return (
          <div className="card" key={k}>
            <div className="row" style={{ marginBottom: 10 }}>
              <h2 style={{ margin: 0 }}>Week {weekLabel(k)}</h2>
              <span className="right gold" style={{ fontWeight: 700 }}>{fmt(total)}</span>
            </div>
            <table>
              <thead><tr><th>Date</th><th>Description</th><th>Allocated to</th><th className="num">Amount</th><th className="ctr">Receipt</th>{canManage && <th></th>}</tr></thead>
              <tbody>
                {items.map((x) => (
                  <tr key={x.id}>
                    <td className="muted">{fmtDate(x.played_on)}</td>
                    <td>{x.description}</td>
                    <td className="muted">{x.player_first || "Club"}</td>
                    <td className="num">{fmt(x.amount_cents)}</td>
                    <td className="ctr">{x.has_receipt ? <button className="linkbtn" onClick={() => viewReceipt(x.id)}>View</button> : <span className="muted">—</span>}</td>
                    {canManage && <td className="num"><button className="ghost small danger" onClick={() => del(x.id)}>Delete</button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}

      {receipt && (
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setReceipt(null); }}>
          <div className="modal" style={{ textAlign: "center" }}>
            <div className="row"><h2 style={{ margin: 0 }}>Receipt</h2><button className="right ghost small" onClick={() => setReceipt(null)}>✕</button></div>
            <img src={receipt} alt="receipt" style={{ maxWidth: "100%", marginTop: 12, borderRadius: 8 }} />
          </div>
        </div>
      )}
    </>
  );
}

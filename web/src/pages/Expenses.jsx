import { useEffect, useState, useRef } from "react";
import { api, fmt, fmtDate, fileToImagePart } from "../api";
import { useAuth } from "../auth.jsx";

// Receipt picker: click to arm, then Ctrl+V a screenshot, or Browse for a file.
function ReceiptInput({ file, setFile }) {
  const [armed, setArmed] = useState(false);
  const fileRef = useRef(null);
  useEffect(() => {
    if (!armed) return;
    function onPaste(e) {
      const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
      if (item) { e.preventDefault(); setFile(item.getAsFile()); setArmed(false); }
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [armed]); // eslint-disable-line
  return (
    <span className="shotbtn">
      <button type="button" className={"filebtn small" + (armed ? " armed" : "")}
        onFocus={() => setArmed(true)} onBlur={() => setArmed(false)}
        title="Click, then press Ctrl+V to paste a screenshot">
        {armed ? "⌨ Ctrl+V to paste…" : file ? "✓ receipt attached" : "📎 Paste receipt"}
      </button>
      <button type="button" className="ghost small" onClick={() => fileRef.current?.click()}>Browse</button>
      <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => setFile(e.target.files?.[0] || null)} />
      {file && <button type="button" className="ghost small" title="remove" onClick={() => setFile(null)}>✕</button>}
    </span>
  );
}

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

const EXP_STATUS = { pending: ["pend", "Pending"], approved: ["ok", "Approved"], rejected: ["gray", "Rejected"] };
function ExpStatus({ s }) { const [cls, label] = EXP_STATUS[s] || ["gray", s]; return <span className={"badge " + cls}>{label}</span>; }

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
      await api.post("/expenses", { description: desc, amount_cents: Math.round((parseFloat(amount) || 0) * 100), player_id: canManage ? (playerId ? +playerId : null) : undefined, played_on: date, receipt_data_url });
      setMsg(canManage ? "Expense added." : "Submitted for approval — you'll be reimbursed from the rake once an admin approves it.");
      setDesc(""); setAmount(""); setPlayerId(""); setFile(null);
      setTimeout(() => setMsg(""), 4000); load();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function del(id) { if (!confirm("Delete this expense?")) return; try { await api.del(`/expenses/${id}`); load(); } catch (e) { setErr(e.message); } }
  async function approve(id) { try { await api.post(`/expenses/${id}/approve`); load(); } catch (e) { setErr(e.message); } }
  async function reject(id) { if (!confirm("Reject this expense?")) return; try { await api.post(`/expenses/${id}/reject`); load(); } catch (e) { setErr(e.message); } }
  async function viewReceipt(id) { try { const r = await api.get(`/expenses/${id}/receipt`); setReceipt(r.receipt_data_url); } catch (e) { setErr(e.message); } }

  if (!rows) return <><h1>Expenses</h1><p className="muted">{err || "Loading…"}</p></>;

  const byWeek = {};
  for (const x of rows) (byWeek[weekKeyOf(x.played_on)] ||= []).push(x);
  const weekKeys = Object.keys(byWeek).sort().reverse();

  return (
    <>
      <h1>Expenses</h1>
      <p className="sub" style={{ marginBottom: 16 }}>Club spending, covered from the rake. Whoever claims an expense is reimbursed at settlement; the cost is shared across players by their rake contribution.</p>

      <div className="card">
        <h2>{canManage ? "Add expense" : "Submit an expense"}</h2>
        {!canManage && <p className="sub" style={{ marginTop: 4 }}>Attach the receipt. It goes to an admin for approval, then you're reimbursed from the rake at settlement.</p>}
        <form className="row" onSubmit={add} style={{ flexWrap: "wrap", marginTop: 8 }}>
          <div style={{ flex: 2, minWidth: 180 }}><label>Description</label><input value={desc} onChange={(e) => setDesc(e.target.value)} required /></div>
          <div style={{ width: 110 }}><label>Amount $</label><input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required /></div>
          {canManage && (
            <div style={{ width: 170 }}><label>Claimed by</label>
              <select value={playerId} onChange={(e) => setPlayerId(e.target.value)} required>
                <option value="">— select —</option>
                {roster.map((p) => <option key={p.id} value={p.id}>{p.first_name}</option>)}
              </select>
            </div>
          )}
          <div style={{ width: 150 }}><label>Date</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div style={{ minWidth: 200 }}><label>Receipt</label><div><ReceiptInput file={file} setFile={setFile} /></div></div>
          <button style={{ alignSelf: "flex-end" }} disabled={busy}>{busy ? "Saving…" : canManage ? "Add" : "Submit"}</button>
        </form>
        {err && <div className="err">{err}</div>}
        {msg && <div className="sub" style={{ color: "var(--pos)", marginTop: 8 }}>{msg}</div>}
      </div>

      {weekKeys.length === 0 && <div className="card muted">No expenses yet.</div>}
      {weekKeys.map((k) => {
        const items = byWeek[k];
        const total = items.filter((x) => x.status === "approved").reduce((s, x) => s + x.amount_cents, 0);
        const pending = items.filter((x) => x.status === "pending").length;
        return (
          <div className="card" key={k}>
            <div className="row" style={{ marginBottom: 10 }}>
              <h2 style={{ margin: 0 }}>Week {weekLabel(k)}</h2>
              <span className="right row" style={{ gap: 10 }}>
                {pending > 0 && <span className="badge pend">{pending} pending</span>}
                <span className="gold" style={{ fontWeight: 700 }}>{fmt(total)}</span>
              </span>
            </div>
            <table>
              <thead><tr><th>Date</th><th>Description</th><th>Claimed by</th><th className="num">Amount</th><th className="ctr">Receipt</th><th className="ctr">Status</th>{canManage && <th></th>}</tr></thead>
              <tbody>
                {items.map((x) => (
                  <tr key={x.id}>
                    <td className="muted">{fmtDate(x.played_on)}</td>
                    <td>{x.description}</td>
                    <td className="muted">{x.player_first || "—"}</td>
                    <td className="num">{fmt(x.amount_cents)}</td>
                    <td className="ctr">{x.has_receipt ? <button className="linkbtn" onClick={() => viewReceipt(x.id)}>View</button> : <span className="muted">—</span>}</td>
                    <td className="ctr"><ExpStatus s={x.status} /></td>
                    {canManage && <td className="num" style={{ whiteSpace: "nowrap" }}>
                      {x.status === "pending"
                        ? <><button className="small pos" onClick={() => approve(x.id)}>Approve</button> <button className="ghost small danger" onClick={() => reject(x.id)}>Reject</button></>
                        : <button className="ghost small danger" onClick={() => del(x.id)}>Delete</button>}
                    </td>}
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

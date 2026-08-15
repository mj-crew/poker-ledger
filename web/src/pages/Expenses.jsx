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
  const [editing, setEditing] = useState(null);

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
    e.preventDefault(); setErr(""); setMsg("");
    if (canManage && !playerId) { setErr("Choose who the expense is claimed by."); return; }
    if (!file) { setErr("Attach a receipt (paste or browse)."); return; }
    setBusy(true);
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
                {roster.map((p) => <option key={p.id} value={p.id}>{p.first_name} [{p.username}]</option>)}
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
                      {x.locked ? <span className="muted">🔒 locked</span> : <>
                        {x.status === "pending" && <><button className="small pos" onClick={() => approve(x.id)}>Approve</button>{" "}<button className="ghost small danger" onClick={() => reject(x.id)}>Reject</button>{" "}</>}
                        <button className="ghost small" onClick={() => setEditing(x)}>Edit</button>{" "}
                        <button className="ghost small danger" onClick={() => del(x.id)}>Delete</button>
                      </>}
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

      {editing && <EditExpenseModal e={editing} roster={roster} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </>
  );
}

function EditExpenseModal({ e, roster, onClose, onSaved }) {
  const [desc, setDesc] = useState(e.description);
  const [amount, setAmount] = useState((e.amount_cents / 100).toString());
  const [playerId, setPlayerId] = useState(e.player_id ? String(e.player_id) : "");
  const [date, setDate] = useState(String(e.played_on).slice(0, 10));
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function save() {
    if (!playerId) { setErr("Choose who the expense is claimed by."); return; }
    setBusy(true); setErr("");
    try {
      const body = { description: desc, amount_cents: Math.round((parseFloat(amount) || 0) * 100), player_id: +playerId, played_on: date };
      if (file) { const { media_type, data } = await fileToImagePart(file); body.receipt_data_url = `data:${media_type};base64,${data}`; }
      await api.patch(`/expenses/${e.id}`, body);
      onSaved();
    } catch (er) { setErr(er.message); } finally { setBusy(false); }
  }

  return (
    <div className="modal-overlay" onMouseDown={(ev) => { if (ev.target === ev.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="row"><h2 style={{ margin: 0 }}>Edit expense</h2><button className="right ghost small" onClick={onClose}>✕</button></div>
        <div className="grid c2" style={{ marginTop: 12 }}>
          <div style={{ gridColumn: "1 / -1" }}><label>Description</label><input value={desc} onChange={(ev) => setDesc(ev.target.value)} /></div>
          <div><label>Amount $</label><input type="number" step="0.01" value={amount} onChange={(ev) => setAmount(ev.target.value)} /></div>
          <div><label>Claimed by</label><select value={playerId} onChange={(ev) => setPlayerId(ev.target.value)}><option value="">— select —</option>{roster.map((p) => <option key={p.id} value={p.id}>{p.first_name} [{p.username}]</option>)}</select></div>
          <div><label>Date</label><input type="date" value={date} onChange={(ev) => setDate(ev.target.value)} /></div>
          <div><label>Receipt{e.has_receipt ? " (replace)" : ""}</label><div><ReceiptInput file={file} setFile={setFile} /></div></div>
        </div>
        {err && <div className="err">{err}</div>}
        <div className="row" style={{ marginTop: 16 }}>
          <button className="ghost small" onClick={onClose}>Close</button>
          <button className="right" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save changes"}</button>
        </div>
      </div>
    </div>
  );
}

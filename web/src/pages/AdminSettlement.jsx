import { useEffect, useState } from "react";
import { api, fmt, runningWeekLabel, runningWeekBounds, transferStatus } from "../api";
import { useAuth } from "../auth.jsx";

// Bright green ✓ when done, bright red ✗ when still outstanding.
const Mark = ({ on }) => <span className={on ? "tick" : "cross"}>{on ? "✓" : "✗"}</span>;

export default function AdminSettlement() {
  const { can } = useAuth();
  const [periods, setPeriods] = useState([]);
  const [sel, setSel] = useState(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [cg, setCg] = useState(null);      // ClubGG week { allocation_cents, players }
  const [cgAllo, setCgAllo] = useState({}); // player_id -> allocation $ (string)
  const [cgBal, setCgBal] = useState({});  // player_id -> finishing $ (string)
  const [cgRake, setCgRake] = useState({}); // player_id -> rake $ (string)

  async function load(selectId) {
    const ps = await api.get("/settlement/periods");
    setPeriods(ps);
    const id = selectId ?? sel?.id ?? ps[0]?.id;
    if (id) openPeriod(id);
  }
  async function loadClubgg() {
    const d = await api.get("/clubgg/week");
    setCg(d);
    setCgAllo(Object.fromEntries(d.players.map((p) => [p.player_id, (p.clubgg_allocation_cents / 100).toString()])));
    setCgBal(Object.fromEntries(d.players.map((p) => [p.player_id, (p.clubgg_balance_cents / 100).toString()])));
    setCgRake(Object.fromEntries(d.players.map((p) => [p.player_id, ((p.clubgg_rake_cents || 0) / 100).toString()])));
  }
  useEffect(() => { load(); loadClubgg().catch((e) => setErr(e.message)); }, []);

  async function openPeriod(id) {
    setSel(await api.get(`/settlement/periods/${id}`));
  }
  function flash(m) { setMsg(m); setErr(""); setTimeout(() => setMsg(""), 5000); }

  async function saveClubgg(rowsToSave) {
    setErr(""); setMsg("");
    try {
      await api.put("/clubgg/week", { balances: rowsToSave.map((r) => ({ player_id: r.player_id, clubgg_balance_cents: r.bal, clubgg_rake_cents: r.rake, clubgg_allocation_cents: r.allo })) });
      flash("ClubGG balances saved. They fold into the settlement when you lock.");
      loadClubgg();
    } catch (e) { setErr(e.message); }
  }

  async function lock() {
    if (!confirm(`Are you sure you want to lock this period (${activeWeek})?\n\nThis freezes everyone's balances into who-pays-whom for the week. Players can then pay & confirm.`)) return;
    setErr(""); setMsg("");
    try {
      const p = await api.post("/settlement/periods/lock", { label: runningWeekLabel(periods[0]) });
      await load(p.id);
      flash("Week locked — transfers generated. Players can now pay & confirm.");
    } catch (e) { setErr(e.message); }
  }

  // Zero balances to start a new week — independent of whether transfers are paid.
  async function resetBalances(id) {
    setErr(""); setMsg("");
    if (!confirm("Start a new week?\n\nThis resets everyone's running balance to $0 now. Unpaid transfers below stay tracked until each person marks them paid/confirmed.")) return;
    try { await api.post(`/settlement/periods/${id}/reset-balances`); await load(id); flash("New week started — balances reset to $0."); }
    catch (e) { setErr(e.message); }
  }

  // Mark the week's transfers all done — a record only, no balance effect.
  async function settle(id) {
    setErr(""); setMsg("");
    try { await api.post(`/settlement/periods/${id}/settle`); await load(id); flash("Marked settled — everyone's squared up."); }
    catch (e) {
      if (confirm(e.message + "\n\nMark settled anyway?")) {
        try { await api.post(`/settlement/periods/${id}/settle`, { force: true }); await load(id); flash("Marked settled (forced)."); }
        catch (e2) { setErr(e2.message); }
      }
    }
  }

  const confirmedCount = sel?.transfers?.filter((t) => t.status === "confirmed").length ?? 0;
  const activeWeek = runningWeekLabel(periods[0]); // rolls to next week once this one is settled + reset
  // Locking is only allowed on/after the last day (Sunday) of the active week.
  const weekEnd = runningWeekBounds(periods[0]).end;
  const lastDayStr = weekEnd.toLocaleDateString("en-GB");
  const todayMid = new Date(); todayMid.setHours(0, 0, 0, 0);
  const canLockNow = todayMid.getTime() >= weekEnd.getTime();

  // ClubGG live rows from the current inputs: net = (stack − allocation) + rake.
  const cgAlloc = cg?.allocation_cents ?? 200000; // default, used as the header hint
  const cgRows = (cg?.players || []).map((p) => {
    const allo = Math.round((parseFloat(cgAllo[p.player_id]) || 0) * 100);
    const bal = Math.round((parseFloat(cgBal[p.player_id]) || 0) * 100);
    const rake = Math.round((parseFloat(cgRake[p.player_id]) || 0) * 100);
    const net = (bal - allo) + rake;
    return { ...p, allo, bal, rake, net, combined: (p.ledger_balance_cents || 0) + net };
  });
  const cgNetSum = cgRows.reduce((s, r) => s + r.net, 0);
  const tone = (c) => (c > 0 ? "pos" : c < 0 ? "neg" : "");
  // ClubGG must be saved (no unsaved edits) and balanced (nets total $0) to lock.
  const cgDirty = cgRows.some((r) => r.bal !== r.clubgg_balance_cents || r.rake !== (r.clubgg_rake_cents || 0) || r.allo !== r.clubgg_allocation_cents);
  const lockReasons = [];
  if (!canLockNow) lockReasons.push(`this week ends ${lastDayStr} — lock opens then`);
  if (!cg) lockReasons.push("ClubGG still loading");
  else if (cgDirty) lockReasons.push("save the ClubGG balances first");
  else if (cgNetSum !== 0) lockReasons.push(`ClubGG nets must total $0 (now ${fmt(cgNetSum)})`);
  const canLock = canLockNow && !!cg && !cgDirty && cgNetSum === 0;

  return (
    <>
      <h1>Weekly Settlement</h1>
      <p className="sub" style={{ marginBottom: 16 }}>
        <strong>Lock</strong> freezes who pays whom. <strong>Start new week</strong> resets balances so the next week runs
        clean (even if people haven't paid yet). <strong>Mark settled</strong> just records that everyone's squared up.
      </p>

      {can("settlement.lock") && cg && (
        <div className="card">
          <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
            <h2 style={{ margin: 0 }}>ClubGG week</h2>
            <span className="right sub gold">Default allocation {fmt(cgAlloc)}</span>
          </div>
          <p className="sub" style={{ margin: "6px 0 12px" }}>
            Enter each player's allocation (defaults to {fmt(cgAlloc)}, adjust if it differed), their Sunday finishing
            stack, and the cash-game rake they paid (rebated back). Net = (stack − allocation) + rake. Folds into the settlement when you lock.
          </p>
          <table>
            <thead><tr>
              <th>Player</th><th className="ctr">Allocation $</th><th className="ctr">Finishing $</th><th className="ctr">Rake $</th>
              <th className="ctr">ClubGG net</th><th className="ctr">Tournaments</th><th className="ctr">Combined</th>
            </tr></thead>
            <tbody>
              {cgRows.map((r) => (
                <tr key={r.player_id}>
                  <td>{r.name}{r.clubgg_handle && <div className="muted" style={{ fontSize: 12 }}>{r.clubgg_handle}</div>}</td>
                  <td className="ctr"><input type="number" value={cgAllo[r.player_id] ?? ""} onChange={(e) => setCgAllo((m) => ({ ...m, [r.player_id]: e.target.value }))} style={{ width: 90 }} /></td>
                  <td className="ctr"><input type="number" value={cgBal[r.player_id] ?? ""} onChange={(e) => setCgBal((m) => ({ ...m, [r.player_id]: e.target.value }))} style={{ width: 100 }} /></td>
                  <td className="ctr"><input type="number" value={cgRake[r.player_id] ?? ""} onChange={(e) => setCgRake((m) => ({ ...m, [r.player_id]: e.target.value }))} style={{ width: 90 }} /></td>
                  <td className={"ctr " + tone(r.net)}>{fmt(r.net)}</td>
                  <td className={"ctr " + tone(r.ledger_balance_cents || 0)}>{fmt(r.ledger_balance_cents || 0)}</td>
                  <td className={"ctr " + tone(r.combined)}>{fmt(r.combined)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 12 }}>
            <span className={"badge " + (cgNetSum === 0 ? "ok" : "live")}>
              ClubGG nets total {fmt(cgNetSum)}{cgNetSum === 0 ? " ✓" : " — must be $0 to settle"}
            </span>
            <span className="right"><button onClick={() => saveClubgg(cgRows)}>Save ClubGG balances</button></span>
          </div>
        </div>
      )}

      {can("settlement.lock") && (
        <div className="card">
          <div className="row">
            <h2 style={{ margin: 0 }}>Lock this week</h2>
            <span className="right gold" style={{ fontWeight: 700 }}>{activeWeek}</span>
          </div>
          <p className="sub" style={{ margin: "6px 0 12px" }}>Freezes everyone's balances into who-pays-whom for the week {activeWeek}.</p>
          <button onClick={lock} disabled={!canLock}
            title={canLock ? "" : lockReasons.join("; ")}>
            Lock & generate transfers
          </button>
          {!canLock && (
            <p className="sub" style={{ marginTop: 8 }}>🔒 Before locking: {lockReasons.join(" · ")}.</p>
          )}
        </div>
      )}
      {err && <div className="card err">{err}</div>}
      {msg && <div className="card sub" style={{ color: "var(--pos)" }}>{msg}</div>}

      <div className="card">
        <h2>Periods</h2>
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          {periods.map((p) => (
            <button key={p.id} className={"small " + (sel?.id === p.id ? "" : "ghost")} onClick={() => openPeriod(p.id)}>
              {p.label || `#${p.id}`}{p.balances_reset_at ? " · reset" : ""}{p.status === "settled" ? " · settled" : ""}
            </button>
          ))}
          {periods.length === 0 && <span className="muted">No periods yet.</span>}
        </div>
      </div>

      {sel && (
        <div className="card">
          <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
            <h2 style={{ margin: 0 }}>{sel.label || `Period #${sel.id}`}</h2>
            {sel.balances_reset_at
              ? <span className="badge ok">new week started ✓</span>
              : <span className="badge pend">balances live</span>}
            {sel.status === "settled"
              ? <span className="badge ok">settled ✓</span>
              : <span className="badge pend">{confirmedCount}/{sel.transfers.length} confirmed</span>}

            <span className="right row" style={{ gap: 8 }}>
              {!sel.balances_reset_at && can("settlement.reset") && (
                <button className="pos" style={{ color: "#fff" }} onClick={() => resetBalances(sel.id)}>Start new week (reset balances)</button>
              )}
              {sel.status !== "settled" && can("settlement.settle") && (
                <button className="ghost" onClick={() => settle(sel.id)}>Mark settled</button>
              )}
            </span>
          </div>

          <p className="sub" style={{ marginTop: 8 }}>
            {sel.balances_reset_at
              ? "Balances for this week are reset — the new week is running clean. Transfers below are still tracked until paid & confirmed."
              : "Balances still include this week. Click “Start new week” whenever you want the next week to begin fresh — it won't wait for payments."}
          </p>

          <table style={{ marginTop: 12 }}>
            <thead><tr><th>Payer</th><th>Pays</th><th className="ctr">Amount</th><th className="ctr">Payer marked paid</th><th className="ctr">Receiver confirmed</th><th className="ctr">Status</th></tr></thead>
            <tbody>
              {sel.transfers.map((t) => {
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
              {sel.transfers.length === 0 && <tr><td colSpan={6} className="muted">No transfers.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

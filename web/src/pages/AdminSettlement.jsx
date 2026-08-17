import { useEffect, useState } from "react";
import { api, fmt, runningWeekLabel, runningWeekBounds, allocateProrata, transferStatus } from "../api";
import { useAuth } from "../auth.jsx";
import ScreenshotButton from "../components/ScreenshotButton.jsx";

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
  const [cgInterim, setCgInterim] = useState({}); // player_id -> interim GG $ (string)
  const [cgBal, setCgBal] = useState({});  // player_id -> finishing $ (string)
  const [cgRake, setCgRake] = useState({}); // player_id -> rake $ (string)
  const [allExpenses, setAllExpenses] = useState([]);

  // The week being accumulated — from the server, so it only advances on reset
  // (Monday must still let you lock the week that just finished).
  const [runWeek, setRunWeek] = useState(null);
  async function load(selectId) {
    const [ps, rw] = await Promise.all([api.get("/settlement/periods"), api.get("/settlement/running-week")]);
    setPeriods(ps); setRunWeek(rw);
    const id = selectId ?? sel?.id ?? ps[0]?.id;
    if (id) openPeriod(id);
  }
  async function loadClubgg() {
    const d = await api.get("/clubgg/week");
    setCg(d);
    setCgAllo(Object.fromEntries(d.players.map((p) => [p.player_id, (p.clubgg_allocation_cents / 100).toString()])));
    setCgInterim(Object.fromEntries(d.players.map((p) => [p.player_id, p.clubgg_interim_cents != null ? (p.clubgg_interim_cents / 100).toString() : ""])));
    setCgBal(Object.fromEntries(d.players.map((p) => [p.player_id, p.clubgg_balance_cents != null ? (p.clubgg_balance_cents / 100).toString() : ""])));
    setCgRake(Object.fromEntries(d.players.map((p) => [p.player_id, ((p.clubgg_rake_cents || 0) / 100).toString()])));
  }
  useEffect(() => {
    load();
    loadClubgg().catch((e) => setErr(e.message));
    api.get("/expenses").then(setAllExpenses).catch(() => {});
  }, []);

  async function openPeriod(id) {
    setSel(await api.get(`/settlement/periods/${id}`));
  }
  function flash(m) { setMsg(m); setErr(""); setTimeout(() => setMsg(""), 5000); }

  function onGgBalances(res) {
    const u = res.updated?.length || 0, un = res.unmatched?.length || 0;
    flash(`GG balances read: updated ${u}${un ? `, ${un} not matched (${res.unmatched.map((x) => x.screen_name).join(", ")})` : ""}. Upload more screens to fill the rest.`);
    loadClubgg();
  }

  // Weekly ClubGG club export (.xlsx). Two independent jobs from one file:
  //   • stats      → gg_* tables behind My Stats / Results
  //   • balances   → "ClubGG End of the week balance" (Club Member Balance tab)
  //                  and "Full rake contribution $" (Club Overview → Fee)
  // They're written separately but must agree; the response reports any drift.
  const [importing, setImporting] = useState(false);
  const [impStats, setImpStats] = useState(true);
  const [impBalances, setImpBalances] = useState(false);
  const [impReport, setImpReport] = useState(null);
  async function importReport(file) {
    setImporting(true); setErr(""); setImpReport(null);
    try {
      const data = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1]); // strip data: prefix
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      const res = await api.post("/clubgg/import", { data, import_stats: impStats, populate_balances: impBalances });
      setImpReport(res);
      const bits = [`week ${res.period.week_start} → ${res.period.week_end}`];
      if (res.imported_stats) bits.push(`stats: ${res.tournaments} tournaments, ${res.cash_sessions} cash sessions`);
      bits.push(res.populated_balances ? `balances + rake written for ${res.prefilled} players`
                                       : `balances NOT written (${res.prefill_available} available)`);
      flash(`Report imported — ${bits.join(" · ")}`);
      loadClubgg();
    } catch (e) { setErr(e.message || "Import failed"); }
    finally { setImporting(false); }
  }
  async function saveClubgg(rowsToSave) {
    setErr(""); setMsg("");
    try {
      await api.put("/clubgg/week", { balances: rowsToSave.map((r) => ({ player_id: r.player_id, clubgg_balance_cents: r.bal, clubgg_rake_cents: r.rake, clubgg_allocation_cents: r.allo, clubgg_interim_cents: r.interim })) });
      flash("ClubGG balances saved. They fold into the settlement when you lock.");
      loadClubgg();
    } catch (e) { setErr(e.message); }
  }

  async function lock() {
    if (!confirm(`Are you sure you want to lock this period (${activeWeek})?\n\nThis freezes everyone's balances into who-pays-whom for the week. Players can then pay & confirm.`)) return;
    setErr(""); setMsg("");
    try {
      const { start, end } = runningWeekBounds(runWeek ?? periods[0]);
      const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const p = await api.post("/settlement/periods/lock", { label: runningWeekLabel(runWeek ?? periods[0]), starts_on: iso(start), ends_on: iso(end) });
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
  const weekAnchor = runWeek ?? periods[0];
  const activeWeek = runningWeekLabel(weekAnchor); // advances only when a week is reset
  // Locking is only allowed on/after the last day (Sunday) of the active week —
  // and stays open after that (Monday, Tuesday…) until it's actually locked.
  const weekEnd = runningWeekBounds(weekAnchor).end;
  const lastDayStr = weekEnd.toLocaleDateString("en-GB");
  const todayMid = new Date(); todayMid.setHours(0, 0, 0, 0);
  const canLockNow = todayMid.getTime() >= weekEnd.getTime();

  // Claimed expenses in the active week → covered prorata by rake, reimbursed to claimers.
  const weekStart = runningWeekBounds(weekAnchor).start;
  const inWeek = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d)); const x = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(d); return x >= weekStart && x <= weekEnd; };
  // Only expenses whose claimer is IN the settlement table can be shared out —
  // otherwise the shares would be deducted from everyone with nobody visible
  // being reimbursed, and the nets would sit at exactly −(that expense).
  const tablePlayerIds = new Set((cg?.players || []).map((p) => p.player_id));
  const claimedMap = {}; let totalClaimed = 0;
  const orphanExpenses = []; // approved, this week, but claimer not in the table (inactive?)
  for (const e of allExpenses) {
    if (!(e.player_id && e.status === "approved" && inWeek(e.played_on))) continue;
    if (!tablePlayerIds.has(e.player_id)) { orphanExpenses.push(e); continue; }
    claimedMap[e.player_id] = (claimedMap[e.player_id] || 0) + e.amount_cents; totalClaimed += e.amount_cents;
  }
  const rakeCentsOf = (pid) => Math.round((parseFloat(cgRake[pid]) || 0) * 100);
  const shares = allocateProrata((cg?.players || []).map((p) => ({ id: p.player_id, weight: rakeCentsOf(p.player_id) })), totalClaimed);

  // ClubGG rows. The effective stack is the END-OF-WEEK balance once entered
  // (settlement day), until then the MIDWEEK position, else the allocation.
  // Net rake back = rake − prorata expense share + reimbursements;
  // ClubGG net = (effective − allocation) + net rake back.
  const cgAlloc = cg?.allocation_cents ?? 200000; // default, used as the header hint
  const cgRows = (cg?.players || []).map((p) => {
    const allo = Math.round((parseFloat(cgAllo[p.player_id]) || 0) * 100);
    const bRaw = cgBal[p.player_id];
    const balEntered = bRaw !== "" && bRaw != null;
    const bal = balEntered ? Math.round((parseFloat(bRaw) || 0) * 100) : null;
    const rake = Math.round((parseFloat(cgRake[p.player_id]) || 0) * 100);
    const iRaw = cgInterim[p.player_id];
    const interim = iRaw === "" || iRaw == null ? null : Math.round((parseFloat(iRaw) || 0) * 100);
    const effective = balEntered ? bal : (interim ?? allo);
    const expenseEffect = (claimedMap[p.player_id] || 0) - (shares[p.player_id] || 0); // reimbursed − covered
    const netRakeBack = rake + expenseEffect;
    const net = (effective - allo) + netRakeBack;
    return { ...p, allo, bal, balEntered, rake, interim, expenseEffect, netRakeBack, net, combined: (p.ledger_balance_cents || 0) + net };
  });
  const cgNetSum = cgRows.reduce((s, r) => s + r.net, 0);
  const tone = (c) => (c > 0 ? "pos" : c < 0 ? "neg" : "");
  // Expenses are shared prorata by rake. With no rake entered yet there's nothing
  // to share against, so reimbursements go out unfunded and the nets sit at
  // exactly +(claimed expenses) until the rake column is filled. Not an error —
  // just an incomplete table — so say so instead of "must be $0".
  const totalRake = cgRows.reduce((s, r) => s + r.rake, 0);
  const expensesUnfunded = totalRake === 0 && totalClaimed > 0 && cgNetSum === totalClaimed;
  const netSumHint = cgNetSum === 0 ? " ✓"
    : expensesUnfunded ? ` — ${fmt(totalClaimed)} of expenses can't be shared yet: enter the rake first`
    : " — must be $0 to settle";
  // Lock needs: saved (no unsaved edits), end-of-week balances in (no lingering
  // midweek positions), and balanced (nets total $0).
  const cgDirty = cgRows.some((r) => r.bal !== r.clubgg_balance_cents || r.rake !== (r.clubgg_rake_cents || 0) || r.allo !== r.clubgg_allocation_cents);
  const cgMidweekPending = cgRows.some((r) => !r.balEntered && r.interim != null);
  const lockReasons = [];
  if (!canLockNow) lockReasons.push(`this week ends ${lastDayStr} — lock opens then`);
  if (!cg) lockReasons.push("ClubGG still loading");
  else if (cgDirty) lockReasons.push("save the ClubGG balances first");
  else if (cgMidweekPending) lockReasons.push("enter the ClubGG end-of-week balances (some players only have a midweek position)");
  else if (cgNetSum !== 0) lockReasons.push(expensesUnfunded
    ? `enter the rake — ${fmt(totalClaimed)} of expenses can't be shared until it's in`
    : `ClubGG nets must total $0 (now ${fmt(cgNetSum)})`);
  const canLock = canLockNow && !!cg && !cgDirty && !cgMidweekPending && cgNetSum === 0;

  return (
    <>
      <h1 style={{ marginBottom: 16 }}>Weekly Settlement</h1>

      {can("settlement.lock") && cg && (
        <div className="card">
          <div className="row" style={{ flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <h2 style={{ margin: 0 }}>ClubGG week</h2>
            <span className="right row" style={{ gap: 10, alignItems: "center" }}>
              <ScreenshotButton kind="clubgg_balances" label="📷 Upload GG balances" onResult={onGgBalances} />
              <span className="sub gold">Default allocation {fmt(cgAlloc)}</span>
            </span>
          </div>
          <p className="sub" style={{ margin: "6px 0 12px" }}>
            During the week the <strong>midweek position</strong> drives the numbers. On settlement day, enter (or import)
            the <strong>end-of-week balance</strong> — once it's in, the midweek column stops counting and greys out.
            Net rake back = rake − prorata expense share + expenses you claimed;
            ClubGG net = (stack − allocation) + net rake back. Folds into the settlement when you lock.
          </p>

          <div className="ggimport">
            <div className="row" style={{ flexWrap: "wrap", gap: 14, alignItems: "center" }}>
              <strong style={{ fontSize: 13 }}>📄 ClubGG weekly report (.xlsx)</strong>
              <label className="caprow" style={{ cursor: "pointer", padding: "6px 10px", flex: "0 0 auto" }}>
                <input type="checkbox" checked={impStats} onChange={(e) => setImpStats(e.target.checked)} style={{ width: "auto" }} />
                <span style={{ fontSize: 12 }}>Import stats <span className="sub" style={{ display: "block" }}>My Stats + Results</span></span>
              </label>
              <label className="caprow" style={{ cursor: "pointer", padding: "6px 10px", flex: "0 0 auto" }}>
                <input type="checkbox" checked={impBalances} onChange={(e) => setImpBalances(e.target.checked)} style={{ width: "auto" }} />
                <span style={{ fontSize: 12 }}>Populate balances &amp; rake <span className="sub" style={{ display: "block" }}>overwrites the two columns below</span></span>
              </label>
              <label className="right" style={{ cursor: importing ? "default" : "pointer", display: "inline-flex", alignItems: "center",
                border: "1px solid var(--line-2)", borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 700,
                opacity: importing || (!impStats && !impBalances) ? 0.5 : 1 }}>
                {importing ? "Importing…" : "Choose file…"}
                <input type="file" accept=".xlsx" style={{ display: "none" }} disabled={importing || (!impStats && !impBalances)}
                  onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) importReport(f); }} />
              </label>
            </div>

            {impReport && (
              <div className="ggrecon">
                <div className={"reconhead " + (impReport.balanced ? "ok" : "warn")}>
                  {impReport.balanced
                    ? "✓ Stats and balances reconcile — everything agrees."
                    : "⚠ Out of balance — review before locking the week."}
                  <span className="sub" style={{ marginLeft: 8 }}>
                    week {impReport.period.week_start} → {impReport.period.week_end}
                  </span>
                </div>
                {impReport.parse_check?.length > 0 && (
                  <p className="sub">
                    <strong>Report doesn't add up</strong> (our figures vs ClubGG's own P&L):{" "}
                    {impReport.parse_check.map((x) => `${x.nickname} ${fmt(x.diff_cents)}`).join(" · ")}
                  </p>
                )}
                {impReport.fee_check?.length > 0 && (
                  <p className="sub">
                    <strong>Rake mismatch</strong> (Club Overview “Fee” vs cash sessions):{" "}
                    {impReport.fee_check.map((x) => `${x.nickname} ${fmt(x.diff_cents)}`).join(" · ")}
                  </p>
                )}
                {impReport.balance_check?.length > 0 && (
                  <>
                    <p className="sub" style={{ marginBottom: 4 }}>
                      <strong>Balances vs stats</strong> — finishing stack minus allocation should equal the player's
                      tournament + cash result. Usually means the post-tournament chip transfer (house payout split)
                      hasn't been made on ClubGG yet:
                    </p>
                    <table className="mini">
                      <thead><tr><th>Player</th><th className="num">From balances</th><th className="num">From stats</th><th className="num">Difference</th></tr></thead>
                      <tbody>
                        {impReport.balance_check.map((x) => (
                          <tr key={x.nickname}>
                            <td>{x.nickname}</td>
                            <td className="num">{fmt(x.chip_delta_cents)}</td>
                            <td className="num">{fmt(x.stats_net_cents)}</td>
                            <td className={"num " + (x.diff_cents === 0 ? "" : x.diff_cents > 0 ? "pos" : "neg")}>{fmt(x.diff_cents)}</td>
                          </tr>
                        ))}
                        <tr>
                          <td className="muted">Total</td><td /><td />
                          <td className={"num " + (impReport.balance_check.reduce((s, x) => s + x.diff_cents, 0) === 0 ? "muted" : "neg")}>
                            {fmt(impReport.balance_check.reduce((s, x) => s + x.diff_cents, 0))}
                            {impReport.balance_check.reduce((s, x) => s + x.diff_cents, 0) === 0 && " — nets to zero"}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </>
                )}
                {impReport.unmatched?.length > 0 && (
                  <p className="sub"><strong>Not matched to a member:</strong> {impReport.unmatched.join(", ")} — set their ClubGG name in Members.</p>
                )}
                {impReport.warnings?.length > 0 && <p className="sub">⚠ {impReport.warnings.join(" · ")}</p>}
              </div>
            )}
          </div>
          <table>
            <thead><tr>
              <th>Player</th><th className="ctr">ClubGG Weekly Allocation</th><th className="ctr">Midweek Club GG Cash Position</th><th className="ctr">ClubGG End of the week balance</th><th className="ctr">Full rake contribution $</th><th className="ctr">Club GG Prorata weekly expenses $</th>
              <th className="ctr">ClubGG Net Rake Back $</th><th className="ctr">ClubGG Net (after expenses &amp; rake back)</th><th className="ctr">Pokerstars Tournaments $</th><th className="ctr">Total</th>
            </tr></thead>
            <tbody>
              {cgRows.map((r) => (
                <tr key={r.player_id}>
                  <td>{r.name}{r.clubgg_handle && <div className="muted" style={{ fontSize: 12 }}>{r.clubgg_handle}</div>}</td>
                  <td className="ctr"><input type="number" value={cgAllo[r.player_id] ?? ""} onChange={(e) => setCgAllo((m) => ({ ...m, [r.player_id]: e.target.value }))} style={{ width: 90 }} /></td>
                  <td className="ctr"><input type="number" placeholder="—" disabled={r.balEntered}
                    title={r.balEntered ? "End-of-week balance is entered — the midweek position no longer counts" : "Live stack during the week (from screenshots)"}
                    value={cgInterim[r.player_id] ?? ""} onChange={(e) => setCgInterim((m) => ({ ...m, [r.player_id]: e.target.value }))} style={{ width: 100 }} /></td>
                  <td className="ctr"><input type="number" placeholder="settle day" value={cgBal[r.player_id] ?? ""} onChange={(e) => setCgBal((m) => ({ ...m, [r.player_id]: e.target.value }))} style={{ width: 100 }} /></td>
                  <td className="ctr"><input type="number" value={cgRake[r.player_id] ?? ""} onChange={(e) => setCgRake((m) => ({ ...m, [r.player_id]: e.target.value }))} style={{ width: 90 }} /></td>
                  <td className={"ctr " + tone(r.expenseEffect)}>{r.expenseEffect ? fmt(r.expenseEffect) : "—"}</td>
                  <td className={"ctr " + tone(r.netRakeBack)}>{fmt(r.netRakeBack)}</td>
                  <td className={"ctr " + tone(r.net)}>{fmt(r.net)}</td>
                  <td className={"ctr " + tone(r.ledger_balance_cents || 0)}>{fmt(r.ledger_balance_cents || 0)}</td>
                  <td className={"ctr " + tone(r.combined)}>{fmt(r.combined)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {orphanExpenses.length > 0 && (
            <div className="err" style={{ marginTop: 12 }}>
              ⚠ {orphanExpenses.length === 1 ? "An approved expense is" : `${orphanExpenses.length} approved expenses are`} claimed by
              someone not in this table, so {orphanExpenses.length === 1 ? "it's" : "they're"} left out of the sharing:{" "}
              {orphanExpenses.map((e) => `${e.description} ${fmt(e.amount_cents)} (${e.player_name || "unknown member"})`).join(" · ")}.
              Reactivate that member or re-assign the expense in the Expenses tab.
            </div>
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <span className={"badge " + (cgNetSum === 0 ? "ok" : "live")}>
              ClubGG nets total {fmt(cgNetSum)}{netSumHint}
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

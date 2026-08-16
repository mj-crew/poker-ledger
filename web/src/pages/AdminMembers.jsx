import { useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth.jsx";

const randPw = () => Math.random().toString(36).slice(2, 6) + Math.random().toString(36).slice(2, 6);

function RoleBadge({ role }) {
  const map = { superadmin: ["ok", "System admin"], admin: ["pend", "Admin"], player: ["gray", "Player"] };
  const [cls, label] = map[role] || ["gray", role];
  return <span className={"badge " + cls}>{label}</span>;
}

export default function AdminMembers() {
  const { player: me, can, actAs } = useAuth();
  const isSuper = me?.role === "superadmin";
  const canActAs = can("members.actas");

  const [players, setPlayers] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [editId, setEditId] = useState(null);

  // new member form
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [username, setUsername] = useState("");
  const [clubgg, setClubgg] = useState("");
  const [role, setRole] = useState("player");
  const [pw, setPw] = useState(randPw());

  async function load() {
    try {
      const [ps, cat] = await Promise.all([api.get("/players"), api.get("/capabilities")]);
      setPlayers(ps); setCatalog(cat);
    } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);
  function flash(m) { setMsg(m); setErr(""); setTimeout(() => setMsg(""), 6000); }

  async function create(e) {
    e.preventDefault(); setErr("");
    try {
      await api.post("/players", { first_name: firstName, last_name: lastName, phone, username, role, temp_password: pw, clubgg_handle: clubgg });
      flash(`Created ${firstName}. Temp password: ${pw} — share it; they change it on first login.`);
      setFirstName(""); setLastName(""); setPhone(""); setUsername(""); setClubgg(""); setRole("player"); setPw(randPw());
      load();
    } catch (e) { setErr(e.message); }
  }
  async function patch(id, body, okMsg) {
    const r = await api.patch(`/players/${id}`, body);
    if (okMsg) flash(okMsg);
    load();
    return r;
  }

  async function act(p) {
    if (!confirm(`Act as ${p.first_name} [${p.username}]?\n\nYou'll see the app as they do, and anything you do is recorded as them. This switch is logged.`)) return;
    try { await actAs(p.id); } catch (e) { setErr(e.message); }
  }

  const editing = players.find((p) => p.id === editId) || null;

  return (
    <>
      <h1>Members</h1>
      <p className="sub" style={{ marginBottom: 16 }}>
        Create accounts and hand out temp passwords. Rows are read-only — click the ✏️ to edit a member{isSuper ? ", set their role, or grant permissions" : ""}.
      </p>

      <div className="card">
        <h2>Add member</h2>
        <form className="row" onSubmit={create} style={{ flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 120 }}><label>First name</label><input value={firstName} onChange={(e) => setFirstName(e.target.value)} required /></div>
          <div style={{ flex: 1, minWidth: 120 }}><label>Last name</label><input value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="optional" /></div>
          <div style={{ flex: 1, minWidth: 130 }}><label>Phone</label><input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="optional" /></div>
          <div style={{ flex: 1, minWidth: 140 }}><label>PokerStars screen name</label><input value={username} onChange={(e) => setUsername(e.target.value)} required /></div>
          <div style={{ flex: 1, minWidth: 130 }}><label>ClubGG name</label><input value={clubgg} onChange={(e) => setClubgg(e.target.value)} placeholder="optional" /></div>
          {isSuper && (
            <div style={{ width: 120 }}><label>Role</label>
              <select value={role} onChange={(e) => setRole(e.target.value)}><option value="player">Player</option><option value="admin">Admin</option></select>
            </div>
          )}
          <div style={{ width: 150 }}><label>Temp password</label>
            <div className="row" style={{ gap: 6 }}>
              <input value={pw} onChange={(e) => setPw(e.target.value)} />
              <button type="button" className="ghost small" title="Suggest" onClick={() => setPw(randPw())}>⟳</button>
            </div>
          </div>
          <button style={{ alignSelf: "flex-end" }}>Create</button>
        </form>
        {err && !editing && <div className="err">{err}</div>}
        {msg && <div className="sub" style={{ color: "var(--pos)", marginTop: 8 }}>{msg}</div>}
      </div>

      <div className="card">
        <h2>All members</h2>
        <table className="fixed">
          <colgroup>
            <col style={{ width: "13%" }} /><col style={{ width: "12%" }} /><col style={{ width: "12%" }} /><col style={{ width: "17%" }} /><col style={{ width: "14%" }} />
            <col style={{ width: "11%" }} /><col style={{ width: "11%" }} /><col style={{ width: "10%" }} />
          </colgroup>
          <thead><tr><th>First name</th><th>Last name</th><th>Phone</th><th>PokerStars screen name</th><th>ClubGG name</th><th>Role</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {players.map((p) => (
              <tr key={p.id}>
                <td>{p.first_name}</td>
                <td className="muted">{p.last_name || "—"}</td>
                <td className="muted">{p.phone || "—"}</td>
                <td className="muted">{p.username}</td>
                <td className="muted">{p.clubgg_handle || "—"}</td>
                <td><RoleBadge role={p.role} /></td>
                <td><span className={"badge " + (p.active ? "ok" : "gray")}>{p.active ? "active" : "inactive"}</span></td>
                <td className="rowactions">
                  {canActAs && p.active && p.id !== me?.id && (
                    <button className="ghost small iconbtn" title={`Act as ${p.first_name} — you'll see the app exactly as they do`}
                      onClick={() => act(p)}>🎭</button>
                  )}
                  <button className="ghost small iconbtn" title="Edit member" onClick={() => setEditId(p.id)}>✏️</button>
                </td>
              </tr>
            ))}
            {players.length === 0 && <tr><td colSpan={8} className="muted">No members.</td></tr>}
          </tbody>
        </table>
      </div>

      {editing && (
        <EditMemberModal p={editing} me={me} isSuper={isSuper} catalog={catalog}
          onClose={() => setEditId(null)} patch={patch} />
      )}
    </>
  );
}

function EditMemberModal({ p, me, isSuper, catalog, onClose, patch }) {
  const [first, setFirst] = useState(p.first_name || "");
  const [last, setLast] = useState(p.last_name || "");
  const [phone, setPhone] = useState(p.phone || "");
  const [email, setEmail] = useState(p.email || "");
  const [payid, setPayid] = useState(p.payid || "");
  const [username, setUsername] = useState(p.username || "");
  const [clubgg, setClubgg] = useState(p.clubgg_handle || "");
  const [role, setRole] = useState(p.role);
  const [active, setActive] = useState(p.active);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");

  const isSelf = me.id === p.id;
  const editableRole = isSuper && p.role !== "superadmin" && !isSelf;
  const editablePerms = isSuper && p.role !== "superadmin";

  async function save() {
    setBusy(true); setErr("");
    try {
      const body = { first_name: first, last_name: last, phone, email, payid, username, clubgg_handle: clubgg, active };
      if (editableRole && role !== p.role) body.role = role;
      await patch(p.id, body);
      onClose();
    } catch (e) { setErr(e.message || "Save failed"); } finally { setBusy(false); }
  }
  async function setPassword() {
    if (!pw || pw.length < 6) { setErr("Temp password must be at least 6 characters."); return; }
    setErr("");
    try { await patch(p.id, { reset_password: pw }); setNote(`Password set: ${pw} — they change it on first login.`); setPw(""); }
    catch (e) { setErr(e.message); }
  }
  async function toggleCap(key) {
    const has = (p.capabilities || []).includes(key);
    const next = has ? p.capabilities.filter((c) => c !== key) : [...(p.capabilities || []), key];
    try { await patch(p.id, { capabilities: next }); } catch (e) { setErr(e.message); }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="row" style={{ marginBottom: 4 }}>
          <h2 style={{ margin: 0 }}>Edit {p.first_name}</h2>
          <button className="right ghost small" onClick={onClose}>✕</button>
        </div>
        <p className="sub" style={{ margin: "0 0 12px" }}>Shown across the app as <strong>{first || p.first_name} [{username || p.username}]</strong></p>

        <div className="grid c2">
          <div><label>First name</label><input value={first} onChange={(e) => setFirst(e.target.value)} /></div>
          <div><label>Last name</label><input value={last} onChange={(e) => setLast(e.target.value)} placeholder="members only" /></div>
          <div><label>Phone</label><input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="members only" /></div>
          <div><label>Email</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="for notifications" /></div>
          <div><label>PayID</label><input value={payid} onChange={(e) => setPayid(e.target.value)} placeholder="phone linked to PayID" /></div>
          <div><label>PokerStars screen name</label><input value={username} onChange={(e) => setUsername(e.target.value)} /></div>
          <div><label>ClubGG name</label><input value={clubgg} onChange={(e) => setClubgg(e.target.value)} placeholder="—" /></div>
        </div>

        <div className="row" style={{ marginTop: 14, gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ width: 150 }}><label>Role</label>
            {editableRole
              ? <select value={role} onChange={(e) => setRole(e.target.value)}><option value="player">Player</option><option value="admin">Admin</option></select>
              : <div style={{ paddingTop: 4 }}><RoleBadge role={p.role} /></div>}
          </div>
          <label className="caprow" style={{ cursor: "pointer", flex: "0 0 auto" }}>
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} style={{ width: "auto" }} />
            <span>Active account</span>
          </label>
        </div>

        <div style={{ marginTop: 16 }}>
          <label>Set a temporary password</label>
          <div className="row" style={{ gap: 6 }}>
            <input value={pw} onChange={(e) => setPw(e.target.value)} placeholder="new temp password" style={{ width: 220 }} />
            <button className="ghost small" onClick={setPassword} disabled={!pw}>Set password</button>
          </div>
        </div>

        {editablePerms && (
          <div style={{ marginTop: 18 }}>
            <label>Permissions</label>
            <p className="sub" style={{ margin: "2px 0 8px" }}>Grant capabilities individually — changes apply immediately.</p>
            <div className="grid c2">
              {catalog.map((c) => {
                const on = (p.capabilities || []).includes(c.key);
                return (
                  <label key={c.key} className="caprow" style={{ cursor: "pointer" }}>
                    <input type="checkbox" checked={on} onChange={() => toggleCap(c.key)} style={{ width: "auto" }} />
                    <span><strong>{c.label}</strong><span className="sub" style={{ display: "block" }}>{c.desc}</span></span>
                  </label>
                );
              })}
            </div>
          </div>
        )}
        {p.role === "superadmin" && <p className="sub" style={{ marginTop: 12 }}>The system administrator holds all permissions.</p>}

        {note && <div className="sub" style={{ color: "var(--pos)", marginTop: 10 }}>{note}</div>}
        {err && <div className="err">{err}</div>}
        <div className="row" style={{ marginTop: 18 }}>
          <button className="ghost small" onClick={onClose}>Close</button>
          <button className="right" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save changes"}</button>
        </div>
      </div>
    </div>
  );
}

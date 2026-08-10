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
  const { player: me } = useAuth();
  const isSuper = me?.role === "superadmin";

  const [players, setPlayers] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [capFor, setCapFor] = useState(null); // player id whose permissions panel is open
  const [resetting, setResetting] = useState({});

  // new member form
  const [name, setName] = useState("");
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
  function flash(m) { setMsg(m); setErr(""); setTimeout(() => setMsg(""), 5000); }

  async function create(e) {
    e.preventDefault(); setErr("");
    try {
      await api.post("/players", { name, username, role, temp_password: pw, clubgg_handle: clubgg });
      flash(`Created ${name} (${role}). Temp password: ${pw} — share it; they change it on first login.`);
      setName(""); setUsername(""); setClubgg(""); setRole("player"); setPw(randPw());
      load();
    } catch (e) { setErr(e.message); }
  }
  async function patch(id, body, okMsg) {
    try { await api.patch(`/players/${id}`, body); if (okMsg) flash(okMsg); load(); }
    catch (e) { setErr(e.message); }
  }
  async function resetPw(id) {
    const value = resetting[id];
    if (!value || value.length < 6) { setErr("Temp password must be at least 6 characters."); return; }
    await patch(id, { reset_password: value }, `Password set: ${value} — they'll change it on first login.`);
    setResetting((s) => { const n = { ...s }; delete n[id]; return n; });
  }
  function toggleCap(p, key) {
    const has = (p.capabilities || []).includes(key);
    const next = has ? p.capabilities.filter((c) => c !== key) : [...(p.capabilities || []), key];
    patch(p.id, { capabilities: next });
  }

  return (
    <>
      <h1>Members</h1>
      <p className="sub" style={{ marginBottom: 16 }}>
        Create accounts and hand out temp passwords.{isSuper ? " As system administrator you can set each member's role and grant capabilities individually — to admins and players alike." : ""}
      </p>

      <div className="card">
        <h2>Add member</h2>
        <form className="row" onSubmit={create} style={{ flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 140 }}><label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} required /></div>
          <div style={{ flex: 1, minWidth: 140 }}><label>Pokerstars screen name</label><input value={username} onChange={(e) => setUsername(e.target.value)} required /></div>
          <div style={{ flex: 1, minWidth: 140 }}><label>ClubGG name</label><input value={clubgg} onChange={(e) => setClubgg(e.target.value)} placeholder="optional" /></div>
          {isSuper && (
            <div style={{ width: 130 }}><label>Role</label>
              <select value={role} onChange={(e) => setRole(e.target.value)}><option value="player">Player</option><option value="admin">Admin</option></select>
            </div>
          )}
          <div style={{ width: 160 }}><label>Temp password</label>
            <div className="row" style={{ gap: 6 }}>
              <input value={pw} onChange={(e) => setPw(e.target.value)} />
              <button type="button" className="ghost small" title="Suggest" onClick={() => setPw(randPw())}>⟳</button>
            </div>
          </div>
          <button style={{ alignSelf: "flex-end" }}>Create</button>
        </form>
        {err && <div className="err">{err}</div>}
        {msg && <div className="sub" style={{ color: "var(--pos)", marginTop: 8 }}>{msg}</div>}
      </div>

      <div className="card">
        <h2>All members</h2>
        <table className="fixed">
          <colgroup>
            <col style={{ width: "16%" }} /><col style={{ width: "13%" }} /><col style={{ width: "14%" }} /><col style={{ width: "12%" }} />
            <col style={{ width: isSuper ? "15%" : "0%" }} /><col style={{ width: "12%" }} /><col style={{ width: "16%" }} />
          </colgroup>
          <thead><tr><th>Name</th><th>Pokerstars screen name</th><th>ClubGG name</th><th>Role</th>{isSuper && <th>Permissions</th>}<th>Status</th><th>Login</th></tr></thead>
          <tbody>
            {players.map((p) => {
              const editableRole = isSuper && p.role !== "superadmin" && p.id !== me.id;
              return (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td className="muted">{p.username}</td>
                  <td>
                    <input defaultValue={p.clubgg_handle || ""} placeholder="—" style={{ width: "100%" }}
                      onBlur={(e) => { const v = e.target.value.trim(); if (v !== (p.clubgg_handle || "")) patch(p.id, { clubgg_handle: v }, "ClubGG name saved."); }} />
                  </td>
                  <td>
                    {editableRole
                      ? <select value={p.role} onChange={(e) => patch(p.id, { role: e.target.value })} style={{ width: 100 }}>
                          <option value="player">Player</option><option value="admin">Admin</option>
                        </select>
                      : <RoleBadge role={p.role} />}
                  </td>
                  {isSuper && (
                    <td>
                      {p.role === "superadmin"
                        ? <span className="muted">all</span>
                        : <button className="small ghost" onClick={() => setCapFor(capFor === p.id ? null : p.id)}>
                            {(p.capabilities || []).length}/{catalog.length} granted
                          </button>}
                    </td>
                  )}
                  <td><span className={"badge " + (p.active ? "ok" : "gray")}>{p.active ? "active" : "inactive"}</span></td>
                  <td>
                    {resetting[p.id] !== undefined ? (
                      <div className="row" style={{ gap: 6 }}>
                        <input value={resetting[p.id]} placeholder="temp password"
                          onChange={(e) => setResetting((s) => ({ ...s, [p.id]: e.target.value }))} style={{ width: 130 }} />
                        <button className="small" onClick={() => resetPw(p.id)}>Save</button>
                      </div>
                    ) : (
                      <button className="small ghost" onClick={() => setResetting((s) => ({ ...s, [p.id]: randPw() }))}>Set password</button>
                    )}
                  </td>
                </tr>
              );
            })}
            {players.length === 0 && <tr><td colSpan={isSuper ? 7 : 6} className="muted">No members.</td></tr>}
          </tbody>
        </table>
      </div>

      {isSuper && capFor && (() => {
        const p = players.find((x) => x.id === capFor);
        if (!p || p.role === "superadmin") return null;
        return (
          <div className="card">
            <div className="row">
              <h2 style={{ margin: 0 }}>Permissions — {p.name}</h2>
              <button className="right small ghost" onClick={() => setCapFor(null)}>Close</button>
            </div>
            <p className="sub" style={{ margin: "6px 0 14px" }}>Toggle each capability on or off. Changes apply immediately.</p>
            <div className="grid c2">
              {catalog.map((c) => {
                const on = (p.capabilities || []).includes(c.key);
                return (
                  <label key={c.key} className="caprow" style={{ cursor: "pointer" }}>
                    <input type="checkbox" checked={on} onChange={() => toggleCap(p, c.key)} style={{ width: "auto" }} />
                    <span>
                      <strong>{c.label}</strong>
                      <span className="sub" style={{ display: "block" }}>{c.desc}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        );
      })()}
    </>
  );
}

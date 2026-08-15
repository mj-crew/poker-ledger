import { useEffect, useState } from "react";
import { api } from "../api";

// Self-service: a player edits their own contact + payment details (not screen names).
export default function AccountDetails() {
  const [me, setMe] = useState(null);
  const [f, setF] = useState({ first_name: "", last_name: "", phone: "", email: "", payid: "" });
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get("/account/me").then((m) => {
      setMe(m);
      setF({ first_name: m.first_name || "", last_name: m.last_name || "", phone: m.phone || "", email: m.email || "", payid: m.payid || "" });
    }).catch((e) => setErr(e.message));
  }, []);

  async function save(e) {
    e.preventDefault(); setErr(""); setMsg(""); setBusy(true);
    try {
      const m = await api.patch("/account/me", f);
      setMe((prev) => ({ ...prev, ...m }));
      setMsg("Details saved."); setTimeout(() => setMsg(""), 4000);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  if (!me) return <><h1>My Account</h1><p className="muted">{err || "Loading…"}</p></>;

  return (
    <>
      <h1>My Account</h1>
      <p className="sub" style={{ marginBottom: 16 }}>Your contact &amp; payment details. Screen names are set by an admin.</p>
      <div className="card">
        <form onSubmit={save}>
          <div className="grid c2">
            <div><label>First name</label><input value={f.first_name} onChange={(e) => setF({ ...f, first_name: e.target.value })} required /></div>
            <div><label>Last name</label><input value={f.last_name} onChange={(e) => setF({ ...f, last_name: e.target.value })} /></div>
            <div><label>Phone</label><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="04xx xxx xxx" /></div>
            <div><label>Email</label><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="for notifications" /></div>
            <div><label>PayID (phone linked to your PayID)</label><input value={f.payid} onChange={(e) => setF({ ...f, payid: e.target.value })} placeholder="04xx xxx xxx" /></div>
            <div><label>PokerStars screen name</label><input value={me.username} disabled /></div>
            <div><label>ClubGG name</label><input value={me.clubgg_handle || ""} disabled placeholder="—" /></div>
          </div>
          <div className="row" style={{ marginTop: 16 }}>
            <button disabled={busy}>{busy ? "Saving…" : "Save details"}</button>
          </div>
          {err && <div className="err">{err}</div>}
          {msg && <div className="sub" style={{ color: "var(--pos)", marginTop: 8 }}>{msg}</div>}
        </form>
      </div>
    </>
  );
}

import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth.jsx";

export default function ChangePassword() {
  const { player, update } = useAuth();
  const nav = useNavigate();
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  if (!player) return <Navigate to="/login" replace />;

  async function submit(e) {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      await api.post("/auth/change-password", { current_password: cur, new_password: next });
      update({ ...player, must_change_password: false });
      nav("/");
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="center">
      <form className="card authcard" onSubmit={submit}>
        <h1 style={{ fontSize: 18 }}>Set a new password</h1>
        <p className="sub" style={{ marginBottom: 16 }}>You're using a temporary password. Choose your own to continue.</p>
        <div className="field">
          <label>Current (temporary) password</label>
          <input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label>New password (min 6 chars)</label>
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} />
        </div>
        {err && <div className="err">{err}</div>}
        <button style={{ width: "100%", marginTop: 18 }} disabled={busy}>{busy ? "Saving…" : "Save & continue"}</button>
      </form>
    </div>
  );
}

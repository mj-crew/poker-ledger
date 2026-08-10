import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth.jsx";

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      const p = await login(username.trim(), password);
      nav(p.must_change_password ? "/change-password" : "/");
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="center">
      <form className="card authcard" onSubmit={submit}>
        <div className="brand" style={{ marginBottom: 6, justifyContent: "center" }}>
          <img className="brand-logo" src="/logo.png" alt="" style={{ height: 44 }} onError={(e) => { e.currentTarget.style.display = "none"; }} />
          <span className="brand-name" style={{ fontSize: 18 }}>Flawless Poker <span className="suit">9♦&nbsp;4♦</span></span>
        </div>
        <p className="sub" style={{ marginBottom: 18 }}>Sign in to the ledger</p>
        <div className="field">
          <label>Username</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
        </div>
        <div className="field">
          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </div>
        {err && <div className="err">{err}</div>}
        <button style={{ width: "100%", marginTop: 18 }} disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        <div style={{ textAlign: "center", marginTop: 12 }}>
          <button type="button" className="linkbtn" onClick={() => setShowHelp((v) => !v)}>Forgot password?</button>
        </div>
        {showHelp && (
          <p className="sub" style={{ marginTop: 8, textAlign: "center" }}>
            Ask an admin to reset it for you — they’ll set a new temporary password from
            <strong> Members → Set password</strong>, and you choose your own on next login.
          </p>
        )}
      </form>
    </div>
  );
}

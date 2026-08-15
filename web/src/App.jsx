import { Routes, Route, Navigate, NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "./auth.jsx";
import Login from "./pages/Login.jsx";
import ChangePassword from "./pages/ChangePassword.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import MyAccount from "./pages/MyAccount.jsx";
import AccountDetails from "./pages/AccountDetails.jsx";
import Stats from "./pages/Stats.jsx";
import Results from "./pages/Results.jsx";
import Expenses from "./pages/Expenses.jsx";
import AdminTournaments from "./pages/AdminTournaments.jsx";
import AdminSettlement from "./pages/AdminSettlement.jsx";
import AdminMembers from "./pages/AdminMembers.jsx";
import Settings from "./pages/Settings.jsx";

const NIGHTS_CAPS = ["nights.manage", "tournaments.live", "results.enter"];
const SETTLE_CAPS = ["settlement.lock", "settlement.reset", "settlement.settle"];

function roleLabel(role) {
  return role === "superadmin" ? "system admin" : role;
}

function Nav() {
  const { player, logout, canAny, viewAsPlayer, setViewMode, isSuperadmin, acting } = useAuth();
  const nav = useNavigate();
  return (
    <div className="nav">
      <div className="brand">
        <img className="brand-logo" src="/logo.png" alt="" onError={(e) => { e.currentTarget.style.display = "none"; }} />
        <span className="brand-name">Flawless Poker <span className="suit">9♦&nbsp;4♦</span></span>
      </div>
      <NavLink to="/" end>Dashboard</NavLink>
      <NavLink to="/account">My Balance</NavLink>
      <NavLink to="/results">Results</NavLink>
      <NavLink to="/stats">My Stats</NavLink>
      <NavLink to="/my-account">My Account</NavLink>
      <NavLink to="/expenses">Expenses</NavLink>
      {canAny(...NIGHTS_CAPS) && <NavLink to="/admin/tournaments">Tournaments</NavLink>}
      {canAny(...SETTLE_CAPS) && <NavLink to="/admin/settlement">Settlement</NavLink>}
      {canAny("members.manage") && <NavLink to="/admin/members">Members</NavLink>}
      {canAny("settings.manage") && <NavLink to="/settings">Settings</NavLink>}
      <div className="spacer" />
      {isSuperadmin && !acting && (
        <button className={"viewtoggle" + (viewAsPlayer ? " on" : "")} onClick={() => setViewMode(!viewAsPlayer)}
          title="Preview the app as a regular player (admin controls only — your real access is unchanged)">
          {viewAsPlayer ? "👁 Player view" : "🛡 Admin view"}
        </button>
      )}
      <span className="who">{player?.name}{acting ? " · acting as" : viewAsPlayer ? " · player view" : (player?.role !== "player" ? ` · ${roleLabel(player?.role)}` : "")}</span>
      <button className="ghost small" onClick={() => { logout(); nav("/login"); }}>Log out</button>
    </div>
  );
}

function Protected({ children, need }) {
  const { player, canAny, viewAsPlayer, setViewMode, isSuperadmin, acting, stopActAs } = useAuth();
  if (!player) return <Navigate to="/login" replace />;
  if (player.must_change_password) return <Navigate to="/change-password" replace />;
  if (need && !canAny(...need)) return <Navigate to="/" replace />;
  return (
    <>
      <Nav />
      <div className="wrap">
        {acting && (
          <div className="actbanner">
            🎭 You are acting as <strong>&nbsp;{player?.name}&nbsp;</strong> — you see their data, and anything you do is recorded as them.
            <button className="linkbtn" style={{ marginLeft: 8 }} onClick={stopActAs}>Return to my account</button>
          </div>
        )}
        {isSuperadmin && !acting && viewAsPlayer && (
          <div className="viewbanner">
            👁 Previewing as a regular player — admin tabs and controls are hidden.
            <button className="linkbtn" style={{ marginLeft: 8 }} onClick={() => setViewMode(false)}>Back to admin view</button>
          </div>
        )}
        {children}
      </div>
    </>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/change-password" element={<ChangePassword />} />
      <Route path="/" element={<Protected><Dashboard /></Protected>} />
      <Route path="/account" element={<Protected><MyAccount /></Protected>} />
      <Route path="/stats" element={<Protected><Stats /></Protected>} />
      <Route path="/my-account" element={<Protected><AccountDetails /></Protected>} />
      <Route path="/results" element={<Protected><Results /></Protected>} />
      <Route path="/expenses" element={<Protected><Expenses /></Protected>} />
      <Route path="/admin" element={<Navigate to="/admin/tournaments" replace />} />
      <Route path="/admin/tournaments" element={<Protected need={NIGHTS_CAPS}><AdminTournaments /></Protected>} />
      <Route path="/admin/settlement" element={<Protected need={SETTLE_CAPS}><AdminSettlement /></Protected>} />
      <Route path="/admin/members" element={<Protected need={["members.manage"]}><AdminMembers /></Protected>} />
      <Route path="/settings" element={<Protected need={["settings.manage"]}><Settings /></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

import { createContext, useContext, useState, useEffect } from "react";
import { api, getToken } from "./api";

const Ctx = createContext(null);

export function AuthProvider({ children }) {
  const [player, setPlayer] = useState(() =>
    JSON.parse(localStorage.getItem("pl_player") || "null")
  );
  // System-admin preview: when on, the UI behaves as a plain player (admin tabs
  // and controls hidden). Real backend permissions are unchanged — this only
  // gates the frontend, so it's a safe way to test the player experience.
  const [viewAsPlayer, setViewAsPlayer] = useState(() => localStorage.getItem("pl_view_as_player") === "1");
  function setViewMode(v) {
    localStorage.setItem("pl_view_as_player", v ? "1" : "0");
    setViewAsPlayer(v);
  }

  // Refresh role + capabilities from the server on load, so changes the system
  // administrator makes take effect without the user logging out and back in.
  useEffect(() => {
    if (getToken()) api.get("/auth/me").then((me) => update({ ...player, ...me })).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Heartbeat so "currently logged in" stays fresh (refreshes last_seen server-side).
  useEffect(() => {
    const t = setInterval(() => { if (getToken()) api.get("/auth/ping").catch(() => {}); }, 60000);
    return () => clearInterval(t);
  }, []);

  async function login(username, password) {
    const { token, player } = await api.post("/auth/login", { username, password });
    localStorage.setItem("pl_token", token);
    localStorage.setItem("pl_player", JSON.stringify(player));
    setPlayer(player);
    return player;
  }

  function logout() {
    localStorage.removeItem("pl_token");
    localStorage.removeItem("pl_player");
    localStorage.removeItem("pl_view_as_player");
    setViewAsPlayer(false);
    setPlayer(null);
  }

  function update(p) {
    localStorage.setItem("pl_player", JSON.stringify(p));
    setPlayer(p);
  }

  // Capability check used to gate UI. Superadmin holds everything — unless they've
  // switched to player preview, in which case they see what a plain player sees.
  function can(cap) {
    if (!player) return false;
    if (viewAsPlayer) return false;
    if (player.role === "superadmin") return true;
    return Array.isArray(player.capabilities) && player.capabilities.includes(cap);
  }
  const canAny = (...caps) => caps.some((c) => can(c));
  // Real role, ignoring preview — used to decide who may toggle the preview.
  const isSuperadmin = player?.role === "superadmin";

  return (
    <Ctx.Provider value={{ player, login, logout, update, can, canAny, viewAsPlayer, setViewMode, isSuperadmin }}>{children}</Ctx.Provider>
  );
}

export const useAuth = () => useContext(Ctx);

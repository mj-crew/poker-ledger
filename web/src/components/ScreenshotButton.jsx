import { useState, useEffect } from "react";
import { api, fileToImagePart } from "../api";

// Upload a screenshot → Claude vision → structured data handed to onResult.
// Two ways in: click the button and Ctrl+V a screenshot straight off the
// clipboard (Win+Shift+S on Windows, Cmd+Ctrl+Shift+4 on macOS), or use the
// small "file…" link to browse. kind: "setup" | "entries" | "results".
export default function ScreenshotButton({ kind, tournamentId, label = "📷 Upload screenshot", onResult }) {
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false); // focused → listening for a paste
  const [err, setErr] = useState("");

  async function ingest(file) {
    if (!file) return;
    setBusy(true); setErr(""); setArmed(false);
    try {
      const { media_type, data } = await fileToImagePart(file);
      const res = await api.post("/vision/ingest", { kind, media_type, image_base64: data, tournament_id: tournamentId });
      onResult(res);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  function pick(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    ingest(file);
  }

  // While this button holds focus, grab the first image pasted anywhere on the
  // page. Focus is unique, so only one ScreenshotButton is ever armed at once.
  useEffect(() => {
    if (!armed || busy) return;
    function onPaste(e) {
      const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
      if (!item) { setErr("No image on the clipboard — take a screenshot first."); return; }
      e.preventDefault();
      ingest(item.getAsFile());
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [armed, busy]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <span className="row" style={{ gap: 8, display: "inline-flex", alignItems: "center" }}>
      <button
        type="button"
        className={"filebtn small" + (busy ? " disabled" : "") + (armed ? " armed" : "")}
        disabled={busy}
        onFocus={() => setArmed(true)}
        onBlur={() => setArmed(false)}
        title="Click, then press Ctrl+V to paste a screenshot"
      >
        {busy ? "Reading…" : armed ? "⌨ Press Ctrl+V to paste…" : label}
      </button>
      <label className="filelink" title="Choose an image file instead">
        file…
        <input type="file" accept="image/*" onChange={pick} disabled={busy} style={{ display: "none" }} />
      </label>
      {err && <span className="err" style={{ margin: 0 }}>{err}</span>}
    </span>
  );
}

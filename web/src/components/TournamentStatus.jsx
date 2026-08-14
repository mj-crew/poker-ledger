// Time-aware tournament status for the live dashboard.
//   before start:            Rego Open   + "Starts in mm:ss"
//   started, late reg open:  Running     + "Rego closes in mm:ss"
//   late reg over:           Rego Closed (red)
//   finalized:               Completed
// Falls back to the manual rego_open toggle when no start time is set.

export function fmtCountdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function stateOf(t, now) {
  if (t.phase === "completed" || t.status === "finalized") return { key: "completed", label: "Completed" };
  if (t.status === "reconciled") return { key: "rego_closed", label: "Rego Closed" };
  const start = t.starts_at ? new Date(t.starts_at).getTime() : null;
  const close = t.late_reg_close ? new Date(t.late_reg_close).getTime() : null;
  if (start) {
    if (now < start) return { key: "rego_open", label: "Rego Open", cdLabel: "Starts in", cdTo: start };
    if (close && now < close) return { key: "running", label: "Running", cdLabel: "Rego closes in", cdTo: close };
    if (close) return { key: "rego_closed", label: "Rego Closed" };
    return { key: "running", label: "Running" };
  }
  return t.rego_open ? { key: "rego_open", label: "Rego Open" } : { key: "rego_closed", label: "Rego Closed" };
}

export default function TournamentStatus({ t, now = Date.now() }) {
  const s = stateOf(t, now);
  return (
    <span className="row" style={{ gap: 6, display: "inline-flex", flexWrap: "wrap" }}>
      <span className={"lifepill " + s.key}><span className="d" />{s.label}</span>
      {s.cdTo && <span className="lifepill countdown">{s.cdLabel} {fmtCountdown(s.cdTo - now)}</span>}
    </span>
  );
}

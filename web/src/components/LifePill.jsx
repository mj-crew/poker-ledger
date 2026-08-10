// Tournament lifecycle pill: Rego Open → Rego Closed → Completed.
const LABELS = { rego_open: "Rego Open", rego_closed: "Rego Closed", completed: "Completed" };

// Derive the phase from a tournament record (used where /live's `phase` isn't present).
export function phaseOf(t) {
  if (t.status === "finalized") return "completed";
  if (t.status === "live" && t.rego_open) return "rego_open";
  if (t.status === "live" || t.status === "reconciled") return "rego_closed";
  return null; // draft — no pill
}

export default function LifePill({ phase }) {
  if (!phase) return null;
  return (
    <span className={"lifepill " + phase}>
      <span className="d" />
      {LABELS[phase] || phase}
    </span>
  );
}

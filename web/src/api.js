// Tiny fetch client. Token in localStorage; 401 bounces to /login.
const BASE = import.meta.env.VITE_API_URL || "";

export function getToken() {
  return localStorage.getItem("pl_token");
}

async function req(method, path, body) {
  const res = await fetch(BASE + "/api" + path, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(getToken() ? { authorization: "Bearer " + getToken() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    localStorage.removeItem("pl_token");
    localStorage.removeItem("pl_player");
    if (!location.pathname.startsWith("/login")) location.href = "/login";
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
  return data;
}

export const api = {
  get: (p) => req("GET", p),
  post: (p, b) => req("POST", p, b),
  put: (p, b) => req("PUT", p, b),
  patch: (p, b) => req("PATCH", p, b),
  del: (p) => req("DELETE", p),
};

// Human status of a settlement transfer from its two milestones. Shared by the
// Dashboard, Settlement and My Account tables so the wording matches everywhere.
export function transferStatus(t) {
  if (t.receiver_confirmed_at) return { cls: "ok", text: "Payment Cleared" };
  if (t.payer_marked_at) return { cls: "pend", text: "Awaiting Receipt Confirmation" };
  return { cls: "live", text: "Awaiting Payment" };
}

// Money helpers — everything server-side is integer cents.
export const fmt = (cents) =>
  (cents < 0 ? "-$" : "$") +
  Math.abs(cents / 100).toLocaleString("en-AU", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

// Read an image File into { media_type, data(base64) } for the vision endpoint.
export function fileToImagePart(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const [meta, data] = String(r.result).split(",");
      const m = /data:(.*?);base64/.exec(meta);
      resolve({ media_type: m ? m[1] : file.type, data });
    };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// Date/time helpers — weekday + dd/mm/yyyy, plus hh:mm AM/PM for timestamps.
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function toDate(d) {
  if (d instanceof Date) return d;
  if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const [y, m, day] = d.split("-").map(Number);
    return new Date(y, m - 1, day); // parse date-only as LOCAL, not UTC
  }
  return new Date(d);
}
// "Mon 28/07/2026"
export const fmtDate = (d) => {
  const x = toDate(d);
  return `${WD[x.getDay()]} ${x.toLocaleDateString("en-GB")}`;
};
// "Mon 28/07/2026 3:45 PM"
export const fmtDateTime = (d) => {
  const x = toDate(d);
  return `${fmtDate(x)} ${x.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
};

// Monday–Sunday of the week containing `date`, as "dd/mm/yyyy - dd/mm/yyyy".
export function weekRange(date = new Date()) {
  const day = date.getDay(); // 0=Sun..6=Sat
  const monday = new Date(date);
  monday.setDate(date.getDate() + (day === 0 ? -6 : 1 - day));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const f = (d) => d.toLocaleDateString("en-GB"); // dd/mm/yyyy
  return `${f(monday)} - ${f(sunday)}`;
}

// Parse a YYYY-MM-DD (or ISO) value as a LOCAL date, ignoring any time/zone.
function toLocalDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(s);
}
// Monday (local midnight) of the week containing `d`.
function mondayOf(d) {
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  const day = x.getDay();
  x.setDate(x.getDate() + (day === 0 ? -6 : 1 - day));
  return x;
}
// { start, end } Date objects (local midnight, Mon & Sun) of the week the running
// balances belong to — the week that begins the day AFTER the last settled+reset
// period. If a week was missed, that is a PAST week (already ended) and stays the
// target until it's locked; the current week only becomes the target once the
// previous one is settled. With no prior reset, it's the current calendar week.
export function runningWeekBounds(period) {
  let base = new Date();
  if (period?.balances_reset_at && period?.ends_on) {
    base = new Date(toLocalDate(period.ends_on));
    base.setDate(base.getDate() + 1); // Monday of the week after the last reset
  }
  const start = mondayOf(base);
  const end = new Date(start); end.setDate(start.getDate() + 6);
  return { start, end };
}
export function runningWeekLabel(period) {
  return weekRange(runningWeekBounds(period).start);
}

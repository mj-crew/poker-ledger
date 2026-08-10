// The catalogue of capabilities a System Administrator can grant to an Admin,
// one by one. Superadmins implicitly hold all of them. Players hold none.
// Assigning roles / capabilities themselves is reserved to superadmins and is
// NOT in this list (so an admin can never escalate).
export const CAPABILITIES = [
  { key: "nights.manage",     label: "Create & cancel tournaments",   desc: "Add new tournaments and cancel ones created by mistake." },
  { key: "tournaments.live",  label: "Run live tournaments",          desc: "Open/close registration and update entries during play." },
  { key: "results.enter",     label: "Enter & finalize results",      desc: "Record finishing positions and finalize tournaments." },
  { key: "settlement.lock",   label: "Lock the week",                 desc: "Freeze balances into settlement transfers." },
  { key: "settlement.reset",  label: "Start new week (reset balances)", desc: "Zero everyone's balance to begin a fresh week." },
  { key: "settlement.settle", label: "Mark a week settled",           desc: "Record that a week has been fully paid up." },
  { key: "members.manage",    label: "Manage members",                desc: "Create player accounts and reset their passwords." },
  { key: "settings.manage",   label: "Manage settings",               desc: "Edit the house payout structure." },
];

export const CAPABILITY_KEYS = CAPABILITIES.map((c) => c.key);

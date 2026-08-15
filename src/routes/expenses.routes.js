import { z } from "zod";
import { query } from "../db.js";
import { requireCap, loadActor, actorCan } from "../auth.js";

// Club expenses (deducted from rake). Visible to everyone; only settlement.lock
// holders can add or remove them. Receipts are stored as data: URLs.
export default async function expensesRoutes(app) {
  app.get("/expenses", { preHandler: [app.authenticate] }, async () => {
    const { rows } = await query(
      `SELECT e.id, e.description, e.amount_cents, e.player_id, e.played_on, e.created_at, e.status,
              p.name AS player_name, p.first_name AS player_first,
              (e.receipt_data_url IS NOT NULL) AS has_receipt,
              EXISTS(SELECT 1 FROM settlement_periods sp WHERE sp.status IN ('locked','settled')
                     AND e.played_on BETWEEN sp.starts_on AND sp.ends_on) AS locked
       FROM expenses e LEFT JOIN players p ON p.id = e.player_id
       ORDER BY e.played_on DESC, e.id DESC`
    );
    return rows;
  });

  app.get("/expenses/:id/receipt", { preHandler: [app.authenticate] }, async (req, reply) => {
    const r = (await query("SELECT receipt_data_url FROM expenses WHERE id=$1", [Number(req.params.id)])).rows[0];
    if (!r?.receipt_data_url) return reply.code(404).send({ error: "No receipt" });
    return { receipt_data_url: r.receipt_data_url };
  });

  const body = z.object({
    description: z.string().min(1),
    amount_cents: z.number().int(),
    player_id: z.number().int().nullable().optional(),
    played_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    receipt_data_url: z.string().optional(),
  });
  // Anyone can submit an expense. Admins (settlement.lock) get an approved expense
  // and may claim it for any player; members submit a PENDING one claimed by
  // themselves, for admin approval.
  app.post("/expenses", { preHandler: [app.authenticate] }, async (req, reply) => {
    const b = body.parse(req.body);
    const admin = actorCan(await loadActor(req), "settlement.lock");
    const player_id = admin ? (b.player_id ?? null) : req.user.id;
    const status = admin ? "approved" : "pending";
    const { rows } = await query(
      `INSERT INTO expenses (description, amount_cents, player_id, played_on, receipt_data_url, created_by, status)
       VALUES ($1,$2,$3, COALESCE($4::date, CURRENT_DATE), $5, $6, $7) RETURNING id, status`,
      [b.description, b.amount_cents, player_id, b.played_on ?? null, b.receipt_data_url || null, req.user.id, status]
    );
    return reply.code(201).send(rows[0]);
  });

  // True if the expense's week has already been locked/settled (no more edits).
  async function periodLocked(playedOn) {
    return !!(await query(
      "SELECT 1 FROM settlement_periods WHERE status IN ('locked','settled') AND $1 BETWEEN starts_on AND ends_on LIMIT 1",
      [playedOn]
    )).rows[0];
  }
  async function guardEditable(id, reply) {
    const ex = (await query("SELECT played_on FROM expenses WHERE id=$1", [id])).rows[0];
    if (!ex) { reply.code(404).send({ error: "Not found" }); return false; }
    if (await periodLocked(ex.played_on)) { reply.code(409).send({ error: "This week is locked — expenses can no longer be changed." }); return false; }
    return true;
  }

  // Admin edit (until the week is locked).
  const patchBody = z.object({
    description: z.string().min(1).optional(),
    amount_cents: z.number().int().optional(),
    player_id: z.number().int().nullable().optional(),
    played_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    receipt_data_url: z.string().optional(),
  });
  app.patch("/expenses/:id", { preHandler: [app.authenticate, requireCap("settlement.lock")] }, async (req, reply) => {
    const id = Number(req.params.id);
    const b = patchBody.parse(req.body);
    if (!(await guardEditable(id, reply))) return;
    const cols = { description: b.description, amount_cents: b.amount_cents, player_id: b.player_id, played_on: b.played_on, receipt_data_url: b.receipt_data_url };
    const sets = [], vals = [];
    for (const [k, v] of Object.entries(cols)) if (v !== undefined) { sets.push(`${k}=$${sets.length + 1}`); vals.push(v); }
    if (sets.length) { vals.push(id); await query(`UPDATE expenses SET ${sets.join(",")} WHERE id=$${vals.length}`, vals); }
    return { ok: true };
  });

  app.post("/expenses/:id/approve", { preHandler: [app.authenticate, requireCap("settlement.lock")] }, async (req, reply) => {
    if (!(await guardEditable(Number(req.params.id), reply))) return;
    await query("UPDATE expenses SET status='approved' WHERE id=$1", [Number(req.params.id)]);
    return { ok: true };
  });
  app.post("/expenses/:id/reject", { preHandler: [app.authenticate, requireCap("settlement.lock")] }, async (req, reply) => {
    if (!(await guardEditable(Number(req.params.id), reply))) return;
    await query("UPDATE expenses SET status='rejected' WHERE id=$1", [Number(req.params.id)]);
    return { ok: true };
  });

  app.delete("/expenses/:id", { preHandler: [app.authenticate, requireCap("settlement.lock")] }, async (req, reply) => {
    if (!(await guardEditable(Number(req.params.id), reply))) return;
    await query("DELETE FROM expenses WHERE id=$1", [Number(req.params.id)]);
    return { ok: true };
  });
}

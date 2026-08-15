import { z } from "zod";
import { query } from "../db.js";
import { requireCap } from "../auth.js";

// Club expenses (deducted from rake). Visible to everyone; only settlement.lock
// holders can add or remove them. Receipts are stored as data: URLs.
export default async function expensesRoutes(app) {
  app.get("/expenses", { preHandler: [app.authenticate] }, async () => {
    const { rows } = await query(
      `SELECT e.id, e.description, e.amount_cents, e.player_id, e.played_on, e.created_at,
              p.name AS player_name, p.first_name AS player_first,
              (e.receipt_data_url IS NOT NULL) AS has_receipt
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
  app.post("/expenses", { preHandler: [app.authenticate, requireCap("settlement.lock")] }, async (req, reply) => {
    const b = body.parse(req.body);
    const { rows } = await query(
      `INSERT INTO expenses (description, amount_cents, player_id, played_on, receipt_data_url, created_by)
       VALUES ($1,$2,$3, COALESCE($4::date, CURRENT_DATE), $5, $6) RETURNING id`,
      [b.description, b.amount_cents, b.player_id ?? null, b.played_on ?? null, b.receipt_data_url || null, req.user.id]
    );
    return reply.code(201).send({ id: rows[0].id });
  });

  app.delete("/expenses/:id", { preHandler: [app.authenticate, requireCap("settlement.lock")] }, async (req) => {
    await query("DELETE FROM expenses WHERE id=$1", [Number(req.params.id)]);
    return { ok: true };
  });
}

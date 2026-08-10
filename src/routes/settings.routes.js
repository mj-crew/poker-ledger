import { z } from "zod";
import { query } from "../db.js";
import { requireCap } from "../auth.js";

// House settings. Currently: the default payout structure (tiered_percent).
const tierSchema = z.object({
  min: z.number().int().min(1),
  max: z.number().int().min(1).nullable(),
  places: z.array(z.number().positive()).min(1).max(8),
});
const putBody = z.object({
  // step_cents is legacy (payouts are now exact to the cent); accepted but ignored.
  step_cents: z.number().int().min(1).max(100000).optional(),
  tiers: z.array(tierSchema).min(1),
});

export default async function settingsRoutes(app) {
  // Anyone authed can read it (the Create/Results screens may want to show it too).
  app.get("/payout-structure", { preHandler: [app.authenticate] }, async () => {
    const { rows } = await query(
      "SELECT id, name, payload FROM payout_structures WHERE is_default=TRUE ORDER BY id LIMIT 1"
    );
    return rows[0] || null;
  });

  // Editing is gated by settings.manage (superadmin holds it implicitly).
  app.put("/payout-structure", { preHandler: [app.authenticate, requireCap("settings.manage")] }, async (req, reply) => {
    const b = putBody.parse(req.body);

    const sorted = [...b.tiers].sort((a, b) => a.min - b.min);
    for (let i = 0; i < sorted.length; i++) {
      const t = sorted[i];
      if (t.max !== null && t.max < t.min)
        return reply.code(400).send({ error: `Tier starting at ${t.min}: min can't exceed max (${t.max}).` });
      const sum = t.places.reduce((s, p) => s + p, 0);
      if (Math.round(sum * 100) !== 10000)
        return reply.code(400).send({ error: `Tier ${t.min}–${t.max ?? "+"}: percentages must add up to 100 (got ${sum}).` });
      if (i < sorted.length - 1 && t.max === null)
        return reply.code(400).send({ error: "Only the last (highest) tier can be open-ended." });
      if (i > 0 && sorted[i - 1].max !== null && t.min !== sorted[i - 1].max + 1)
        return reply.code(400).send({ error: `Gap/overlap between tiers ${sorted[i - 1].min}–${sorted[i - 1].max} and ${t.min}–${t.max ?? "+"}.` });
    }
    if (sorted[0].min !== 1) return reply.code(400).send({ error: "The first tier must start at 1." });
    if (sorted[sorted.length - 1].max !== null) return reply.code(400).send({ error: "The highest tier must be open-ended (blank max)." });

    const payload = {
      type: "tiered_percent",
      rounding: "exact_cent_winner_absorbs",
      field_by: "total_entries",
      tiers: sorted.map((t) => ({ min: t.min, max: t.max, places: t.places })),
    };
    const { rows } = await query(
      "UPDATE payout_structures SET payload=$1::jsonb WHERE is_default=TRUE RETURNING id, name, payload",
      [JSON.stringify(payload)]
    );
    if (!rows[0]) return reply.code(404).send({ error: "No default payout structure to update." });
    return rows[0];
  });

  // ClubGG weekly chip allocation (real $ per player, re-allocated each Monday).
  app.get("/settings/clubgg-allocation", { preHandler: [app.authenticate] }, async () => {
    const r = await query("SELECT value_cents FROM app_settings WHERE key='clubgg_allocation_cents'");
    return { allocation_cents: r.rows[0]?.value_cents ?? 200000 };
  });
  const allocBody = z.object({ allocation_cents: z.number().int().min(0).max(100000000) });
  app.put("/settings/clubgg-allocation", { preHandler: [app.authenticate, requireCap("settings.manage")] }, async (req) => {
    const b = allocBody.parse(req.body);
    await query(
      "INSERT INTO app_settings (key, value_cents) VALUES ('clubgg_allocation_cents',$1) ON CONFLICT (key) DO UPDATE SET value_cents=EXCLUDED.value_cents",
      [b.allocation_cents]
    );
    return { allocation_cents: b.allocation_cents };
  });
}

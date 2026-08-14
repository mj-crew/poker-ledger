import { z } from "zod";
import { query } from "../db.js";
import { loadActor, actorCan } from "../auth.js";
import { extractSetup, extractEntries, extractResults, extractClubggBalances } from "../vision.js";

const CAP_FOR = { setup: "nights.manage", entries: "tournaments.live", results: "results.enter", clubgg_balances: "settlement.lock" };
const MEDIA = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export default async function visionRoutes(app) {
  const body = z.object({
    kind: z.enum(["setup", "entries", "results", "clubgg_balances"]),
    image_base64: z.string().min(1),
    media_type: z.enum(MEDIA),
    tournament_id: z.number().int().optional(),
  });

  app.post("/vision/ingest", { preHandler: [app.authenticate] }, async (req, reply) => {
    const b = body.parse(req.body);
    const actor = await loadActor(req);
    if (!actorCan(actor, CAP_FOR[b.kind])) {
      return reply.code(403).send({ error: `Missing permission: ${CAP_FOR[b.kind]}` });
    }
    try {
      if (b.kind === "setup") return await extractSetup(b.image_base64, b.media_type);
      if (b.kind === "clubgg_balances") {
        const parsed = await extractClubggBalances(b.image_base64, b.media_type);
        const roster = (await query(
          `SELECT p.id, p.first_name, lower(p.first_name) AS lf,
                  lower(COALESCE((SELECT max(handle) FROM handle_aliases h WHERE h.player_id=p.id AND h.platform='clubgg'), '')) AS clubgg
           FROM players p WHERE p.active`
        )).rows;
        const updated = [], unmatched = [];
        for (const m of parsed.members || []) {
          const sn = (m.screen_name || "").trim().toLowerCase();
          const al = (m.alias || "").trim().toLowerCase();
          const hit = (sn && roster.find((x) => x.clubgg && x.clubgg === sn)) || (al && roster.find((x) => x.lf === al));
          if (hit && m.chips != null) {
            await query("UPDATE players SET clubgg_interim_cents=$1, clubgg_gg_id=COALESCE($2, clubgg_gg_id) WHERE id=$3",
              [Math.round(m.chips * 100), m.gg_id || null, hit.id]);
            updated.push({ player_id: hit.id, screen_name: m.screen_name, chips: m.chips });
          } else {
            unmatched.push({ screen_name: m.screen_name, alias: m.alias, chips: m.chips });
          }
        }
        return { updated, unmatched, total: (parsed.members || []).length };
      }
      // entries/results need the roster for matching
      const players = (
        await query(
          `SELECT p.id, p.name,
                  COALESCE(array_agg(h.handle) FILTER (WHERE h.handle IS NOT NULL), '{}') AS handles
           FROM players p LEFT JOIN handle_aliases h ON h.player_id=p.id
           WHERE p.active GROUP BY p.id ORDER BY p.id`
        )
      ).rows;
      if (b.kind === "entries") return await extractEntries(b.image_base64, b.media_type, players);
      return await extractResults(b.image_base64, b.media_type, players);
    } catch (e) {
      const code = e.statusCode || 502;
      return reply.code(code).send({ error: e.message || "Couldn't read the screenshot." });
    }
  });
}

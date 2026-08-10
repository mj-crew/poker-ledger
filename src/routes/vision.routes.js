import { z } from "zod";
import { query } from "../db.js";
import { loadActor, actorCan } from "../auth.js";
import { extractSetup, extractEntries, extractResults } from "../vision.js";

const CAP_FOR = { setup: "nights.manage", entries: "tournaments.live", results: "results.enter" };
const MEDIA = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export default async function visionRoutes(app) {
  const body = z.object({
    kind: z.enum(["setup", "entries", "results"]),
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

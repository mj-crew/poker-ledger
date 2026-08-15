import { z } from "zod";
import { query } from "../db.js";
import { hashPassword, requireCap, loadActor, actorCan } from "../auth.js";
import { CAPABILITY_KEYS } from "../capabilities.js";

export default async function playerRoutes(app) {
  // Everyone authed can see the roster (incl. role + capabilities for the admin UI).
  app.get("/", { preHandler: [app.authenticate] }, async () => {
    const { rows } = await query(
      `SELECT p.id, p.name, p.first_name, p.last_name, p.phone, p.email, p.payid, p.username, p.role, p.capabilities, p.active, p.clubgg_balance_cents,
              COALESCE(array_agg(h.handle) FILTER (WHERE h.platform='club' AND h.handle IS NOT NULL), '{}') AS handles,
              MAX(h.handle) FILTER (WHERE h.platform='clubgg') AS clubgg_handle
       FROM players p LEFT JOIN handle_aliases h ON h.player_id=p.id
       GROUP BY p.id ORDER BY p.first_name, p.last_name`
    );
    return rows;
  });

  const createBody = z.object({
    first_name: z.string().min(1),
    last_name: z.string().optional().default(""),
    phone: z.string().optional().default(""),
    email: z.string().optional().default(""),
    payid: z.string().optional().default(""),
    username: z.string().min(1),
    role: z.enum(["admin", "player"]).default("player"),
    temp_password: z.string().min(6),
    club_handle: z.string().optional(),
    clubgg_handle: z.string().optional(),
  });
  // Display label used everywhere except the Members section.
  const label = (first, username) => `${first} [${username}]`;

  // Create an account. members.manage can create players; only the system
  // administrator can create admins.
  app.post("/", { preHandler: [app.authenticate, requireCap("members.manage")] }, async (req, reply) => {
    const b = createBody.parse(req.body);
    if (b.role !== "player" && req.actor.role !== "superadmin")
      return reply.code(403).send({ error: "Only the system administrator can create admins." });
    const exists = await query("SELECT 1 FROM players WHERE lower(username)=lower($1)", [b.username]);
    if (exists.rowCount) return reply.code(409).send({ error: "Username already taken" });
    const hash = await hashPassword(b.temp_password);
    const { rows } = await query(
      `INSERT INTO players (first_name, last_name, phone, email, payid, name, username, role, password_hash, must_change_password)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE) RETURNING id, name, first_name, last_name, phone, email, payid, username, role, capabilities, active`,
      [b.first_name, b.last_name ?? "", b.phone ?? "", b.email ?? "", b.payid ?? "", label(b.first_name, b.username), b.username, b.role, hash]
    );
    const player = rows[0];
    await query(
      "INSERT INTO handle_aliases (player_id, platform, handle) VALUES ($1,'club',$2) ON CONFLICT DO NOTHING",
      [player.id, b.club_handle || b.username]
    );
    if (b.clubgg_handle && b.clubgg_handle.trim())
      await query("INSERT INTO handle_aliases (player_id, platform, handle) VALUES ($1,'clubgg',$2) ON CONFLICT DO NOTHING",
        [player.id, b.clubgg_handle.trim()]);
    return reply.code(201).send(player);
  });

  const patchBody = z.object({
    first_name: z.string().min(1).optional(),
    last_name: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().optional(),
    payid: z.string().optional(),
    username: z.string().min(1).optional(), // PokerStars screen name = login + club handle
    role: z.enum(["superadmin", "admin", "player"]).optional(),
    capabilities: z.array(z.string()).optional(),
    active: z.boolean().optional(),
    reset_password: z.string().min(6).optional(),
    clubgg_handle: z.string().optional(), // "" clears it
  });

  // Update a member. Changing role or capabilities is reserved to the system
  // administrator; active/password resets need members.manage.
  app.patch("/:id", { preHandler: [app.authenticate] }, async (req, reply) => {
    const id = Number(req.params.id);
    const b = patchBody.parse(req.body);
    const actor = await loadActor(req);
    const target = (await query("SELECT id, role, username FROM players WHERE id=$1", [id])).rows[0];
    if (!target) return reply.code(404).send({ error: "Not found" });

    const touchesPermissions = b.role !== undefined || b.capabilities !== undefined;
    // clubgg_handle is member data, not a permission change.
    if (touchesPermissions) {
      if (!actor || actor.role !== "superadmin")
        return reply.code(403).send({ error: "Only the system administrator can change roles or permissions." });
      if (target.role === "superadmin")
        return reply.code(403).send({ error: "The system administrator account can't be modified here." });
      if (target.id === actor.id)
        return reply.code(403).send({ error: "You can't change your own role or permissions." });
    } else if (!actorCan(actor, "members.manage")) {
      return reply.code(403).send({ error: "Missing permission: members.manage" });
    }

    if (b.role !== undefined) {
      // Capabilities are independent of role (players can hold them too), so a
      // role change leaves any granted capabilities untouched.
      await query("UPDATE players SET role=$1 WHERE id=$2", [b.role, id]);
    }
    if (b.capabilities !== undefined) {
      const clean = [...new Set(b.capabilities.filter((c) => CAPABILITY_KEYS.includes(c)))];
      await query("UPDATE players SET capabilities=$1::jsonb WHERE id=$2", [JSON.stringify(clean), id]);
    }
    if (b.username !== undefined && b.username.trim() && b.username.trim() !== target.username) {
      const newU = b.username.trim();
      const taken = await query("SELECT 1 FROM players WHERE lower(username)=lower($1) AND id<>$2", [newU, id]);
      if (taken.rowCount) return reply.code(409).send({ error: "That PokerStars screen name is already taken." });
      await query("UPDATE players SET username=$1 WHERE id=$2", [newU, id]);
      // Keep the club handle (used for screenshot matching) in sync with it.
      await query("DELETE FROM handle_aliases WHERE player_id=$1 AND platform='club'", [id]);
      await query("INSERT INTO handle_aliases (player_id, platform, handle) VALUES ($1,'club',$2)", [id, newU]);
    }
    // Rebuild the display label whenever the name or screen name changes.
    if (b.first_name !== undefined || b.last_name !== undefined || b.username !== undefined) {
      await query(
        "UPDATE players SET first_name=COALESCE($1,first_name), last_name=COALESCE($2,last_name), name=COALESCE($1,first_name) || ' [' || username || ']' WHERE id=$3",
        [b.first_name ?? null, b.last_name ?? null, id]
      );
    }
    if (b.phone !== undefined) await query("UPDATE players SET phone=$1 WHERE id=$2", [b.phone, id]);
    if (b.email !== undefined) await query("UPDATE players SET email=$1 WHERE id=$2", [b.email, id]);
    if (b.payid !== undefined) await query("UPDATE players SET payid=$1 WHERE id=$2", [b.payid, id]);
    if (b.active !== undefined) await query("UPDATE players SET active=$1 WHERE id=$2", [b.active, id]);
    if (b.reset_password) {
      await query("UPDATE players SET password_hash=$1, must_change_password=TRUE WHERE id=$2",
        [await hashPassword(b.reset_password), id]);
    }
    if (b.clubgg_handle !== undefined) {
      await query("DELETE FROM handle_aliases WHERE player_id=$1 AND platform='clubgg'", [id]);
      if (b.clubgg_handle.trim())
        await query("INSERT INTO handle_aliases (player_id, platform, handle) VALUES ($1,'clubgg',$2)", [id, b.clubgg_handle.trim()]);
    }
    const { rows } = await query(
      "SELECT id, name, first_name, last_name, phone, email, payid, username, role, capabilities, active FROM players WHERE id=$1", [id]
    );
    return rows[0];
  });
}

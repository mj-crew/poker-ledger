import { z } from "zod";
import { query } from "../db.js";
import { hashPassword, verifyPassword, requireCap, blockWhileActingAs, isActingAs } from "../auth.js";

export default async function authRoutes(app) {
  const loginBody = z.object({ username: z.string().min(1), password: z.string().min(1) });

  app.post("/login", async (req, reply) => {
    const { username, password } = loginBody.parse(req.body);
    const { rows } = await query(
      "SELECT id, name, username, role, capabilities, password_hash, must_change_password, active FROM players WHERE lower(username)=lower($1)",
      [username]
    );
    const p = rows[0];
    if (!p || !p.active || !(await verifyPassword(password, p.password_hash))) {
      return reply.code(401).send({ error: "Invalid username or password" });
    }
    await query("UPDATE players SET last_login_at=now(), last_seen_at=now() WHERE id=$1", [p.id]);
    const token = app.jwt.sign({ id: p.id, name: p.name, role: p.role }, { expiresIn: "30d" });
    return {
      token,
      player: { id: p.id, name: p.name, username: p.username, role: p.role,
                capabilities: p.capabilities, must_change_password: p.must_change_password },
    };
  });

  // Lightweight heartbeat — the authenticate preHandler refreshes last_seen_at.
  app.get("/ping", { preHandler: [app.authenticate] }, async () => ({ ok: true }));

  app.get("/me", { preHandler: [app.authenticate] }, async (req) => {
    const { rows } = await query(
      "SELECT id, name, username, role, capabilities, must_change_password FROM players WHERE id=$1",
      [req.user.id]
    );
    // While acting as someone, surface who is really driving — and never bounce
    // the admin into that member's forced password change.
    if (isActingAs(req)) {
      return { ...rows[0], must_change_password: false, acting_as: true, act_by_name: req.user.act_by_name };
    }
    return rows[0];
  });

  // Act as another member: mints a token that IS that member (so every existing
  // route returns their data) but records the real admin in `act_by`, which the
  // escalation guards key off. Short-lived, no nesting, and always logged.
  const actAsBody = z.object({ player_id: z.number().int() });

  app.post(
    "/act-as",
    { preHandler: [app.authenticate, blockWhileActingAs, requireCap("members.actas")] },
    async (req, reply) => {
      const { player_id } = actAsBody.parse(req.body);
      if (player_id === req.user.id) return reply.code(400).send({ error: "That's already you" });
      const { rows } = await query(
        "SELECT id, name, username, role, capabilities, active FROM players WHERE id=$1",
        [player_id]
      );
      const t = rows[0];
      if (!t || !t.active) return reply.code(404).send({ error: "Member not found or inactive" });

      await query("INSERT INTO act_as_log (actor_id, target_id) VALUES ($1,$2)", [req.user.id, t.id]);
      const token = app.jwt.sign(
        { id: t.id, name: t.name, role: t.role, act_by: req.user.id, act_by_name: req.user.name },
        { expiresIn: "2h" }
      );
      return {
        token,
        player: { id: t.id, name: t.name, username: t.username, role: t.role, capabilities: t.capabilities,
                  must_change_password: false, acting_as: true, act_by_name: req.user.name },
      };
    }
  );

  const changeBody = z.object({ current_password: z.string().min(1), new_password: z.string().min(6) });

  app.post("/change-password", { preHandler: [app.authenticate, blockWhileActingAs] }, async (req, reply) => {
    const { current_password, new_password } = changeBody.parse(req.body);
    const { rows } = await query("SELECT password_hash FROM players WHERE id=$1", [req.user.id]);
    if (!(await verifyPassword(current_password, rows[0]?.password_hash))) {
      return reply.code(400).send({ error: "Current password is incorrect" });
    }
    await query(
      "UPDATE players SET password_hash=$1, must_change_password=FALSE WHERE id=$2",
      [await hashPassword(new_password), req.user.id]
    );
    return { ok: true };
  });
}

import { z } from "zod";
import { query } from "../db.js";
import { hashPassword, verifyPassword } from "../auth.js";

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
    const token = app.jwt.sign({ id: p.id, name: p.name, role: p.role }, { expiresIn: "30d" });
    return {
      token,
      player: { id: p.id, name: p.name, username: p.username, role: p.role,
                capabilities: p.capabilities, must_change_password: p.must_change_password },
    };
  });

  app.get("/me", { preHandler: [app.authenticate] }, async (req) => {
    const { rows } = await query(
      "SELECT id, name, username, role, capabilities, must_change_password FROM players WHERE id=$1",
      [req.user.id]
    );
    return rows[0];
  });

  const changeBody = z.object({ current_password: z.string().min(1), new_password: z.string().min(6) });

  app.post("/change-password", { preHandler: [app.authenticate] }, async (req, reply) => {
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

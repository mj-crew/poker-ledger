import bcrypt from "bcryptjs";
import { query } from "./db.js";

export function hashPassword(pw) {
  return bcrypt.hash(pw, 10);
}
export function verifyPassword(pw, hash) {
  if (!hash) return Promise.resolve(false);
  return bcrypt.compare(pw, hash);
}

// Fastify preHandlers. `authenticate` verifies the JWT and puts the player on req.user.
export async function authenticate(req, reply) {
  try {
    await req.jwtVerify(); // sets req.user from token payload
  } catch {
    return reply.code(401).send({ error: "Not authenticated" });
  }
}

// Load the acting player's live role + capabilities from the DB (always fresh,
// so a revoked capability takes effect immediately — not on next login).
export async function loadActor(req) {
  if (!req.user) return null;
  const { rows } = await query("SELECT id, role, capabilities, active FROM players WHERE id=$1", [req.user.id]);
  return rows[0] || null;
}

export function actorCan(actor, cap) {
  if (!actor || !actor.active) return false;
  if (actor.role === "superadmin") return true;
  // Admins and players alike can hold individually-granted capabilities.
  return Array.isArray(actor.capabilities) && actor.capabilities.includes(cap);
}

// preHandler factory: allow only if the actor holds `cap` (superadmin always does).
export function requireCap(cap) {
  return async (req, reply) => {
    const actor = await loadActor(req);
    if (!actorCan(actor, cap)) return reply.code(403).send({ error: `Missing permission: ${cap}` });
    req.actor = actor;
  };
}

// preHandler: system administrator only (role/capability management).
export async function requireSuperadmin(req, reply) {
  const actor = await loadActor(req);
  if (!actor || actor.role !== "superadmin") return reply.code(403).send({ error: "System administrator only" });
  req.actor = actor;
}

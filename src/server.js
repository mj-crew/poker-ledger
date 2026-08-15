import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync } from "fs";
import "dotenv/config";

const WEB_DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "dist");

import { authenticate } from "./auth.js";
import { CAPABILITIES } from "./capabilities.js";
import authRoutes from "./routes/auth.routes.js";
import playerRoutes from "./routes/players.routes.js";
import nightRoutes from "./routes/nights.routes.js";
import liveRoutes from "./routes/live.routes.js";
import accountRoutes from "./routes/account.routes.js";
import settlementRoutes from "./routes/settlement.routes.js";
import resultsRoutes from "./routes/results.routes.js";
import visionRoutes from "./routes/vision.routes.js";
import settingsRoutes from "./routes/settings.routes.js";
import expensesRoutes from "./routes/expenses.routes.js";

export function buildServer() {
  // 15 MB body limit so base64-encoded screenshots fit.
  const app = Fastify({ logger: true, bodyLimit: 15 * 1024 * 1024 });

  app.register(cors, {
    origin: (process.env.CORS_ORIGIN || "http://localhost:5173").split(","),
    credentials: true,
  });
  app.register(jwt, { secret: process.env.JWT_SECRET || "dev-secret-change-me" });

  // Tolerate empty-body JSON POSTs (e.g. finalize/confirm/settle send no body).
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    if (!body || body.trim() === "") return done(null, {});
    try { done(null, JSON.parse(body)); }
    catch (e) { e.statusCode = 400; done(e); }
  });

  // Decorator used as a route preHandler.
  app.decorate("authenticate", authenticate);

  app.get("/health", async () => ({ ok: true, service: "poker-ledger" }));
  // The capability catalogue, for the Members admin screen to render toggles.
  app.get("/api/capabilities", { preHandler: [authenticate] }, async () => CAPABILITIES);

  app.register(authRoutes, { prefix: "/api/auth" });
  app.register(playerRoutes, { prefix: "/api/players" });
  app.register(nightRoutes, { prefix: "/api" });
  app.register(liveRoutes, { prefix: "/api" });
  app.register(accountRoutes, { prefix: "/api" });
  app.register(settlementRoutes, { prefix: "/api" });
  app.register(resultsRoutes, { prefix: "/api" });
  app.register(visionRoutes, { prefix: "/api" });
  app.register(settingsRoutes, { prefix: "/api" });
  app.register(expensesRoutes, { prefix: "/api" });

  // In production the same service serves the built front-end (single origin, no
  // CORS). Unknown non-API paths fall back to index.html for client-side routing.
  if (existsSync(WEB_DIST)) {
    app.register(fastifyStatic, { root: WEB_DIST });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url.startsWith("/api")) return reply.code(404).send({ error: "Not found" });
      return reply.sendFile("index.html");
    });
  }

  return app;
}

// Start only when run directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const app = buildServer();
  const port = Number(process.env.PORT || 4000);
  app.listen({ port, host: "0.0.0.0" }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}

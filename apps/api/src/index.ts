import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import { MAX_UPLOAD_BYTES } from "@contestly/shared";
import { ZodError } from "zod";
import { InsufficientFunds } from "@contestly/db";
import { Unauthorized } from "@contestly/auth";
import { authPlugin } from "./auth.js";
import { meRoutes } from "./routes/me.js";
import { usersRoutes } from "./routes/users.js";
import { partiesRoutes } from "./routes/parties.js";
import { walletRoutes } from "./routes/wallet.js";
import { questionsRoutes } from "./routes/questions.js";
import { adminRoutes } from "./routes/admin.js";
import { climbRoutes } from "./routes/climb.js";
import { adminClimbRoutes } from "./routes/adminClimb.js";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

await app.register(cors, { origin: (process.env.WEB_ORIGIN ?? "http://localhost:5173").split(","), credentials: true });
await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
await app.register(authPlugin);
// Source files only (PUT /parties/:id/files): one file, no other fields. The route sets the size cap.
await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES + 1, files: 1, fields: 0 } });

// Allow empty JSON bodies (e.g. POST /users/:id/follow with no payload).
app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
  if (!body || !(body as string).trim()) return done(null, {});
  try { done(null, JSON.parse(body as string)); } catch (e) { done(e as Error); }
});

// Registered before the route plugins so every encapsulated context inherits it.
app.setErrorHandler((err: any, _req, reply) => {
  if (err instanceof ZodError) return reply.code(400).send({ error: "validation", issues: err.issues });
  if (err instanceof Unauthorized) return reply.code(401).send({ error: err.message });
  if (err instanceof InsufficientFunds) return reply.code(402).send({ error: "insufficient_funds" });
  if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message });
  app.log.error(err);
  return reply.code(500).send({ error: "internal" });
});

app.get("/health", async () => ({ ok: true, service: "api", time: new Date().toISOString() }));
await app.register(meRoutes);
await app.register(usersRoutes);
await app.register(partiesRoutes);
await app.register(walletRoutes);
await app.register(questionsRoutes);
await app.register(adminRoutes);
await app.register(climbRoutes);
await app.register(adminClimbRoutes);

const port = Number(process.env.API_PORT ?? 4000);
await app.listen({ port, host: "0.0.0.0" });

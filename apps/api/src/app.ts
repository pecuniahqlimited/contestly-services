import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import { MAX_UPLOAD_BYTES } from "@contestly/shared";
import { ZodError } from "zod";
import { InsufficientFunds } from "@contestly/db";
import { Unauthorized } from "@contestly/auth";
import { authPlugin, type SessionResolver } from "./auth.js";
import { meRoutes } from "./routes/me.js";
import { usersRoutes } from "./routes/users.js";
import { partiesRoutes } from "./routes/parties.js";
import { walletRoutes } from "./routes/wallet.js";
import { questionsRoutes } from "./routes/questions.js";
import { adminRoutes } from "./routes/admin.js";
import { climbRoutes } from "./routes/climb.js";
import { adminClimbRoutes } from "./routes/adminClimb.js";
import { authRoutes } from "./routes/auth.js";
import { onboardingRoutes } from "./routes/onboarding.js";
import { adminUsersRoutes } from "./routes/adminUsers.js";
import { adminPartiesRoutes } from "./routes/adminParties.js";
import { adminQuestionsRoutes } from "./routes/adminQuestions.js";
import { chatsRoutes } from "./routes/chats.js";

export interface AppOptions {
  /** Tests inject how a request becomes a session; the server uses resolveUser (Firebase token or dev header). */
  resolveSession?: SessionResolver;
  /** Tests see every route as it's registered (the admin permission test checks them all). */
  onRoute?: (route: { method: string | string[]; url: string }) => void;
}

/** The API, routes and all, not yet listening. index.ts listens; tests use app.inject(). */
export async function buildApp(opts: AppOptions = {}) {
  // Behind Caddy/Cloudflare set TRUST_PROXY=1 so req.ip (rate limits) is the client, not the proxy.
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, trustProxy: process.env.TRUST_PROXY === "1" });
  if (opts.onRoute) app.addHook("onRoute", opts.onRoute);

  await app.register(cors, { origin: (process.env.WEB_ORIGIN ?? "http://localhost:5173").split(","), credentials: true });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  await app.register(authPlugin, { resolve: opts.resolveSession });
  // Source files only (PUT /parties/:id/files): one file, no other fields. The route sets the size cap.
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES + 1, files: 1, fields: 0 } });

  // Allow empty JSON bodies (e.g. POST /users/:id/follow with no payload).
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (!body || !(body as string).trim()) return done(null, {});
    try { done(null, JSON.parse(body as string)); } catch (e) { done(e as Error); }
  });

  // Sign in with Apple posts its callback as a form.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))));

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
  await app.register(authRoutes);
  await app.register(onboardingRoutes);
  await app.register(adminUsersRoutes);
  await app.register(adminPartiesRoutes);
  await app.register(adminQuestionsRoutes);
  await app.register(chatsRoutes);
  return app;
}

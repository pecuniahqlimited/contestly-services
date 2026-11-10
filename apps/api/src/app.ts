import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import { INVALID_JSON, MAX_UPLOAD_BYTES, RATE_LIMITED } from "@contestly/shared";
import { ZodError } from "zod";
import { InsufficientFunds } from "@contestly/db";
import { Unauthorized } from "@contestly/auth";
import { authPlugin, type SessionResolver } from "./auth.js";
import { actingPlugin } from "./acting.js";
import { httpError } from "./httpError.js";
import { clientIpResolver, trustConfigFromEnv, type TrustConfig } from "./clientIp.js";
import { limitsFromEnv, type Limits } from "./limits.js";
import { publicConfigFromEnv } from "./publicConfig.js";
import { configRoutes } from "./routes/config.js";
import type { PublicEnvConfig } from "@contestly/shared";
import { rateLimited, valkey } from "./redis.js";
import { meRoutes } from "./routes/me.js";
import { notificationsRoutes } from "./routes/notifications.js";
import { usersRoutes } from "./routes/users.js";
import { partiesRoutes } from "./routes/parties.js";
import { walletRoutes } from "./routes/wallet.js";
import { questionsRoutes } from "./routes/questions.js";
import { adminRoutes } from "./routes/admin.js";
import { climbRoutes } from "./routes/climb.js";
import { adminClimbRoutes } from "./routes/adminClimb.js";
import { adminClimbWordsRoutes } from "./routes/adminClimbWords.js";
import { authRoutes } from "./routes/auth.js";
import { onboardingRoutes } from "./routes/onboarding.js";
import { adminUsersRoutes } from "./routes/adminUsers.js";
import { adminAlertsRoutes } from "./routes/adminAlerts.js";
import { adminPartiesRoutes } from "./routes/adminParties.js";
import { adminQuestionsRoutes } from "./routes/adminQuestions.js";
import { adminProvidersRoutes } from "./routes/adminProviders.js";
import { safetyRoutes } from "./routes/safety.js";
import { adminModerationRoutes } from "./routes/adminModeration.js";
import { chatsRoutes } from "./routes/chats.js";
import { crewsRoutes } from "./routes/crews.js";
import { cornersRoutes } from "./routes/corners.js";
import { adminCornersRoutes } from "./routes/adminCorners.js";
import { brandsRoutes } from "./routes/brands.js";
import { imagesRoutes } from "./routes/images.js";
import { adminBrandsRoutes } from "./routes/adminBrands.js";
import { socialRoutes } from "./routes/social.js";
import { challengesRoutes } from "./routes/challenges.js";
import { adminPaymentsRoutes } from "./routes/adminPayments.js";
import { mockCheckoutRoutes, paymentWebhookRoutes } from "./routes/paymentWebhooks.js";
import { assertPaymentsEnv } from "@contestly/payments";
import { partyTemplatesRoutes } from "./routes/partyTemplates.js";
import { adminPartyTemplatesRoutes } from "./routes/adminPartyTemplates.js";
import { queueDistractors, type DistractorSuggester } from "./distractors.js";

export interface AppOptions {
  /** Tests inject how a request becomes a session; the server uses resolveUser (Firebase token or dev header). */
  resolveSession?: SessionResolver;
  /** Tests see every route as it's registered (the admin permission test checks them all). */
  onRoute?: (route: { method: string | string[]; url: string }) => void;
  /** Tests set the limits and the trusted proxies; the server reads them from the environment. */
  limits?: Limits;
  /** GET /config's answer (support contacts); from the environment unless a test passes its own. */
  publicConfig?: PublicEnvConfig;
  trust?: TrustConfig;
  /** Distractor suggestions for host-written questions: the questions service through its queue, unless a test passes its own. */
  distractors?: DistractorSuggester;
}

declare module "fastify" {
  interface FastifyRequest {
    /** The real client address (clientIp.ts): per-IP limits and sign-in use it, never req.ip. */
    clientIp: string;
  }
  interface FastifyInstance {
    /** This app's rate limits (limits.ts), read once at start; routes with their own limits read them here. */
    limits: Limits;
    distractors: DistractorSuggester;
  }
}

/** The API, routes and all, not yet listening. index.ts listens; tests use app.inject(). */
export async function buildApp(opts: AppOptions = {}) {
  // A live payment key outside production refuses to start (ADR 0013).
  assertPaymentsEnv();
  // req.ip stays the socket peer; req.clientIp is the real client (clientIp.ts decides when proxies are trusted).
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  if (opts.onRoute) app.addHook("onRoute", opts.onRoute);
  const resolveClientIp = clientIpResolver(opts.trust ?? trustConfigFromEnv());
  app.decorateRequest("clientIp", "");
  app.addHook("onRequest", async (req) => { req.clientIp = resolveClientIp(req.socket.remoteAddress ?? req.ip, req.headers); });

  await app.register(cors, { origin: (process.env.WEB_ORIGIN ?? "http://localhost:5173").split(","), credentials: true });
  await app.register(authPlugin, { resolve: opts.resolveSession });
  // After the session: the act-as header is refused on routes that don't opt in (ADR 0017).
  await app.register(actingPlugin);
  // After the session is resolved (both preHandler, in registration order): per user when signed in, else per client IP.
  const cfg = opts.limits ?? limitsFromEnv();
  app.decorate("limits", cfg);
  app.decorate("distractors", opts.distractors ?? queueDistractors);
  await app.register(rateLimit, {
    hook: "preHandler",
    timeWindow: "1 minute",
    redis: valkey(),
    nameSpace: "limit:http:",
    keyGenerator: (req) => (req.auth ? `user:${req.auth.user.id}` : `ip:${req.clientIp}`),
    max: (req) => (req.auth ? cfg.userPerMinute : cfg.ipPerMinute),
    errorResponseBuilder: (req, ctx) => rateLimited(RATE_LIMITED, ctx.ttl / 1000, req.auth ? "http:user" : "http:ip"),
  });
  // Source files only (PUT /parties/:id/files): one file, no other fields. The route sets the size cap.
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES + 1, files: 1, fields: 0 } });

  // Allow empty JSON bodies (e.g. POST /corners/:id/follow with no payload). A body that isn't JSON is the client's
  // mistake: 400 invalid_json, never a 500.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (!body || !(body as string).trim()) return done(null, {});
    try { done(null, JSON.parse(body as string)); } catch { done(httpError(400, INVALID_JSON)); }
  });

  // Sign in with Apple posts its callback as a form.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))));

  // Registered before the route plugins so every encapsulated context inherits it.
  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "validation", issues: err.issues });
    if (err instanceof Unauthorized) return reply.code(401).send({ error: err.message });
    if (err instanceof InsufficientFunds) return reply.code(402).send({ error: "insufficient_funds" });
    if (err.statusCode === 429 && err.details?.retryAfterSeconds) {
      reply.header("retry-after", String(err.details.retryAfterSeconds));
      req.log.warn({ limit: err.limit, error: err.message, retryAfterSeconds: err.details.retryAfterSeconds, route: `${req.method} ${req.routeOptions.url}` }, "rate limited");
    }
    if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message, ...(err.details === undefined ? {} : { details: err.details }) });
    app.log.error(err);
    return reply.code(500).send({ error: "internal" });
  });

  app.get("/health", async () => ({ ok: true, service: "api", time: new Date().toISOString() }));
  await app.register(meRoutes);
  await app.register(notificationsRoutes);
  await app.register(usersRoutes);
  await app.register(partiesRoutes);
  await app.register(walletRoutes);
  await app.register(questionsRoutes);
  await app.register(partyTemplatesRoutes);
  await app.register(adminPartyTemplatesRoutes);
  await app.register(adminRoutes);
  await app.register(climbRoutes);
  await app.register(adminClimbRoutes);
  await app.register(adminClimbWordsRoutes);
  await app.register(authRoutes);
  await app.register(onboardingRoutes);
  await app.register(adminUsersRoutes);
  await app.register(adminAlertsRoutes);
  await app.register(adminPartiesRoutes);
  await app.register(adminQuestionsRoutes);
  await app.register(adminProvidersRoutes);
  await app.register(chatsRoutes);
  await app.register(safetyRoutes);
  await app.register(adminModerationRoutes);
  await app.register(crewsRoutes);
  await app.register(socialRoutes);
  await app.register(challengesRoutes);
  await app.register(cornersRoutes);
  await app.register(adminCornersRoutes);
  await app.register(brandsRoutes);
  await app.register(imagesRoutes);
  await app.register(adminBrandsRoutes);
  await app.register(paymentWebhookRoutes);
  await app.register(mockCheckoutRoutes);
  await app.register(adminPaymentsRoutes);
  await app.register(configRoutes, { config: opts.publicConfig ?? publicConfigFromEnv() });
  return app;
}

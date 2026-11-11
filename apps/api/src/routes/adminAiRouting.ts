/**
 * AI routing in the console (ADR 0016, 11 Nov 2026): which profile runs, by the party's stakes. GET the current
 * version with the ceiling it runs under; PUT a new version (logged with a reason; a profile outside
 * AI_ALLOWED_PROFILES is refused, 400 ai_profile_not_allowed); POST …/preview to see what some stakes would run,
 * changing nothing. The questions service and the worker read the config at call time: no restart.
 */
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { allowedProfilesFromEnv, paidCapMicrosFromEnv } from "@contestly/ai";
import { currentAiRouting, db, recordAdminAction, saveAiRouting, users, type AiRoutingRow } from "@contestly/db";
import {
  AI_PROFILE_NOT_ALLOWED, FREE_PROFILE_MODELS, FREE_TIER_LIMITS, PRICED_MODELS, PROVIDER_PRICES, adminAiRoutingBodySchema, adminAiRoutingPreviewBodySchema,
  adminAiRoutingPreviewSchema, adminAiRoutingSchema, maxPrizeKobo, profilesOutside, tierFor, withinCeiling, type AdminAiRouting, type AdminAiRoutingPreview,
} from "@contestly/shared";
import { requireAdmin } from "../auth.js";
import { httpError } from "../httpError.js";

const chat = PRICED_MODELS.filter((m) => PROVIDER_PRICES[m].use === "chat");

/** Fixed per profile: the embedder and the transcriber (env for paid; changing the embedder means re-embedding). */
const fixedModels = (): AdminAiRouting["fixed"] => ({
  mock: { embed: "mock", transcribe: "mock" },
  free: { embed: FREE_PROFILE_MODELS.embed, transcribe: FREE_PROFILE_MODELS.transcribe },
  paid: { embed: process.env.GEMINI_EMBED_MODEL ?? "gemini-embedding-2", transcribe: process.env.GEMINI_TRANSCRIBE_MODEL ?? "gemini-3.5-transcribe" },
});

async function view(row: AiRoutingRow): Promise<AdminAiRouting> {
  const [by] = row.createdByUserId ? await db.select({ id: users.id, handle: users.handle }).from(users).where(eq(users.id, row.createdByUserId)) : [];
  return adminAiRoutingSchema.parse({
    version: row.version, config: row.config, createdAt: row.createdAt.toISOString(), createdBy: by ?? null, reason: row.reason,
    ceiling: { allowed: allowedProfilesFromEnv(), paidCapMicros: paidCapMicrosFromEnv() },
    choices: {
      free: chat.filter((m) => !!FREE_TIER_LIMITS[m]),
      paidGenerate: chat.filter((m) => PROVIDER_PRICES[m].provider === "anthropic"),
      paidCheck: chat,
    },
    fixed: fixedModels(),
  });
}

export async function adminAiRoutingRoutes(app: FastifyInstance) {
  app.get("/admin/ai/routing", async (req) => {
    requireAdmin(req);
    return view(await currentAiRouting());
  });

  app.put("/admin/ai/routing", async (req) => {
    const admin = requireAdmin(req);
    const { config, reason } = adminAiRoutingBodySchema.parse(req.body);
    const outside = profilesOutside(config, allowedProfilesFromEnv());
    if (outside.length) throw httpError(400, AI_PROFILE_NOT_ALLOWED, { profiles: outside, allowed: allowedProfilesFromEnv() });
    const row = await db.transaction(async (tx) => {
      const before = await currentAiRouting(tx);
      const saved = await saveAiRouting(tx, config, admin.id, reason);
      await recordAdminAction(tx, {
        adminUserId: admin.id, action: "config.ai_routing", targetType: "config", targetId: "ai_routing", reason,
        before: { version: before.version, config: before.config }, after: { version: saved.version, config: saved.config },
      });
      return saved;
    });
    return view(row);
  });

  /** What these stakes would run, against the current config or the draft in the body. Changes nothing. */
  app.post("/admin/ai/routing/preview", async (req): Promise<AdminAiRoutingPreview> => {
    requireAdmin(req);
    const body = adminAiRoutingPreviewBodySchema.parse(req.body);
    const config = body.config ?? (await currentAiRouting()).config;
    const prizeKobo = maxPrizeKobo(body.stakes);
    const { index, tier } = tierFor(config, prizeKobo);
    const profile = withinCeiling(tier.profile, allowedProfilesFromEnv());
    const fixed = fixedModels();
    const models = profile === "free" || profile === "paid" ? { ...config.profiles[profile].models, embed: fixed[profile].embed } : null;
    return adminAiRoutingPreviewSchema.parse({
      prizeKobo, tier: { index, upToKobo: tier.upToKobo }, configured: tier.profile, profile, fellBack: profile !== tier.profile,
      models, paidOff: profile === "paid" && paidCapMicrosFromEnv() <= 0,
    });
  });
}


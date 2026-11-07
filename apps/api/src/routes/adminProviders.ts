/**
 * AI providers in the console (ADR 0016): the budget and per-step models (questions config "providers"),
 * edited with a reason and logged, and what the providers cost, per day and per party.
 */
import type { FastifyInstance } from "fastify";
import { aiProfileFromEnv, paidCapMicrosFromEnv } from "@contestly/ai";
import { db, getQuestionsConfig, providerUsage, recordAdminAction, setQuestionsConfig } from "@contestly/db";
import { adminProviderUsageQuerySchema, adminProviderUsageSchema, adminProvidersConfigBodySchema, FREE_PROFILE_MODELS, MICRO_USD_PER_CENT } from "@contestly/shared";
import { requireAdmin } from "../auth.js";

export async function adminProvidersRoutes(app: FastifyInstance) {
  /**
   * The settings, and what's running: the profile (AI_PROFILE, env) and the paid ceiling (AI_PAID_CAP_USD; 0 =
   * paid providers off). The per-step models here apply to the paid profile; the free profile's are fixed.
   */
  app.get("/admin/questions/providers", async (req) => {
    requireAdmin(req);
    return { config: (await getQuestionsConfig()).providers, profile: aiProfileFromEnv(), paidCapMicros: paidCapMicrosFromEnv(), freeModels: FREE_PROFILE_MODELS };
  });

  /** New calls use these at once (each provider reads its model per call); spend already recorded stays. */
  app.put("/admin/questions/providers", async (req) => {
    const admin = requireAdmin(req);
    const { config, reason } = adminProvidersConfigBodySchema.parse(req.body);
    return db.transaction(async (tx) => {
      const current = await getQuestionsConfig(tx);
      const saved = await setQuestionsConfig({ ...current, providers: config }, tx);
      await recordAdminAction(tx, { adminUserId: admin.id, action: "config.question_providers", targetType: "config", targetId: "question_providers", reason, before: current.providers, after: saved.providers });
      return { config: saved.providers };
    });
  });

  app.get("/admin/questions/usage", async (req) => {
    requireAdmin(req);
    const { days } = adminProviderUsageQuerySchema.parse(req.query);
    const [usage, cfg] = await Promise.all([providerUsage(days), getQuestionsConfig()]);
    return adminProviderUsageSchema.parse({
      config: cfg.providers,
      today: { day: usage.today, costMicros: usage.todayMicros, dailyCapMicros: cfg.providers.dailyCents * MICRO_USD_PER_CENT },
      days: usage.days,
      parties: usage.parties,
    });
  });
}

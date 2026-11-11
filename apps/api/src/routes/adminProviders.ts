/**
 * AI providers in the console (ADR 0016): the global caps and the verification batch size (questions config
 * "providers"), edited with a reason and logged, and what the providers cost, per day and per party. Which
 * profile runs, and each profile's models and own caps, are the AI routing (adminAiRouting.ts).
 */
import type { FastifyInstance } from "fastify";
import { paidCapMicrosFromEnv } from "@contestly/ai";
import { db, getQuestionsConfig, providerUsage, recordAdminAction, setQuestionsConfig } from "@contestly/db";
import { adminProviderUsageQuerySchema, adminProviderUsageSchema, adminProvidersConfigBodySchema, MICRO_USD_PER_CENT } from "@contestly/shared";
import { requireAdmin } from "../auth.js";

export async function adminProvidersRoutes(app: FastifyInstance) {
  /** The settings and the paid ceiling (AI_PAID_CAP_USD; 0 = every paid call refused). */
  app.get("/admin/questions/providers", async (req) => {
    requireAdmin(req);
    return { config: (await getQuestionsConfig()).providers, paidCapMicros: paidCapMicrosFromEnv() };
  });

  /** New calls use these at once; spend already recorded stays. */
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

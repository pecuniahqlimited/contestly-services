/**
 * AI providers in the console (ADR 0016): the budget and per-step models (questions config "providers"),
 * edited with a reason and logged, and what the providers cost, per day and per party.
 */
import type { FastifyInstance } from "fastify";
import { db, getQuestionsConfig, providerUsage, recordAdminAction, setQuestionsConfig } from "@contestly/db";
import { adminProviderUsageQuerySchema, adminProviderUsageSchema, adminProvidersConfigBodySchema, MICRO_USD_PER_CENT } from "@contestly/shared";
import { requireAdmin } from "../auth.js";

export async function adminProvidersRoutes(app: FastifyInstance) {
  app.get("/admin/questions/providers", async (req) => {
    requireAdmin(req);
    return { config: (await getQuestionsConfig()).providers };
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

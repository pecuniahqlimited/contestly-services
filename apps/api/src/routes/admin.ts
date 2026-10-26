import type { FastifyInstance } from "fastify";
import { currentEmailConfig, currentOnboardingConfig, db, getPartyConfig, recentEmailSends, recordAdminAction, saveEmailConfig, saveOnboardingConfig, setPartyConfig } from "@contestly/db";
import {
  EMAIL_PROVIDERS, adminActionsQuerySchema, adminActionsResponseSchema, adminEmailSchema, adminOnboardingBodySchema, adminPartyLimitsSchema, adminSessionSchema,
  backupOf, onboardingConfigVersionSchema,
} from "@contestly/shared";
import { requireAdmin } from "../auth.js";
import { actionsView } from "../adminViews.js";
import { toPerson } from "../people.js";
import { senders } from "../email.js";

/** The email page: which provider sends first, which are configured (keys are env, never shown or set here), and the last sends. */
async function emailView() {
  const [cfg, recent] = await Promise.all([currentEmailConfig(), recentEmailSends()]);
  return {
    primary: cfg.primary, backup: backupOf(cfg.primary), version: cfg.version, updatedAt: cfg.createdAt?.toISOString() ?? null,
    providers: EMAIL_PROVIDERS.map((name) => ({ name, configured: !!senders[name] })),
    recent: recent.map((r) => ({ id: r.id, template: r.template, to: r.to, deliveredBy: r.deliveredBy, attempts: r.attempts, at: r.createdAt.toISOString() })),
  };
}

async function onboardingView() {
  const v = await currentOnboardingConfig();
  return onboardingConfigVersionSchema.parse({ version: v.version, config: v.config, createdAt: v.createdAt?.toISOString() ?? null });
}

export async function adminRoutes(app: FastifyInstance) {
  /** The console's gate: 200 for an admin, 403 for anyone else (it signs in with the same email code / Google flow as the app). */
  app.get("/admin/session", async (req) => {
    const admin = requireAdmin(req);
    return adminSessionSchema.parse({ admin: { ...toPerson(admin), email: admin.email } });
  });

  /** The admin log, newest first; ?targetType=&targetId= for one user, party, question or config. */
  app.get("/admin/actions", async (req) => {
    requireAdmin(req);
    return adminActionsResponseSchema.parse({ actions: await actionsView(adminActionsQuerySchema.parse(req.query)) });
  });

  /** The onboarding round's config (wait, timings, reward tiers, shared payouts), current version. */
  app.get("/admin/onboarding", async (req) => {
    requireAdmin(req);
    return onboardingView();
  });

  /** Save a new version; rooms created from now on use it, and GET /onboarding/rewards shows it. */
  app.put("/admin/onboarding", async (req) => {
    const admin = requireAdmin(req);
    const { config, reason } = adminOnboardingBodySchema.parse(req.body);
    const before = await currentOnboardingConfig();
    const saved = await saveOnboardingConfig(config, admin.id);
    await recordAdminAction(db, { adminUserId: admin.id, action: "config.onboarding", targetType: "config", targetId: "onboarding", reason, before: { version: before.version, config: before.config }, after: { version: saved.version, config: saved.config } });
    return onboardingView();
  });

  /** The party limits as stored, quick picks outside their range included (hosts don't see those). */
  app.get("/admin/party-limits", async (req) => {
    requireAdmin(req);
    return { limits: (await getPartyConfig()).limits };
  });

  /** New parties use these from now on; parties already created keep the limits they were made with. */
  app.put("/admin/party-limits", async (req) => {
    const admin = requireAdmin(req);
    const { limits } = adminPartyLimitsSchema.parse(req.body);
    const current = await getPartyConfig();
    const saved = await setPartyConfig({ ...current, limits });
    await recordAdminAction(db, { adminUserId: admin.id, action: "config.party_limits", targetType: "config", targetId: "party_limits", before: current.limits, after: saved.limits });
    return { limits: saved.limits };
  });

  app.get("/admin/email", async (req) => {
    requireAdmin(req);
    return emailView();
  });

  /** Switch the primary provider. A new version; the other provider is the fallback. */
  app.put("/admin/email", async (req) => {
    const admin = requireAdmin(req);
    const { primary } = adminEmailSchema.parse(req.body);
    const before = await currentEmailConfig();
    await saveEmailConfig(primary, admin.id);
    await recordAdminAction(db, { adminUserId: admin.id, action: "config.email", targetType: "config", targetId: "email", before: { primary: before.primary }, after: { primary } });
    return emailView();
  });
}

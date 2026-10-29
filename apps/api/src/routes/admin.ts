import type { FastifyInstance } from "fastify";
import { currentAboutConfig, currentEmailConfig, db, getAccountsConfig, getPartyConfig, recentEmailSends, recordAdminAction, saveAboutConfig, saveEmailConfig, setAccountsConfig, setPartyConfig } from "@contestly/db";
import {
  EMAIL_PROVIDERS, aboutAudienceSchema, adminAccountsConfigBodySchema, aboutConfigSchemaFor, adminAboutBodySchema, adminAboutPreviewResponseSchema, adminAboutPreviewSchema, adminActionsQuerySchema,
  adminActionsResponseSchema, adminEmailSchema, adminPartyLimitsSchema, adminSessionSchema, answerProblems, backupOf, deriveAbout,
} from "@contestly/shared";
import { z } from "zod";
import { requireAdmin } from "../auth.js";
import { actionsView } from "../adminViews.js";
import { toPerson } from "../people.js";
import { senders } from "../email.js";
import { aboutView } from "../about.js";

/** The email page: which provider sends first, which are configured (keys are env, never shown or set here), and the last sends. */
async function emailView() {
  const [cfg, recent] = await Promise.all([currentEmailConfig(), recentEmailSends()]);
  return {
    primary: cfg.primary, backup: backupOf(cfg.primary), version: cfg.version, updatedAt: cfg.createdAt?.toISOString() ?? null,
    providers: EMAIL_PROVIDERS.map((name) => ({ name, configured: !!senders[name] })),
    recent: recent.map((r) => ({ id: r.id, template: r.template, to: r.to, deliveredBy: r.deliveredBy, attempts: r.attempts, at: r.createdAt.toISOString() })),
  };
}

const audienceParam = (params: unknown) => z.object({ audience: aboutAudienceSchema }).parse(params).audience;

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

  /** About you for one audience (person | brand), current version. */
  app.get("/admin/onboarding/about/:audience", async (req) => {
    requireAdmin(req);
    return aboutView(await currentAboutConfig(audienceParam(req.params)));
  });

  /**
   * Save a new version (with a reason). New answers use it from now on; existing users keep the
   * answers and archetype they have, and see the new set only if they edit from Me.
   */
  app.put("/admin/onboarding/about/:audience", async (req) => {
    const admin = requireAdmin(req);
    const audience = audienceParam(req.params);
    const { config, reason } = adminAboutBodySchema.parse(req.body);
    const saved = await db.transaction(async (tx) => {
      const before = await currentAboutConfig(audience, tx);
      const row = await saveAboutConfig(tx, audience, config, admin.id);
      await recordAdminAction(tx, { adminUserId: admin.id, action: "config.onboarding_about", targetType: "config", targetId: `onboarding_about:${audience}`, reason, before: { version: before.version, config: before.config }, after: { version: row.version, config: row.config } });
      return row;
    });
    return aboutView(saved);
  });

  /** How a set of picks maps (lanes, archetype, the totals behind it) against the current set or a draft not saved yet. */
  app.post("/admin/onboarding/about/:audience/preview", async (req) => {
    requireAdmin(req);
    const audience = audienceParam(req.params);
    const { answers, config: draft } = adminAboutPreviewSchema.parse(req.body);
    const config = draft === undefined ? (await currentAboutConfig(audience)).config : aboutConfigSchemaFor(audience).parse(draft);
    return adminAboutPreviewResponseSchema.parse({ ...deriveAbout(audience, config, answers), problems: answerProblems(config, answers) });
  });

  /** Accounts: how long a deleted account's archive is kept (null = forever, the default until the privacy policy sets it). */
  app.get("/admin/accounts-config", async (req) => {
    requireAdmin(req);
    return { config: await getAccountsConfig() };
  });

  /** Set the retention period. The worker's daily job clears archives older than it; logged with a reason. */
  app.put("/admin/accounts-config", async (req) => {
    const admin = requireAdmin(req);
    const { config, reason } = adminAccountsConfigBodySchema.parse(req.body);
    const before = await getAccountsConfig();
    const saved = await setAccountsConfig(config);
    await recordAdminAction(db, { adminUserId: admin.id, action: "config.accounts", targetType: "config", targetId: "accounts", reason, before, after: saved });
    return { config: saved };
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

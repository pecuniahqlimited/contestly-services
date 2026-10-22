import type { FastifyInstance } from "fastify";
import { currentEmailConfig, getPartyConfig, recentEmailSends, saveEmailConfig, setPartyConfig } from "@contestly/db";
import { EMAIL_PROVIDERS, adminEmailSchema, backupOf } from "@contestly/shared";
import { adminPartyLimitsSchema } from "@contestly/shared";
import { requireAdmin } from "../auth.js";
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

export async function adminRoutes(app: FastifyInstance) {
  /** The party limits as stored, quick picks outside their range included (hosts don't see those). */
  app.get("/admin/party-limits", async (req) => {
    requireAdmin(req);
    return { limits: (await getPartyConfig()).limits };
  });

  /** New parties use these from now on; parties already created keep the limits they were made with. */
  app.put("/admin/party-limits", async (req) => {
    requireAdmin(req);
    const { limits } = adminPartyLimitsSchema.parse(req.body);
    const saved = await setPartyConfig({ ...(await getPartyConfig()), limits });
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
    await saveEmailConfig(primary, admin.id);
    return emailView();
  });
}

import type { FastifyInstance } from "fastify";
import { actOnItem, bulkDismiss, db, getSafetyConfig, moderationDetail, moderationItemView, moderationPage, recordAdminAction, releaseHold, setSafetyConfig, topReason } from "@contestly/db";
import { banOrRequestBan } from "@contestly/payments";
import {
  VOICE_PLAYBACK_URL_SECONDS, adminReasonBodySchema, bulkDismissBodySchema, bulkDismissResponseSchema, moderationActionBodySchema, moderationActionResponseSchema, moderationItemDetailSchema, moderationPageSchema, moderationQuerySchema,
  reasonSchema, safetyConfigSchema, type ModerationActionBody,
} from "@contestly/shared";
import { objectStoreFromEnv, type ObjectStore } from "@contestly/storage";
import { z } from "zod";
import { requireAdmin, uuidParam } from "../auth.js";
import { httpError } from "../httpError.js";
import { publishSafety } from "../safetyEvents.js";
import { afterBan } from "../standing.js";

let store: ObjectStore | undefined;
const storage = () => (store ??= objectStoreFromEnv());

const HOUR_MS = 3_600_000;

/**
 * A suspension or ban from the queue: through payments' two-admin rule for payments admins (ADR 0013), with the
 * category the banned screen shows. Returns the request id when it waits for a second admin.
 */
async function banFromItem(adminId: string, subjectId: string, body: ModerationActionBody, category: string): Promise<string | null> {
  const until = body.action === "suspend" ? new Date(Date.now() + body.hours! * HOUR_MS) : null;
  const out = await banOrRequestBan(adminId, subjectId, body.reason, { until, category });
  if ("banRequest" in out) return out.banRequest.id;
  await afterBan(subjectId);
  return null;
}

const safetyConfigBodySchema = z.object({ config: safetyConfigSchema, reason: reasonSchema });

/** The moderation queue (ADR 0014): reports, holds and what admins do about them. Every write is logged with a reason. */
export async function adminModerationRoutes(app: FastifyInstance) {
  /** Most-reported first. Filter by kind, reason and status (open by default). */
  app.get("/admin/moderation", async (req) => {
    requireAdmin(req);
    return moderationPageSchema.parse(await moderationPage(moderationQuerySchema.parse(req.query ?? {})));
  });

  /** One item: the snapshot, every report, the surrounding chat lines, the subject's history, a voice note's transcript and audio. */
  app.get("/admin/moderation/:id", async (req) => {
    requireAdmin(req);
    const { voice, ...detail } = await moderationDetail(uuidParam(req));
    const audio = voice?.objectKey ? await storage().presignGet({ key: voice.objectKey, expiresSeconds: VOICE_PLAYBACK_URL_SECONDS }) : null;
    return moderationItemDetailSchema.parse({
      ...detail,
      voice: voice ? { transcript: voice.transcript, provider: voice.provider, audioUrl: audio?.url ?? null, expiresAt: audio?.expiresAt ?? null } : null,
    });
  });

  /** Dismiss open items by id or by filter (e.g. transcripts nobody reported), with one reason; each is logged. */
  app.post("/admin/moderation/bulk-dismiss", async (req) => {
    const admin = requireAdmin(req);
    const { reason, ...by } = bulkDismissBodySchema.parse(req.body);
    const { events, ...out } = await bulkDismiss(admin.id, by, reason);
    await publishSafety(events);
    return bulkDismissResponseSchema.parse(out);
  });

  /** Dismiss, remove, warn, chat timeout, suspend or ban, with a reason. Reporters hear "action taken" or "reviewed". */
  app.post("/admin/moderation/:id/actions", async (req) => {
    const admin = requireAdmin(req);
    const id = uuidParam(req);
    const body = moderationActionBodySchema.parse(req.body);
    const item = await moderationItemView(id);
    const category = body.category ?? topReason(item);
    let banRequestId: string | null = null;
    if (body.action === "suspend" || body.action === "ban") {
      if (!item.subject) throw httpError(409, "no_subject");
      banRequestId = await banFromItem(admin.id, item.subject.id, body, category);
    }
    const { events } = await actOnItem(admin.id, id, { ...body, category, resolution: banRequestId ? `${body.action}_requested` : undefined });
    await publishSafety(events);
    return moderationActionResponseSchema.parse({ item: await moderationItemView(id), banRequestId });
  });

  /** Undo an automatic hold: the content shows again; the item stays open. */
  app.post("/admin/moderation/:id/release", async (req) => {
    const admin = requireAdmin(req);
    const id = uuidParam(req);
    const { reason } = adminReasonBodySchema.parse(req.body);
    await publishSafety((await releaseHold(admin.id, id, reason)).events);
    return moderationActionResponseSchema.parse({ item: await moderationItemView(id), banRequestId: null });
  });

  /** Hold thresholds, the automatic timeout, and ops' extra name-filter terms. */
  app.get("/admin/safety/config", async (req) => {
    requireAdmin(req);
    return { config: await getSafetyConfig() };
  });
  app.put("/admin/safety/config", async (req) => {
    const admin = requireAdmin(req);
    const { config, reason } = safetyConfigBodySchema.parse(req.body);
    const saved = await db.transaction(async (tx) => {
      const before = await getSafetyConfig(tx);
      const after = await setSafetyConfig(config, tx);
      await recordAdminAction(tx, { adminUserId: admin.id, action: "config.safety", targetType: "config", targetId: "safety", reason, before, after });
      return after;
    });
    return { config: saved };
  });
}

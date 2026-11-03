import type { FastifyInstance } from "fastify";
import { eq, inArray } from "drizzle-orm";
import { cornerOf, currentCornerConfig, db, grantCorner, recordAdminAction, restoreCorner, revokeCorner, saveCornerConfig, users } from "@contestly/db";
import { adminCornerConfigBodySchema, adminCornerConfigSchema, adminCornerGrantSchema, adminCornerViewSchema } from "@contestly/shared";
import { requireAdmin, uuidParam } from "../auth.js";
import { progressOf } from "../corners.js";
import { httpError } from "../httpError.js";
import { personColumns } from "../people.js";

const configView = async () => {
  const c = await currentCornerConfig();
  return adminCornerConfigSchema.parse({ ...c.config, version: c.version, updatedAt: c.createdAt.toISOString() });
};

/** Any host's progress and who counted, who made up N at unlock (or the grant), and a revoke if there was one. */
async function hostView(hostId: string) {
  const [host] = await db.select(personColumns).from(users).where(eq(users.id, hostId));
  if (!host) throw httpError(404, "not_found");
  const [progress, corner] = await Promise.all([progressOf(hostId), cornerOf(db, hostId)]);
  const ids = [...(corner?.unlockContributors ?? []), ...[corner?.revokedByUserId, corner?.grantedByUserId].filter((id): id is string => !!id)];
  const people = new Map((ids.length ? await db.select(personColumns).from(users).where(inArray(users.id, ids)) : []).map((p) => [p.id, p]));
  return adminCornerViewSchema.parse({
    ...progress, host,
    unlockContributors: (corner?.unlockContributors ?? []).map((id) => people.get(id)).filter(Boolean),
    granted: corner?.grantedAt ? { by: people.get(corner.grantedByUserId!), at: corner.grantedAt.toISOString(), reason: corner.grantedReason } : null,
    revoked: corner?.revokedAt ? { by: people.get(corner.revokedByUserId!), at: corner.revokedAt.toISOString(), reason: corner.revokedReason } : null,
  });
}

export async function adminCornersRoutes(app: FastifyInstance) {
  /** The unlock thresholds (P, R, D, N), current version. */
  app.get("/admin/corners/config", async (req) => {
    requireAdmin(req);
    return configView();
  });

  /** Save a new version, with a reason (logged). Unlocked corners keep the version they met. */
  app.put("/admin/corners/config", async (req) => {
    const admin = requireAdmin(req);
    const { config, reason } = adminCornerConfigBodySchema.parse(req.body);
    await db.transaction(async (tx) => {
      const before = await currentCornerConfig(tx);
      const row = await saveCornerConfig(tx, config, admin.id);
      await recordAdminAction(tx, { adminUserId: admin.id, action: "config.corners", targetType: "config", targetId: "corners", reason, before: { version: before.version, config: before.config }, after: { version: row.version, config: row.config } });
    });
    return configView();
  });

  /** Any host's progress (by their user id), with every party and new player that counted or didn't, and why. */
  app.get("/admin/corners/hosts/:id", async (req) => {
    requireAdmin(req);
    return hostView(uuidParam(req));
  });

  /** Grant a corner to a signed-up, unbanned account, whatever its progress (ADR 0012 §4). A reason is required; logged. */
  app.post("/admin/corners/grant", async (req, reply) => {
    const admin = requireAdmin(req);
    const { userId, reason } = adminCornerGrantSchema.parse(req.body);
    const corner = await grantCorner(admin.id, userId, reason);
    return reply.code(201).send(await hostView(corner.ownerUserId));
  });

  /** Revoke an unlocked corner (a farmed unlock): hidden from then on. A reason is required; logged. */
  app.post("/admin/corners/:id/revoke", async (req) => {
    const admin = requireAdmin(req);
    const { reason } = adminCornerConfigBodySchema.pick({ reason: true }).parse(req.body);
    const corner = await revokeCorner(admin.id, uuidParam(req), reason);
    return hostView(corner.ownerUserId);
  });

  /** Undo a revoke, with a reason (logged): unlocked again, its follows and posts as they were. */
  app.post("/admin/corners/:id/restore", async (req) => {
    const admin = requireAdmin(req);
    const { reason } = adminCornerConfigBodySchema.pick({ reason: true }).parse(req.body);
    const corner = await restoreCorner(admin.id, uuidParam(req), reason);
    return hostView(corner.ownerUserId);
  });
}

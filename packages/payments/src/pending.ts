/**
 * Everything waiting for a second admin, in one list (GET /admin/payments/pending): each open two-admin
 * request with who asked, why, when, what it acts on and where to confirm it. Only what the viewer could
 * confirm: their permissions cover it, they didn't ask for it, and it isn't about them.
 */
import { and, eq, inArray } from "drizzle-orm";
import {
  adminBanRequests, adminPermissions, db, invariantAcknowledgments, linkedIssueClearances, owedWaivers, paymentConfigChanges, paymentFinalizations,
  paymentPermissionGrants, payoutContradictions, users,
} from "@contestly/db";
import type { AdminPendingItem, PaymentPermission, PendingRequestKind } from "@contestly/shared";

const OPEN = "awaiting_second_admin";

/** One open request, before the requester's handle is filled in. */
type Row = Omit<AdminPendingItem, "requestedBy" | "requestedAt"> & { requestedById: string; requestedAt: Date; aboutUserId: string | null };

/** Each kind's open requests. Adding a kind adds an entry here (and its name in PENDING_REQUEST_KINDS). */
const SOURCES: Record<PendingRequestKind, () => Promise<Row[]>> = {
  finalization: async () => (await db.select().from(paymentFinalizations).where(eq(paymentFinalizations.status, OPEN))).map((r) => ({
    kind: "finalization", id: r.id, requestedById: r.requestedByUserId, reason: r.reason, requestedAt: r.createdAt, aboutUserId: null,
    target: { type: r.targetType, id: r.targetId }, confirm: { method: "POST", path: `/admin/payments/finalizations/${r.id}/confirm` }, permission: "payments.finalize",
  })),
  owed_waiver: async () => (await db.select().from(owedWaivers).where(eq(owedWaivers.status, OPEN))).map((r) => ({
    kind: "owed_waiver", id: r.id, requestedById: r.requestedByUserId, reason: r.reason, requestedAt: r.createdAt, aboutUserId: r.userId,
    target: { type: "user", id: r.userId }, confirm: { method: "POST", path: `/admin/payments/owed-waivers/${r.id}/confirm` }, permission: "payments.finalize",
  })),
  contradiction_resolution: async () => (await db.select().from(payoutContradictions).where(eq(payoutContradictions.status, OPEN))).map((r) => ({
    kind: "contradiction_resolution", id: r.id, requestedById: r.requestedByUserId!, reason: r.requestReason ?? "", requestedAt: r.requestedAt ?? r.createdAt, aboutUserId: r.userId,
    target: { type: "payout", id: r.payoutId }, confirm: { method: "POST", path: `/admin/payments/contradictions/${r.id}/confirm` }, permission: "payments.finalize",
  })),
  permission_grant: async () => (await db.select().from(paymentPermissionGrants).where(eq(paymentPermissionGrants.status, OPEN))).map((r) => ({
    kind: "permission_grant", id: r.id, requestedById: r.requestedByUserId, reason: r.reason, requestedAt: r.createdAt,
    // A grant's grantee can never confirm it; a revoke of payments.config may be agreed by its holder.
    aboutUserId: r.change === "grant" ? r.userId : null,
    target: { type: "user", id: r.userId }, confirm: { method: "POST", path: `/admin/payments/permission-grants/${r.id}/confirm` }, permission: "payments.config",
  })),
  config_change: async () => (await db.select().from(paymentConfigChanges).where(eq(paymentConfigChanges.status, OPEN))).map((r) => ({
    kind: "config_change", id: r.id, requestedById: r.requestedByUserId, reason: r.reason, requestedAt: r.createdAt, aboutUserId: null,
    target: { type: r.kind, id: r.kind }, confirm: { method: "POST", path: `/admin/payments/config-changes/${r.id}/confirm` }, permission: "payments.config",
  })),
  admin_ban: async () => {
    const rows = await db.select().from(adminBanRequests).where(eq(adminBanRequests.status, OPEN));
    // Banning a payments.config holder takes a confirmer who holds it; any other payments admin, any admin.
    const configHolders = new Set(rows.length ? (await db.select({ id: adminPermissions.userId }).from(adminPermissions)
      .where(and(inArray(adminPermissions.userId, rows.map((r) => r.userId)), eq(adminPermissions.permission, "payments.config")))).map((h) => h.id) : []);
    return rows.map((r): Row => ({
      kind: "admin_ban", id: r.id, requestedById: r.requestedByUserId, reason: r.reason, requestedAt: r.createdAt, aboutUserId: r.userId,
      target: { type: "user", id: r.userId }, confirm: { method: "POST", path: `/admin/users/ban-requests/${r.id}/confirm` },
      permission: configHolders.has(r.userId) ? "payments.config" : null,
    }));
  },
  linked_issue_clearance: async () => (await db.select().from(linkedIssueClearances).where(eq(linkedIssueClearances.status, OPEN))).map((r) => ({
    kind: "linked_issue_clearance", id: r.id, requestedById: r.requestedByUserId, reason: r.reason, requestedAt: r.createdAt, aboutUserId: r.userId,
    target: { type: "user", id: r.userId }, confirm: { method: "POST", path: `/admin/payments/linked-issue-clearances/${r.id}/confirm` }, permission: "payments.finalize",
  })),
  invariant_acknowledgment: async () => (await db.select().from(invariantAcknowledgments).where(eq(invariantAcknowledgments.status, OPEN))).map((r) => ({
    kind: "invariant_acknowledgment", id: r.id, requestedById: r.requestedByUserId, reason: r.reason, requestedAt: r.createdAt, aboutUserId: null,
    target: { type: "invariant", id: r.kind }, confirm: { method: "POST", path: `/admin/payments/invariant-acknowledgments/${r.id}/confirm` }, permission: "payments.config",
  })),
};

/** Open two-admin requests this viewer could confirm, oldest first, optionally of one kind. */
export async function pendingForViewer(viewerId: string, holds: ReadonlySet<PaymentPermission>, kind?: PendingRequestKind): Promise<AdminPendingItem[]> {
  const kinds = kind ? [kind] : (Object.keys(SOURCES) as PendingRequestKind[]);
  const rows = (await Promise.all(kinds.map((k) => SOURCES[k]()))).flat()
    .filter((r) => r.requestedById !== viewerId && r.aboutUserId !== viewerId && (r.permission === null || holds.has(r.permission)))
    .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime());
  const ids = [...new Set(rows.map((r) => r.requestedById))];
  const handles = new Map(ids.length ? (await db.select({ id: users.id, handle: users.handle }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.handle]) : []);
  return rows.map(({ requestedById, aboutUserId: _about, requestedAt, ...r }) => ({ ...r, requestedBy: { id: requestedById, handle: handles.get(requestedById) ?? "" }, requestedAt: requestedAt.toISOString() }));
}

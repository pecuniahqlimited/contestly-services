/**
 * Payment permissions on top of the admin role. Changed per admin (admin_permissions) by an admin holding
 * payments.config, never for themselves; every change logged. Dev sessions (AUTH_MODE=dev) hold all four.
 *
 * Granting is loosening (ADR 0013), so it's maker-checker: a payments.config holder asks, a different one
 * confirms, and the grantee can never confirm their own grant. Otherwise one admin could make a second
 * account pass every second-admin check. Revoking applies at once. Who is an admin at all (ADMIN_EMAILS) is
 * outside this: whoever controls the environment controls that list.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { adminPermissions, db, paymentPermissionGrants, recordAdminAction, users, type PaymentPermissionGrant, type Tx } from "@contestly/db";
import { OWN_TRANSACTION, SECOND_ADMIN_REQUIRED, type PaymentPermission } from "@contestly/shared";
import { paymentsError } from "./common.js";

export async function permissionsOf(userId: string): Promise<PaymentPermission[]> {
  return (await db.select({ p: adminPermissions.permission }).from(adminPermissions).where(eq(adminPermissions.userId, userId))).map((r) => r.p);
}

export async function hasPermission(userId: string, permission: PaymentPermission) {
  return !!(await db.select({ p: adminPermissions.permission }).from(adminPermissions).where(and(eq(adminPermissions.userId, userId), eq(adminPermissions.permission, permission))))[0];
}

const iso = (d: Date | null) => d?.toISOString() ?? null;
export const permissionGrantView = (g: PaymentPermissionGrant) => ({
  id: g.id, userId: g.userId, permissions: g.permissions as PaymentPermission[], reason: g.reason, status: g.status,
  requestedBy: g.requestedByUserId, confirmedBy: g.confirmedByUserId, createdAt: g.createdAt.toISOString(), appliedAt: iso(g.appliedAt),
});

async function currentOf(tx: Tx, userId: string) {
  return (await tx.select({ p: adminPermissions.permission }).from(adminPermissions).where(eq(adminPermissions.userId, userId))).map((r) => r.p).sort();
}

async function lockAdminTarget(tx: Tx, userId: string) {
  const [target] = await tx.select().from(users).where(eq(users.id, userId)).for("no key update");
  if (!target) throw paymentsError(404, "not_found");
  if (!target.isAdmin) throw paymentsError(409, "not_admin");
  return target;
}

/**
 * Set an admin's payment permissions to exactly these. What's removed is removed now; anything added waits
 * for a second payments.config holder (the returned grant). Returns the permissions held now.
 */
export async function setPermissions(byAdminId: string, targetUserId: string, permissions: PaymentPermission[], reason: string) {
  if (byAdminId === targetUserId) throw paymentsError(409, "cannot_change_own_permissions");
  return db.transaction(async (tx) => {
    await lockAdminTarget(tx, targetUserId);
    const before = await currentOf(tx, targetUserId);
    const want = [...new Set(permissions)].sort();
    const revoke = before.filter((p) => !want.includes(p));
    const grant = want.filter((p) => !before.includes(p));
    if (revoke.length) {
      await tx.delete(adminPermissions).where(and(eq(adminPermissions.userId, targetUserId), inArray(adminPermissions.permission, revoke)));
      await recordAdminAction(tx, { adminUserId: byAdminId, action: "payments.permissions", targetType: "user", targetId: targetUserId, reason, before, after: before.filter((p) => !revoke.includes(p)) });
    }
    let pending: ReturnType<typeof permissionGrantView> | null = null;
    if (grant.length) {
      const [open] = await tx.select({ id: paymentPermissionGrants.id }).from(paymentPermissionGrants).where(and(eq(paymentPermissionGrants.userId, targetUserId), eq(paymentPermissionGrants.status, "awaiting_second_admin")));
      if (open) throw paymentsError(409, "grant_pending", { grantId: open.id });
      const [g] = await tx.insert(paymentPermissionGrants).values({ userId: targetUserId, permissions: grant, reason, status: "awaiting_second_admin", requestedByUserId: byAdminId }).returning();
      await recordAdminAction(tx, { adminUserId: byAdminId, action: "payments.permissions_grant_requested", targetType: "user", targetId: targetUserId, reason, before, after: { grant, grantId: g.id } });
      pending = permissionGrantView(g);
    }
    return { permissions: await currentOf(tx, targetUserId), pendingGrant: pending };
  });
}

/** A second payments.config holder confirms a grant: not whoever asked, and never the grantee. */
export async function confirmPermissionGrant(adminUserId: string, grantId: string, now = new Date()) {
  return db.transaction(async (tx) => {
    const [pre] = await tx.select().from(paymentPermissionGrants).where(eq(paymentPermissionGrants.id, grantId));
    if (!pre) throw paymentsError(404, "not_found");
    await lockAdminTarget(tx, pre.userId);
    const [g] = await tx.select().from(paymentPermissionGrants).where(eq(paymentPermissionGrants.id, grantId)).for("update");
    if (g.status !== "awaiting_second_admin") throw paymentsError(409, "grant_not_pending", { status: g.status });
    if (g.requestedByUserId === adminUserId) throw paymentsError(403, SECOND_ADMIN_REQUIRED);
    if (g.userId === adminUserId) throw paymentsError(403, OWN_TRANSACTION);
    const before = await currentOf(tx, g.userId);
    const add = (g.permissions as PaymentPermission[]).filter((p) => !before.includes(p));
    if (add.length) await tx.insert(adminPermissions).values(add.map((permission) => ({ userId: g.userId, permission, grantedByUserId: g.requestedByUserId })));
    const [done] = await tx.update(paymentPermissionGrants).set({ status: "applied", confirmedByUserId: adminUserId, appliedAt: now }).where(eq(paymentPermissionGrants.id, g.id)).returning();
    await recordAdminAction(tx, {
      adminUserId, action: "payments.permissions", targetType: "user", targetId: g.userId, reason: g.reason,
      before, after: await currentOf(tx, g.userId),
    });
    return permissionGrantView(done);
  });
}

export async function listPermissionGrants(limit: number) {
  return (await db.select().from(paymentPermissionGrants).orderBy(desc(paymentPermissionGrants.createdAt)).limit(limit)).map(permissionGrantView);
}

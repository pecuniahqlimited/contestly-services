/**
 * Payment permissions on top of the admin role. Granted per admin (admin_permissions), by an admin holding
 * payments.config, never to themselves; every change logged. Dev sessions (AUTH_MODE=dev) hold all four.
 */
import { and, eq } from "drizzle-orm";
import { adminPermissions, db, recordAdminAction, users } from "@contestly/db";
import type { PaymentPermission } from "@contestly/shared";
import { paymentsError } from "./common.js";

export async function permissionsOf(userId: string): Promise<PaymentPermission[]> {
  return (await db.select({ p: adminPermissions.permission }).from(adminPermissions).where(eq(adminPermissions.userId, userId))).map((r) => r.p);
}

export async function hasPermission(userId: string, permission: PaymentPermission) {
  return !!(await db.select({ p: adminPermissions.permission }).from(adminPermissions).where(and(eq(adminPermissions.userId, userId), eq(adminPermissions.permission, permission))))[0];
}

/** Replace an admin's payment permissions with exactly these. */
export async function setPermissions(byAdminId: string, targetUserId: string, permissions: PaymentPermission[], reason: string) {
  if (byAdminId === targetUserId) throw paymentsError(409, "cannot_change_own_permissions");
  return db.transaction(async (tx) => {
    const [target] = await tx.select().from(users).where(eq(users.id, targetUserId)).for("update");
    if (!target) throw paymentsError(404, "not_found");
    if (!target.isAdmin) throw paymentsError(409, "not_admin");
    const before = (await tx.select({ p: adminPermissions.permission }).from(adminPermissions).where(eq(adminPermissions.userId, targetUserId))).map((r) => r.p).sort();
    const after = [...new Set(permissions)].sort();
    await tx.delete(adminPermissions).where(eq(adminPermissions.userId, targetUserId));
    if (after.length) await tx.insert(adminPermissions).values(after.map((permission) => ({ userId: targetUserId, permission, grantedByUserId: byAdminId })));
    await recordAdminAction(tx, { adminUserId: byAdminId, action: "payments.permissions", targetType: "user", targetId: targetUserId, reason, before, after });
    return after;
  });
}

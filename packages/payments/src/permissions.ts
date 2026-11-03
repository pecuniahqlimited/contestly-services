/**
 * Payment permissions on top of the admin role. Changed per admin (admin_permissions) by an admin holding
 * payments.config, never for themselves; every change logged. Dev sessions (AUTH_MODE=dev) hold all four.
 *
 * Granting is loosening (ADR 0013), so it's maker-checker: a payments.config holder asks, a different one
 * confirms, and the grantee can never confirm their own grant. Otherwise one admin could make a second
 * account pass every second-admin check. Revoking applies at once, except payments.config: taking it from
 * one of the last two holders needs a second admin (the holder themselves may confirm), and the last holder
 * can't lose it at all, so nobody can strip the console of everyone who could un-pause or confirm. Who is an
 * admin at all (ADMIN_EMAILS) is outside this: whoever controls the environment controls that list.
 */
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { adminBanRequests, adminPermissions, banUserIn, db, paymentPermissionGrants, recordAdminAction, users, type AdminBanRequest, type PaymentPermissionGrant, type Tx } from "@contestly/db";
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
  id: g.id, userId: g.userId, change: g.change, permissions: g.permissions as PaymentPermission[], reason: g.reason, status: g.status,
  requestedBy: g.requestedByUserId, confirmedBy: g.confirmedByUserId, createdAt: g.createdAt.toISOString(), appliedAt: iso(g.appliedAt),
});

async function currentOf(tx: Tx, userId: string) {
  return (await tx.select({ p: adminPermissions.permission }).from(adminPermissions).where(eq(adminPermissions.userId, userId))).map((r) => r.p).sort();
}

/** Serialises every permission change, so two revocations can't both see two config holders. */
const lockPermissions = (tx: Tx) => tx.execute(sql`select pg_advisory_xact_lock(hashtext('payments_permissions'))`);
/** Admins holding payments.config who can still act: not deleted, not banned. */
async function configHolders(tx: Tx) {
  const [{ n }] = await tx.select({ n: count() }).from(adminPermissions).innerJoin(users, eq(users.id, adminPermissions.userId))
    .where(and(eq(adminPermissions.permission, "payments.config"), eq(users.isAdmin, true), isNull(users.deletedAt), isNull(users.bannedAt)));
  return Number(n);
}
const CONFIG = "payments.config";

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
    await lockPermissions(tx);
    await lockAdminTarget(tx, targetUserId);
    const before = await currentOf(tx, targetUserId);
    const want = [...new Set(permissions)].sort();
    let revoke = before.filter((p) => !want.includes(p));
    const grant = want.filter((p) => !before.includes(p));
    // payments.config: never from the last holder; from one of the last two, only with a second admin.
    let pendingRevoke = false;
    if (revoke.includes(CONFIG)) {
      const after = (await configHolders(tx)) - 1;
      if (after < 1) throw paymentsError(409, "last_config_holder");
      if (after < 2) { revoke = revoke.filter((p) => p !== CONFIG); pendingRevoke = true; }
    }
    if (pendingRevoke && grant.length) throw paymentsError(409, "one_change_at_a_time", { message: "revoke payments.config and grant the rest in two steps" });
    if (revoke.length) {
      await tx.delete(adminPermissions).where(and(eq(adminPermissions.userId, targetUserId), inArray(adminPermissions.permission, revoke)));
      await recordAdminAction(tx, { adminUserId: byAdminId, action: "payments.permissions", targetType: "user", targetId: targetUserId, reason, before, after: before.filter((p) => !revoke.includes(p)) });
    }
    let pending: ReturnType<typeof permissionGrantView> | null = null;
    if (pendingRevoke) {
      const [open] = await tx.select({ id: paymentPermissionGrants.id }).from(paymentPermissionGrants).where(and(eq(paymentPermissionGrants.userId, targetUserId), eq(paymentPermissionGrants.status, "awaiting_second_admin")));
      if (open) throw paymentsError(409, "grant_pending", { grantId: open.id });
      const [g] = await tx.insert(paymentPermissionGrants).values({ userId: targetUserId, change: "revoke", permissions: [CONFIG], reason, status: "awaiting_second_admin", requestedByUserId: byAdminId }).returning();
      await recordAdminAction(tx, { adminUserId: byAdminId, action: "payments.permissions_revoke_requested", targetType: "user", targetId: targetUserId, reason, before, after: { revoke: [CONFIG], grantId: g.id } });
      pending = permissionGrantView(g);
    }
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

/**
 * A second payments.config holder confirms: never whoever asked. A grant: never the grantee. A revoke of
 * payments.config: the holder themselves may agree to it, and it still never leaves nobody holding it.
 */
export async function confirmPermissionGrant(adminUserId: string, grantId: string, now = new Date()) {
  return db.transaction(async (tx) => {
    await lockPermissions(tx);
    const [pre] = await tx.select().from(paymentPermissionGrants).where(eq(paymentPermissionGrants.id, grantId));
    if (!pre) throw paymentsError(404, "not_found");
    await lockAdminTarget(tx, pre.userId);
    const [g] = await tx.select().from(paymentPermissionGrants).where(eq(paymentPermissionGrants.id, grantId)).for("update");
    if (g.status !== "awaiting_second_admin") throw paymentsError(409, "grant_not_pending", { status: g.status });
    if (g.requestedByUserId === adminUserId) throw paymentsError(403, SECOND_ADMIN_REQUIRED);
    if (g.change === "grant" && g.userId === adminUserId) throw paymentsError(403, OWN_TRANSACTION);
    const before = await currentOf(tx, g.userId);
    if (g.change === "revoke") {
      if (before.includes(CONFIG) && (await configHolders(tx)) - 1 < 1) throw paymentsError(409, "last_config_holder");
      await tx.delete(adminPermissions).where(and(eq(adminPermissions.userId, g.userId), eq(adminPermissions.permission, CONFIG)));
    }
    const add = g.change === "grant" ? (g.permissions as PaymentPermission[]).filter((p) => !before.includes(p)) : [];
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

// ---- Banning a payments admin: two admins ----

const banRequestView = (b: AdminBanRequest) => ({
  id: b.id, userId: b.userId, reason: b.reason, status: b.status, requestedBy: b.requestedByUserId, confirmedBy: b.confirmedByUserId,
  createdAt: b.createdAt.toISOString(), appliedAt: iso(b.appliedAt),
});

/** Whether a ban of this account needs a second admin: it holds any payments permission. */
export async function holdsPaymentPermission(userId: string) {
  return (await permissionsOf(userId)).length > 0;
}

/** Ask to ban an admin who holds payments permissions. Nothing changes until a different admin confirms. */
export async function requestPaymentsAdminBan(adminUserId: string, userId: string, reason: string) {
  if (adminUserId === userId) throw paymentsError(409, "cannot_ban_self");
  return db.transaction(async (tx) => {
    const [target] = await tx.select().from(users).where(eq(users.id, userId)).for("no key update");
    if (!target || target.isSystem) throw paymentsError(404, "not_found");
    const [open] = await tx.select({ id: adminBanRequests.id }).from(adminBanRequests).where(and(eq(adminBanRequests.userId, userId), eq(adminBanRequests.status, "awaiting_second_admin")));
    if (open) throw paymentsError(409, "ban_pending", { banRequestId: open.id });
    const [b] = await tx.insert(adminBanRequests).values({ userId, reason, status: "awaiting_second_admin", requestedByUserId: adminUserId }).returning();
    await recordAdminAction(tx, { adminUserId, action: "user.ban_requested", targetType: "user", targetId: userId, reason, before: null, after: { banRequestId: b.id, permissions: await currentOf(tx, userId) } });
    return banRequestView(b);
  });
}

/** A second admin confirms: not whoever asked, not the admin being banned. The ban is main's banUserIn, in this transaction. */
export async function confirmPaymentsAdminBan(adminUserId: string, banRequestId: string, now = new Date()) {
  return db.transaction(async (tx) => {
    const [b] = await tx.select().from(adminBanRequests).where(eq(adminBanRequests.id, banRequestId)).for("update");
    if (!b) throw paymentsError(404, "not_found");
    if (b.status !== "awaiting_second_admin") throw paymentsError(409, "ban_not_pending", { status: b.status });
    if (b.requestedByUserId === adminUserId) throw paymentsError(403, SECOND_ADMIN_REQUIRED);
    if (b.userId === adminUserId) throw paymentsError(403, OWN_TRANSACTION);
    await banUserIn(tx, adminUserId, b.userId, b.reason);
    const [done] = await tx.update(adminBanRequests).set({ status: "applied", confirmedByUserId: adminUserId, appliedAt: now }).where(eq(adminBanRequests.id, b.id)).returning();
    return banRequestView(done);
  });
}

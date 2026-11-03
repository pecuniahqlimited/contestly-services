/**
 * Payment permissions on top of the admin role. Changed per admin (admin_permissions) by an admin holding
 * payments.config, never for themselves; every change logged. Dev sessions (AUTH_MODE=dev) hold all four.
 *
 * Granting is loosening (ADR 0013), so it's maker-checker: a payments.config holder asks, a different one
 * confirms, and the grantee can never confirm their own grant. Otherwise one admin could make a second
 * account pass every second-admin check. Revoking applies at once, except payments.config.
 *
 * The config floor: un-pausing, confirming a grant and confirming a config change each take two different
 * payments.config holders, so the console never goes below two who can act (CONFIG_HOLDER_FLOOR). Taking
 * payments.config from one of the last three needs a second admin (the holder themselves may confirm);
 * from one of the last two it's refused. Banning a holder is held to the same floor, and whoever confirms
 * that ban must hold payments.config. Every check runs at confirm time under the permissions lock.
 *
 * A ban takes every payments permission away (banUserIn), and an unban gives none back: they return only
 * through the two-admin grant, and a banned admin can't be granted any. A banned holder isn't counted, so
 * revoking from one never meets the floor. When the console is stuck anyway (holders left the company,
 * say), `npm run payments:break-glass` grants payments.config from the server, never over the API (ADR
 * 0013). Who is an admin at all (ADMIN_EMAILS) is outside this: whoever controls the environment controls
 * that list.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  adminAlert, adminBanRequests, adminPermissions, banUserIn, CONFIG_HOLDER_FLOOR, configHolderCount, db, liveUser, lockPaymentPermissions as lockPermissions, paymentPermissionGrants, recordAdminAction, systemActorId, users,
  type AdminBanRequest, type PaymentPermissionGrant, type Tx, type User,
} from "@contestly/db";
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

const CONFIG = "payments.config";
export { CONFIG_HOLDER_FLOOR };
const floorError = (holders: number) => paymentsError(409, "config_holder_floor", { floor: CONFIG_HOLDER_FLOOR, holders });
async function holdsIn(tx: Tx, userId: string, permission: PaymentPermission) {
  return (await currentOf(tx, userId)).includes(permission);
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
    await lockPermissions(tx);
    const target = await lockAdminTarget(tx, targetUserId);
    const before = await currentOf(tx, targetUserId);
    const want = [...new Set(permissions)].sort();
    let revoke = before.filter((p) => !want.includes(p));
    const grant = want.filter((p) => !before.includes(p));
    if (grant.length && target.bannedAt) throw paymentsError(409, "banned");
    // payments.config: never below the floor; from one of the last floor + 1, only with a second admin. A
    // banned holder isn't counted, so taking it from one is just a revoke.
    let pendingRevoke = false;
    if (revoke.includes(CONFIG) && !target.bannedAt) {
      const holders = await configHolderCount(tx);
      if (holders - 1 < CONFIG_HOLDER_FLOOR) throw floorError(holders);
      if (holders - 1 === CONFIG_HOLDER_FLOOR) { revoke = revoke.filter((p) => p !== CONFIG); pendingRevoke = true; }
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
 * payments.config: the holder themselves may agree to it, and it never takes the holders below the floor.
 */
export async function confirmPermissionGrant(adminUserId: string, grantId: string, now = new Date()) {
  return db.transaction(async (tx) => {
    await lockPermissions(tx);
    const [pre] = await tx.select().from(paymentPermissionGrants).where(eq(paymentPermissionGrants.id, grantId));
    if (!pre) throw paymentsError(404, "not_found");
    const target = await lockAdminTarget(tx, pre.userId);
    const [g] = await tx.select().from(paymentPermissionGrants).where(eq(paymentPermissionGrants.id, grantId)).for("update");
    if (g.status !== "awaiting_second_admin") throw paymentsError(409, "grant_not_pending", { status: g.status });
    if (g.requestedByUserId === adminUserId) throw paymentsError(403, SECOND_ADMIN_REQUIRED);
    if (g.change === "grant" && g.userId === adminUserId) throw paymentsError(403, OWN_TRANSACTION);
    const before = await currentOf(tx, g.userId);
    if (g.change === "revoke") {
      const holders = await configHolderCount(tx);
      if (before.includes(CONFIG) && !target.bannedAt && holders - 1 < CONFIG_HOLDER_FLOOR) throw floorError(holders);
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

/**
 * Ban an admin from the console's ban button. One that holds no payments permission is banned now (main's
 * banUserIn); one that holds any becomes a request a different admin confirms. Decided inside the
 * transaction under the permissions lock, so a grant confirmed at the same moment can't slip past it.
 */
export async function banOrRequestBan(adminUserId: string, userId: string, reason: string): Promise<{ banned: User } | { banRequest: ReturnType<typeof banRequestView> }> {
  if (adminUserId === userId) throw paymentsError(409, "cannot_ban_self");
  return db.transaction(async (tx) => {
    await lockPermissions(tx);
    const held = await currentOf(tx, userId);
    if (!held.length) return { banned: await banUserIn(tx, adminUserId, userId, reason) };
    return { banRequest: await requestBanIn(tx, adminUserId, userId, reason, held) };
  });
}

/** Ask to ban an admin who holds payments permissions. Nothing changes until a different admin confirms. */
async function requestBanIn(tx: Tx, adminUserId: string, userId: string, reason: string, held: PaymentPermission[]) {
  const [target] = await tx.select().from(users).where(eq(users.id, userId)).for("no key update");
  if (!target || target.isSystem) throw paymentsError(404, "not_found");
  // Refused up front when it could never be confirmed; checked again at the confirm.
  if (held.includes(CONFIG) && !target.bannedAt) {
    const holders = await configHolderCount(tx);
    if (holders - 1 < CONFIG_HOLDER_FLOOR) throw floorError(holders);
  }
  const [open] = await tx.select({ id: adminBanRequests.id }).from(adminBanRequests).where(and(eq(adminBanRequests.userId, userId), eq(adminBanRequests.status, "awaiting_second_admin")));
  if (open) throw paymentsError(409, "ban_pending", { banRequestId: open.id });
  const [b] = await tx.insert(adminBanRequests).values({ userId, reason, status: "awaiting_second_admin", requestedByUserId: adminUserId }).returning();
  await recordAdminAction(tx, { adminUserId, action: "user.ban_requested", targetType: "user", targetId: userId, reason, before: null, after: { banRequestId: b.id, permissions: held } });
  return banRequestView(b);
}

/**
 * A second admin confirms: not whoever asked, not the admin being banned. Banning a payments.config holder
 * takes a confirmer who holds payments.config and never leaves fewer than the floor. All read under the
 * permissions lock, at the confirm. The ban is main's banUserIn, in this transaction.
 */
export async function confirmPaymentsAdminBan(adminUserId: string, banRequestId: string, now = new Date()) {
  return db.transaction(async (tx) => {
    await lockPermissions(tx);
    const [b] = await tx.select().from(adminBanRequests).where(eq(adminBanRequests.id, banRequestId)).for("update");
    if (!b) throw paymentsError(404, "not_found");
    if (b.status !== "awaiting_second_admin") throw paymentsError(409, "ban_not_pending", { status: b.status });
    if (b.requestedByUserId === adminUserId) throw paymentsError(403, SECOND_ADMIN_REQUIRED);
    if (b.userId === adminUserId) throw paymentsError(403, OWN_TRANSACTION);
    const [target] = await tx.select().from(users).where(eq(users.id, b.userId)).for("no key update");
    if (target && !target.bannedAt && (await holdsIn(tx, b.userId, CONFIG))) {
      if (!(await holdsIn(tx, adminUserId, CONFIG))) throw paymentsError(403, "missing_permission", { permission: CONFIG });
      const holders = await configHolderCount(tx);
      if (holders - 1 < CONFIG_HOLDER_FLOOR) throw floorError(holders);
    }
    await banUserIn(tx, adminUserId, b.userId, b.reason);
    const [done] = await tx.update(adminBanRequests).set({ status: "applied", confirmedByUserId: adminUserId, appliedAt: now }).where(eq(adminBanRequests.id, b.id)).returning();
    return banRequestView(done);
  });
}

// ---- Break-glass ----

/**
 * Grant payments.config straight from the server when the console is stuck: fewer than CONFIG_HOLDER_FLOOR
 * unbanned holders, so no grant can be confirmed. Otherwise refused (409 not_stuck), unless `force`, which
 * the admin_actions row and the alert both record. Only from `npm run payments:break-glass`, which needs
 * the server and the database: never an API route. Logged as the system with the reason and the OS user,
 * and raised as a critical alert, in one transaction.
 */
export async function breakGlassGrantConfig(handle: string, reason: string, osUser: string, opts: { force?: boolean } = {}) {
  if (reason.trim().length < 3) throw paymentsError(400, "reason_required");
  const force = opts.force === true;
  return db.transaction(async (tx) => {
    await lockPermissions(tx);
    const [target] = await tx.select().from(users).where(and(eq(users.handle, handle.replace(/^@/, "").toLowerCase()), liveUser)).for("no key update");
    if (!target) throw paymentsError(404, "not_found", { handle });
    if (!target.isAdmin) throw paymentsError(409, "not_admin", { handle });
    if (target.bannedAt) throw paymentsError(409, "banned", { handle });
    const before = await currentOf(tx, target.id);
    const holdersBefore = await configHolderCount(tx);
    if (before.includes(CONFIG)) return { user: target, granted: false, holders: holdersBefore };
    if (holdersBefore >= CONFIG_HOLDER_FLOOR && !force) throw paymentsError(409, "not_stuck", { floor: CONFIG_HOLDER_FLOOR, holders: holdersBefore });
    const system = await systemActorId(tx);
    await tx.insert(adminPermissions).values({ userId: target.id, permission: CONFIG, grantedByUserId: system });
    const after = await currentOf(tx, target.id);
    await recordAdminAction(tx, {
      adminUserId: system, action: "payments.break_glass", targetType: "user", targetId: target.id, reason,
      before, after: { permissions: after, osUser, holdersBefore, force },
    });
    await adminAlert({
      kind: "payments.break_glass", severity: "critical",
      subject: `Break-glass${force ? " (forced: the console wasn't stuck)" : ""}: payments.config granted to @${target.handle} from the server`,
      details: { handle: target.handle, reason, osUser, holdersBefore, force }, dedupeKey: `payments.break_glass:${randomUUID()}`, refType: "user", refId: target.id,
    }, tx);
    return { user: target, granted: true, holders: holdersBefore + 1 };
  });
}

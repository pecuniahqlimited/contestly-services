/**
 * The admin console's writes: every one goes through here with its admin_actions row in the same
 * transaction (who, what, target, before, after, why). The log is append-only: nothing here or
 * anywhere updates or deletes it.
 */
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { db, type Tx } from "./client.js";
import { adminActions, adminPermissions, paymentPermissionGrants, users, type AdminActionRow, type User } from "./schema.js";
import { treasuryUserId } from "./ledger.js";

type Conn = Tx | typeof db;

export interface AdminActionInput {
  adminUserId: string;
  action: string;
  targetType: "user" | "party" | "question" | "config" | "alert" | "payout" | "topup" | "payment_finalization" | "payment_recon_item" | "invariant";
  targetId: string;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
}

/**
 * Who an admin_actions row names when the system acted on its own (no admin involved, e.g. voiding a
 * deleted account's unpaid prizes): the platform's system account, the one the ledger posts the rake to.
 */
export const systemActorId = (tx: Tx) => treasuryUserId(tx);

export async function recordAdminAction(conn: Conn, a: AdminActionInput): Promise<AdminActionRow> {
  const [row] = await conn.insert(adminActions).values({ ...a, reason: a.reason ?? null, before: a.before ?? null, after: a.after ?? null }).returning();
  return row;
}

/** The log, newest first, optionally for one target. */
export async function adminActionsFor(filter: { targetType?: string; targetId?: string; limit: number }) {
  const where: SQL[] = [];
  if (filter.targetType) where.push(eq(adminActions.targetType, filter.targetType));
  if (filter.targetId) where.push(eq(adminActions.targetId, filter.targetId));
  return db.select({ a: adminActions, admin: users }).from(adminActions).innerJoin(users, eq(users.id, adminActions.adminUserId))
    .where(where.length ? and(...where) : undefined).orderBy(desc(adminActions.createdAt)).limit(filter.limit);
}

const httpError = (statusCode: number, code: string) => Object.assign(new Error(code), { statusCode });
const banState = (u: User) => ({ bannedAt: u.bannedAt?.toISOString() ?? null, banReason: u.banReason });

/** Ban: the account can't sign in, join, host or play from now on. Admins can't ban themselves. */
export async function banUser(adminUserId: string, userId: string, reason: string): Promise<User> {
  return db.transaction((tx) => banUserIn(tx, adminUserId, userId, reason));
}

/** The ban, in the caller's transaction (a payments admin's ban is confirmed by a second admin: packages/payments). */
export async function banUserIn(tx: Tx, adminUserId: string, userId: string, reason: string): Promise<User> {
  if (adminUserId === userId) throw httpError(409, "cannot_ban_self");
  await lockPaymentPermissions(tx);
  const [u] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
  if (!u || u.isSystem) throw httpError(404, "not_found");
  if (u.bannedAt) return u; // already banned: nothing changes, nothing logged
  const [after] = await tx.update(users).set({ bannedAt: new Date(), banReason: reason }).where(eq(users.id, userId)).returning();
  await recordAdminAction(tx, { adminUserId, action: "user.ban", targetType: "user", targetId: userId, reason, before: banState(u), after: banState(after) });
  await removePaymentPermissions(tx, adminUserId, userId, reason);
  return after;
}

/**
 * Serialises every change to who holds payments permissions (grants, revokes, bans, account deletion), so
 * two of them can't both count the same payments.config holders. Taken before the person's row.
 */
export const lockPaymentPermissions = (tx: Tx) => tx.execute(sql`select pg_advisory_xact_lock(hashtext('payments_permissions'))`);

/**
 * A ban takes every payments permission away in its transaction, logged, and supersedes any grant or
 * revoke still waiting on the person. An unban gives nothing back: they return only through the
 * two-admin grant (ADR 0013).
 */
async function removePaymentPermissions(tx: Tx, adminUserId: string, userId: string, reason: string) {
  const removed = await tx.delete(adminPermissions).where(eq(adminPermissions.userId, userId)).returning({ permission: adminPermissions.permission });
  const superseded = await tx.update(paymentPermissionGrants).set({ status: "superseded" })
    .where(and(eq(paymentPermissionGrants.userId, userId), eq(paymentPermissionGrants.status, "awaiting_second_admin"))).returning({ id: paymentPermissionGrants.id });
  if (!removed.length && !superseded.length) return;
  await recordAdminAction(tx, {
    adminUserId, action: "payments.permissions_removed_by_ban", targetType: "user", targetId: userId, reason,
    before: { permissions: removed.map((r) => r.permission).sort() }, after: { permissions: [], supersededGrants: superseded.map((g) => g.id) },
  });
}

export async function unbanUser(adminUserId: string, userId: string, reason: string): Promise<User> {
  return db.transaction(async (tx) => {
    const [u] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
    if (!u || u.isSystem) throw httpError(404, "not_found");
    if (!u.bannedAt) return u;
    const [after] = await tx.update(users).set({ bannedAt: null, banReason: null }).where(eq(users.id, userId)).returning();
    await recordAdminAction(tx, { adminUserId, action: "user.unban", targetType: "user", targetId: userId, reason, before: banState(u), after: banState(after) });
    return after;
  });
}

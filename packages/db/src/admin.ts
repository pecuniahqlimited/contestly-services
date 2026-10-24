/**
 * The admin console's writes: every one goes through here with its admin_actions row in the same
 * transaction (who, what, target, before, after, why). The log is append-only: nothing here or
 * anywhere updates or deletes it.
 */
import { and, desc, eq, type SQL } from "drizzle-orm";
import { db, type Tx } from "./client.js";
import { adminActions, users, type AdminActionRow, type User } from "./schema.js";

type Conn = Tx | typeof db;

export interface AdminActionInput {
  adminUserId: string;
  action: string;
  targetType: "user" | "party" | "question" | "config";
  targetId: string;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
}

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
  if (adminUserId === userId) throw httpError(409, "cannot_ban_self");
  return db.transaction(async (tx) => {
    const [u] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
    if (!u || u.isSystem) throw httpError(404, "not_found");
    if (u.bannedAt) return u; // already banned: nothing changes, nothing logged
    const [after] = await tx.update(users).set({ bannedAt: new Date(), banReason: reason }).where(eq(users.id, userId)).returning();
    await recordAdminAction(tx, { adminUserId, action: "user.ban", targetType: "user", targetId: userId, reason, before: banState(u), after: banState(after) });
    return after;
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

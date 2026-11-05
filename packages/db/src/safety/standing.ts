/**
 * Where a person stands (ADR 0014): chat timeouts, warnings and report outcomes (notices the app shows once),
 * and suspensions running out. Bans and suspensions themselves are banUserIn (admin.ts), so a payments admin's
 * goes through the two-admin rule in packages/payments.
 */
import { and, asc, eq, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { CHAT_TIMEOUT, type ReportReason } from "@contestly/shared";
import { db, type Tx } from "../client.js";
import { users, userNotices, type User } from "../schema.js";
import { recordAdminAction, systemActorId } from "../admin.js";

type Conn = Tx | typeof db;
const httpError = (statusCode: number, code: string) => Object.assign(new Error(code), { statusCode });

/** No sending in party chat, DMs, crews or corner replies while this is in the future. */
export async function assertCanChat(q: Conn, userId: string, now = new Date()) {
  const [u] = await q.select({ until: users.chatTimeoutUntil }).from(users).where(eq(users.id, userId));
  if (u?.until && u.until > now) throw Object.assign(new Error(CHAT_TIMEOUT), { statusCode: 403, details: { until: u.until.toISOString() } });
}

const timeoutState = (u: Pick<User, "chatTimeoutUntil">) => ({ chatTimeoutUntil: u.chatTimeoutUntil?.toISOString() ?? null });

/** Time someone out of chat until `until` (an admin, or the system for the automatic hold). Logged. */
export async function setChatTimeout(tx: Tx, a: { adminUserId: string; action: string; reason: string }, userId: string, until: Date) {
  const [u] = await tx.select().from(users).where(eq(users.id, userId)).for("no key update");
  if (!u || u.isSystem) throw httpError(404, "not_found");
  const [after] = await tx.update(users).set({ chatTimeoutUntil: until }).where(eq(users.id, userId)).returning();
  await recordAdminAction(tx, { adminUserId: a.adminUserId, action: a.action, targetType: "user", targetId: userId, reason: a.reason, before: timeoutState(u), after: timeoutState(after) });
  return after;
}

/** An admin lifts a chat timeout (theirs, or the automatic one). Nothing to lift: nothing logged. */
export async function liftChatTimeout(adminUserId: string, userId: string, reason: string) {
  return db.transaction(async (tx) => {
    const [u] = await tx.select().from(users).where(eq(users.id, userId)).for("no key update");
    if (!u || u.isSystem) throw httpError(404, "not_found");
    if (!u.chatTimeoutUntil || u.chatTimeoutUntil <= new Date()) return u;
    const [after] = await tx.update(users).set({ chatTimeoutUntil: null }).where(eq(users.id, userId)).returning();
    await recordAdminAction(tx, { adminUserId, action: "user.chat_timeout_lifted", targetType: "user", targetId: userId, reason, before: timeoutState(u), after: timeoutState(after) });
    return after;
  });
}

// ---- notices ----------------------------------------------------------------------------

export async function warnUser(tx: Tx, userId: string, category: ReportReason, itemId: string | null) {
  await tx.insert(userNotices).values({ userId, kind: "warning", category, itemId });
}

/** Each reporter of the item hears that it was looked at: "action taken" or "reviewed", never what. */
export async function tellReporters(tx: Tx, reporterIds: string[], itemId: string, outcome: "action_taken" | "reviewed") {
  if (reporterIds.length) await tx.insert(userNotices).values(reporterIds.map((userId) => ({ userId, kind: "report_outcome", outcome, itemId })));
}

export async function unseenNotices(userId: string) {
  const rows = await db.select().from(userNotices).where(and(eq(userNotices.userId, userId), isNull(userNotices.seenAt))).orderBy(asc(userNotices.createdAt));
  return rows.map((n) => ({ id: n.id, kind: n.kind as "warning" | "report_outcome", category: (n.category ?? null) as ReportReason | null, outcome: (n.outcome ?? null) as "action_taken" | "reviewed" | null, createdAt: n.createdAt.toISOString() }));
}

export async function markNoticeSeen(userId: string, id: string) {
  const [row] = await db.update(userNotices).set({ seenAt: new Date() }).where(and(eq(userNotices.id, id), eq(userNotices.userId, userId), isNull(userNotices.seenAt))).returning({ id: userNotices.id });
  if (!row) {
    const [mine] = await db.select({ id: userNotices.id }).from(userNotices).where(and(eq(userNotices.id, id), eq(userNotices.userId, userId)));
    if (!mine) throw httpError(404, "not_found");
  }
  return { ok: true };
}

// ---- suspensions running out -------------------------------------------------------------

/**
 * Suspensions whose time is up are lifted, each logged as the system: the person can sign in again and their
 * wallet unfreezes (isWalletFrozen reads the ban). Returns who, for the caller to bring their corner back.
 */
export async function liftExpiredSuspensions(now = new Date()): Promise<string[]> {
  const due = await db.select({ id: users.id }).from(users).where(and(isNotNull(users.bannedAt), isNotNull(users.bannedUntil), lte(users.bannedUntil, now)));
  if (!due.length) return [];
  return db.transaction(async (tx) => {
    const system = await systemActorId(tx);
    const rows = await tx.select().from(users).where(and(inArray(users.id, due.map((d) => d.id)), isNotNull(users.bannedUntil), lte(users.bannedUntil, now))).for("update");
    for (const u of rows) {
      await tx.update(users).set({ bannedAt: null, bannedUntil: null, banReason: null, banCategory: null }).where(eq(users.id, u.id));
      await recordAdminAction(tx, {
        adminUserId: system, action: "user.suspension_ended", targetType: "user", targetId: u.id, reason: "the suspension ran out",
        before: { bannedAt: u.bannedAt?.toISOString(), bannedUntil: u.bannedUntil?.toISOString(), banCategory: u.banCategory }, after: { bannedAt: null },
      });
    }
    return rows.map((u) => u.id);
  });
}

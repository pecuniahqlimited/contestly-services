/**
 * Blocks and person mutes (ADR 0014). A block's effect is mutual: every rule asks whether either has blocked
 * the other, and the blocked person is never told. A mute is one way and only hides: the muted person's chat
 * lines and the nudges about them stop reaching the muter. The rules elsewhere call these; none re-implements them.
 */
import { and, desc, eq, inArray, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db, type Tx } from "../client.js";
import { blocks, crewInvites, partyInvites, personMutes, users } from "../schema.js";

type Conn = Tx | typeof db;

const httpError = (statusCode: number, code: string) => Object.assign(new Error(code), { statusCode });

/** Whether either of the two has blocked the other. */
export async function blockedEitherWay(q: Conn, a: string, b: string): Promise<boolean> {
  if (a === b) return false;
  const [row] = await q.select({ x: blocks.blockerId }).from(blocks)
    .where(or(and(eq(blocks.blockerId, a), eq(blocks.blockedId, b)), and(eq(blocks.blockerId, b), eq(blocks.blockedId, a)))).limit(1);
  return !!row;
}

/** A condition for queries: `other` (a user id column or value) and `userId` haven't blocked each other either way. */
export const notBlockedWith = (userId: string, other: SQLWrapper | string): SQL =>
  sql`not exists (select 1 from ${blocks} bl where (bl.blocker_id = ${userId} and bl.blocked_id = ${other}) or (bl.blocker_id = ${other} and bl.blocked_id = ${userId}))`;

/** Everyone `userId` has blocked or been blocked by. */
export async function blockedWith(q: Conn, userId: string): Promise<Set<string>> {
  const rows = await q.select({ a: blocks.blockerId, b: blocks.blockedId }).from(blocks).where(or(eq(blocks.blockerId, userId), eq(blocks.blockedId, userId)));
  return new Set(rows.map((r) => (r.a === userId ? r.b : r.a)));
}

/** Whose chat lines `userId` doesn't see: blocked either way, or muted by them. */
export async function chatHiddenAuthors(q: Conn, userId: string): Promise<Set<string>> {
  const [blocked, muted] = await Promise.all([
    blockedWith(q, userId),
    q.select({ id: personMutes.mutedUserId }).from(personMutes).where(eq(personMutes.userId, userId)),
  ]);
  for (const m of muted) blocked.add(m.id);
  return blocked;
}

/** A condition for queries: `author` isn't hidden from `viewerId` (blocked either way, or muted by the viewer). */
export const visibleAuthorTo = (viewerId: string, author: SQLWrapper): SQL =>
  sql`(${author} is null or (${notBlockedWith(viewerId, author)} and not exists (select 1 from ${personMutes} pm where pm.user_id = ${viewerId} and pm.muted_user_id = ${author})))`;

/** Why a nudge about `aboutId` doesn't reach `recipientId`, or null: blocked either way, or muted by the recipient. */
export async function nudgeHiddenReason(q: Conn, recipientId: string, aboutIds: string[]): Promise<"blocked" | "muted" | null> {
  const others = aboutIds.filter((id) => id !== recipientId);
  if (!others.length) return null;
  const [blocked, muted] = await Promise.all([
    q.select({ x: blocks.blockerId }).from(blocks).where(or(
      and(eq(blocks.blockerId, recipientId), inArray(blocks.blockedId, others)), and(inArray(blocks.blockerId, others), eq(blocks.blockedId, recipientId)),
    )).limit(1),
    q.select({ x: personMutes.mutedUserId }).from(personMutes).where(and(eq(personMutes.userId, recipientId), inArray(personMutes.mutedUserId, others))).limit(1),
  ]);
  return blocked.length ? "blocked" : muted.length ? "muted" : null;
}

/**
 * The pairs among these people who have blocked each other (either way), as "a:b" with a < b. Whatever pairs
 * people into a party (row 7's matchmaking) must keep these apart.
 */
export async function blockedPairsAmong(q: Conn, userIds: string[]): Promise<Set<string>> {
  if (userIds.length < 2) return new Set();
  const rows = await q.select({ a: blocks.blockerId, b: blocks.blockedId }).from(blocks).where(and(inArray(blocks.blockerId, userIds), inArray(blocks.blockedId, userIds)));
  return new Set(rows.map((r) => (r.a < r.b ? `${r.a}:${r.b}` : `${r.b}:${r.a}`)));
}

async function target(q: Conn, me: { id: string }, userId: string) {
  if (me.id === userId) throw httpError(409, "cannot_block_self");
  const [u] = await q.select({ id: users.id, isSystem: users.isSystem }).from(users).where(eq(users.id, userId));
  if (!u || u.isSystem) throw httpError(404, "not_found");
}

/**
 * Block someone. Pending party and crew invites between the two are dismissed, so nothing waits on either side.
 * Silent: they aren't told. Blocking twice is a no-op.
 */
export async function blockUser(me: { id: string }, userId: string) {
  return db.transaction(async (tx) => {
    await target(tx, me, userId);
    await tx.insert(blocks).values({ blockerId: me.id, blockedId: userId }).onConflictDoNothing();
    const between = (a: PgColumn, b: PgColumn) => or(and(eq(a, me.id), eq(b, userId)), and(eq(a, userId), eq(b, me.id)));
    const now = new Date();
    await tx.update(partyInvites).set({ status: "dismissed", respondedAt: now }).where(and(eq(partyInvites.status, "pending"), between(partyInvites.inviterId, partyInvites.inviteeId)));
    await tx.update(crewInvites).set({ status: "dismissed", respondedAt: now }).where(and(eq(crewInvites.status, "pending"), between(crewInvites.inviterId, crewInvites.inviteeId)));
    return { blocked: true };
  });
}

export async function unblockUser(me: { id: string }, userId: string) {
  await db.delete(blocks).where(and(eq(blocks.blockerId, me.id), eq(blocks.blockedId, userId)));
  return { blocked: false };
}

export async function muteUser(me: { id: string }, userId: string) {
  if (me.id === userId) throw httpError(409, "cannot_mute_self");
  await target(db, me, userId);
  await db.insert(personMutes).values({ userId: me.id, mutedUserId: userId }).onConflictDoNothing();
  return { muted: true };
}

export async function unmuteUser(me: { id: string }, userId: string) {
  await db.delete(personMutes).where(and(eq(personMutes.userId, me.id), eq(personMutes.mutedUserId, userId)));
  return { muted: false };
}

/** Whether the viewer has blocked / muted them (profiles). */
export async function viewerSafetyState(viewerId: string, userId: string) {
  const [[b], [m]] = await Promise.all([
    db.select({ x: blocks.blockerId }).from(blocks).where(and(eq(blocks.blockerId, viewerId), eq(blocks.blockedId, userId))),
    db.select({ x: personMutes.userId }).from(personMutes).where(and(eq(personMutes.userId, viewerId), eq(personMutes.mutedUserId, userId))),
  ]);
  return { blockedByYou: !!b, mutedByYou: !!m };
}

/** Who I've blocked, newest first, with when. */
export async function blocksOf(userId: string) {
  return db.select({ id: users.id, handle: users.handle, displayName: users.displayName, avatarEmoji: users.avatarEmoji, isVerified: users.isVerified, at: blocks.createdAt })
    .from(blocks).innerJoin(users, eq(users.id, blocks.blockedId)).where(eq(blocks.blockerId, userId)).orderBy(desc(blocks.createdAt));
}

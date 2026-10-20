/** People as the API shows them, and how the viewer stands with them. */
import { and, eq, inArray } from "drizzle-orm";
import { db, follows, users, type User } from "@contestly/db";
import type { Person, ViewerFollow } from "@contestly/shared";

/** Select these to get a Person straight from a query. */
export const personColumns = { id: users.id, handle: users.handle, displayName: users.displayName, avatarEmoji: users.avatarEmoji, isVerified: users.isVerified };

export const toPerson = (u: User): Person => ({ id: u.id, handle: u.handle, displayName: u.displayName, avatarEmoji: u.avatarEmoji, isVerified: u.isVerified });

const STRANGER: ViewerFollow = { following: false, notify: false, followsYou: false };

/** The viewer's follow state with each of `ids`; strangers when signed out. */
export async function viewerRelations(viewerId: string | undefined, ids: string[]): Promise<Map<string, ViewerFollow>> {
  const result = new Map(ids.map((id) => [id, STRANGER]));
  if (!viewerId || !ids.length) return result;
  const [out, back] = await Promise.all([
    db.select({ id: follows.followeeId, notify: follows.notify }).from(follows).where(and(eq(follows.followerId, viewerId), inArray(follows.followeeId, ids))),
    db.select({ id: follows.followerId }).from(follows).where(and(eq(follows.followeeId, viewerId), inArray(follows.followerId, ids))),
  ]);
  const notify = new Map(out.map((r) => [r.id, r.notify]));
  const followsYou = new Set(back.map((r) => r.id));
  for (const id of ids) result.set(id, { following: notify.has(id), notify: notify.get(id) ?? false, followsYou: followsYou.has(id) });
  return result;
}

/** Of `ids`, the ones the viewer follows. */
export async function followedBy(viewerId: string | undefined, ids: string[]): Promise<Set<string>> {
  if (!viewerId || !ids.length) return new Set();
  const rows = await db.select({ id: follows.followeeId }).from(follows).where(and(eq(follows.followerId, viewerId), inArray(follows.followeeId, ids)));
  return new Set(rows.map((r) => r.id));
}

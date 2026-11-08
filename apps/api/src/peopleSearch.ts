/** People search (GET /users/search): the query in packages/db, plus whether you can message each one (dmPermission()). */
import { db, dmPermissionBetween, searchPeople, type FoundPerson as FoundRow, type User } from "@contestly/db";
import type { FoundPerson } from "@contestly/shared";
import { limit } from "./redis.js";

/** One result as the API shows it. */
export async function withMessaging(me: User, rows: FoundRow[]): Promise<FoundPerson[]> {
  return Promise.all(rows.map(async (r) => {
    const permission = await dmPermissionBetween(db, me, r);
    return {
      id: r.id, handle: r.handle, displayName: r.displayName, avatarEmoji: r.avatarEmoji, isVerified: r.isVerified, isBrand: r.isBrand,
      yourPeople: r.yourPeople, relationship: r.relationship, canMessage: permission !== "refused", messageIsRequest: permission === "request",
    };
  }));
}

export async function findPeople(me: User, q: string, limit: number): Promise<FoundPerson[]> {
  return withMessaging(me, await searchPeople(me, { q, limit }));
}

/** Share of the per-minute limit past which a user's searching is logged as heavy, once a window. */
const HEAVY_USE_SHARE = 0.75;

/** Counts one search against the user's per-minute limit (429 past it) and logs heavy use once a minute. */
export async function countSearch(userId: string, perMinute: number): Promise<void> {
  const n = await limit("people_search", userId, perMinute, 60);
  if (n === Math.ceil(perMinute * HEAVY_USE_SHARE)) console.warn(`[search] heavy use: user ${userId} made ${n} people searches this minute (limit ${perMinute})`);
}

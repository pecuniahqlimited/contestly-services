/**
 * A host asks recent players of their parties to follow their corner (from corner setup and the corner page).
 * Each player is asked at most once per corner, ever (the nudge's dedupe key), and a host asks at most
 * followAsksPerDay players a day (their own day). Only players who don't follow it yet and were never asked.
 */
import { and, count, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { startOfLocalDay, type NudgeConfig } from "@contestly/shared";
import { db } from "../client.js";
import { getNudgeConfig } from "../config.js";
import { liveUser } from "../accounts.js";
import { cornerShown } from "../corners.js";
import { corners, follows, nudges, parties, partyPlayers, users, type User } from "../schema.js";
import { nudge } from "./record.js";

const DAY = 24 * 60 * 60_000;
export const followAskKey = (cornerId: string) => `corner_follow_ask:${cornerId}`;

const refusal = (code: string, statusCode: number) => Object.assign(new Error(code), { statusCode });

async function shownCornerOf(hostId: string) {
  const [c] = await db.select().from(corners).where(and(eq(corners.ownerUserId, hostId), cornerShown));
  if (!c) throw refusal("no_corner", 404);
  return c;
}

/** Players of the host's finished parties in the last followAskRecentDays who don't follow the corner and were never asked. */
async function candidates(hostId: string, cornerId: string, cfg: NudgeConfig, now: Date) {
  const since = new Date(now.getTime() - cfg.followAskRecentDays * DAY);
  return db.selectDistinct({ id: users.id, handle: users.handle, displayName: users.displayName, avatarEmoji: users.avatarEmoji, isVerified: users.isVerified })
    .from(partyPlayers).innerJoin(parties, eq(parties.id, partyPlayers.partyId)).innerJoin(users, eq(users.id, partyPlayers.userId))
    .where(and(
      eq(parties.createdByUserId, hostId), eq(parties.status, "finished"), gt(parties.endedAt, since),
      ne(users.id, hostId), eq(users.isGuest, false), liveUser, isNull(users.bannedAt),
      sql`not exists (select 1 from ${follows} f where f.corner_id = ${cornerId} and f.follower_id = ${users.id})`,
      sql`not exists (select 1 from ${nudges} x where x.user_id = ${users.id} and x.dedupe_key = ${followAskKey(cornerId)})`,
    ))
    .orderBy(users.displayName);
}

/** Players asked to follow this corner since `dayStart`. */
async function askedSince(cornerId: string, dayStart: Date): Promise<number> {
  const [r] = await db.select({ n: count() }).from(nudges).where(and(eq(nudges.kind, "corner_follow_ask"), eq(nudges.refId, cornerId), gt(nudges.createdAt, dayStart)));
  return Number(r.n);
}

/** GET /me/corner/invite-followers: who the host can ask, and how many more today. */
export async function followAskOptions(host: User, now = new Date()) {
  const c = await shownCornerOf(host.id);
  const cfg = await getNudgeConfig();
  const [players, asked] = await Promise.all([candidates(host.id, c.id, cfg, now), askedSince(c.id, startOfLocalDay(now, host.timeZone))]);
  return { players, remainingToday: Math.max(0, cfg.followAsksPerDay - asked), dailyLimit: cfg.followAsksPerDay };
}

/**
 * POST /me/corner/invite-followers: ask these players. Anyone not eligible (already follows, already asked,
 * never played the host's recent parties) is refused with the whole request (422 not_eligible), and so is a
 * request past today's limit (429 follow_asks_limit), so nothing is half-sent.
 */
export async function askToFollow(host: User, userIds: string[], now = new Date()) {
  const c = await shownCornerOf(host.id);
  const cfg = await getNudgeConfig();
  const ids = [...new Set(userIds)];
  const eligible = new Set((await candidates(host.id, c.id, cfg, now)).map((p) => p.id));
  const notEligible = ids.filter((id) => !eligible.has(id));
  if (notEligible.length) throw Object.assign(refusal("not_eligible", 422), { details: { userIds: notEligible } });
  const remaining = cfg.followAsksPerDay - (await askedSince(c.id, startOfLocalDay(now, host.timeZone)));
  if (ids.length > remaining) throw Object.assign(refusal("follow_asks_limit", 429), { details: { remainingToday: Math.max(0, remaining) } });
  await db.transaction(async (tx) => {
    for (const userId of ids) {
      await nudge(tx, {
        userId, kind: "corner_follow_ask", data: { cornerId: c.id, cornerName: c.name, hostName: host.displayName },
        ref: { type: "corner", id: c.id }, dedupeKey: followAskKey(c.id),
      }, now);
    }
  });
  return { asked: ids.length, remainingToday: remaining - ids.length };
}

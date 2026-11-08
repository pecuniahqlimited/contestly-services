/**
 * A host asks people to follow their corner (corner setup and the corner page): anyone signed up, found by
 * search, and with no search their recent players. Each person is asked at most once per corner, ever (the
 * nudge's dedupe key; the lists show "already asked"), and a corner sends at most followAsksPerDay asks a
 * day (the host's day). Never someone who already follows, never a guest, banned or deleted account, and never
 * anyone blocked either way with the host (ADR 0014): they don't appear and can't be asked. The ask is a
 * corners-category nudge that lists in Activity, so with Corners notifications off it's there, with no push.
 */
import { and, count, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { startOfLocalDay, type NudgeConfig } from "@contestly/shared";
import { db } from "../client.js";
import { getNudgeConfig } from "../config.js";
import { liveUser } from "../accounts.js";
import { cornerShown } from "../corners.js";
import { corners, follows, nudges, parties, partyPlayers, users, type User } from "../schema.js";
import { nudge } from "./record.js";
import { notBlockedWith } from "../safety/people.js";
import { relationshipColumns, relationshipOf, searchPeople } from "../peopleSearch.js";
import { simVisibleTo } from "../sim.js";
import { publiclyHostedBy } from "../host.js";

const DAY = 24 * 60 * 60_000;
export const followAskKey = (cornerId: string) => `corner_follow_ask:${cornerId}`;
/** Recent players listed when there's no search. */
export const FOLLOW_ASK_RECENT_SHOWN = 50;

const refusal = (code: string, statusCode: number) => Object.assign(new Error(code), { statusCode });

async function shownCornerOf(hostId: string) {
  const [c] = await db.select().from(corners).where(and(eq(corners.ownerUserId, hostId), cornerShown));
  if (!c) throw refusal("no_corner", 404);
  return c;
}

/** Who may be asked at all: signed up, live, not banned, not a system account, not the host, not blocked either way with them. */
const askable = (host: User) => and(
  ne(users.id, host.id), eq(users.isGuest, false), eq(users.isSystem, false), liveUser, isNull(users.bannedAt),
  notBlockedWith(host.id, users.id), simVisibleTo(host, users.isSim),
);
const notFollowing = (cornerId: string) => sql`not exists (select 1 from ${follows} f where f.corner_id = ${cornerId} and f.follower_id = ${sql.raw(`"users"."id"`)})`;

/** Of these people, the ones this corner has already asked. */
async function alreadyAsked(cornerId: string, userIds: string[]): Promise<Set<string>> {
  if (!userIds.length) return new Set();
  const rows = await db.select({ id: nudges.userId }).from(nudges).where(and(inArray(nudges.userId, userIds), eq(nudges.dedupeKey, followAskKey(cornerId))));
  return new Set(rows.map((r) => r.id));
}

/** Players of the host's finished parties in the last followAskRecentDays who can be asked and don't follow yet. */
async function recentPlayers(host: User, cornerId: string, cfg: NudgeConfig, now: Date) {
  const since = new Date(now.getTime() - cfg.followAskRecentDays * DAY);
  const rows = await db.selectDistinct({ id: users.id, handle: users.handle, displayName: users.displayName, avatarEmoji: users.avatarEmoji, isVerified: users.isVerified, ...relationshipColumns(host.id) })
    .from(partyPlayers).innerJoin(parties, eq(parties.id, partyPlayers.partyId)).innerJoin(users, eq(users.id, partyPlayers.userId))
    .where(and(publiclyHostedBy(host.id), eq(parties.status, "finished"), gt(parties.endedAt, since), askable(host), notFollowing(cornerId)))
    .orderBy(users.displayName).limit(FOLLOW_ASK_RECENT_SHOWN);
  return rows.map(({ crew, contact, played, ...r }) => ({ ...r, relationship: relationshipOf({ crew, contact, played }) }));
}

/** Of these people, how many of the host's finished parties each played (all time). */
async function partiesFinishedWith(hostId: string, userIds: string[]): Promise<Map<string, number>> {
  if (!userIds.length) return new Map();
  const rows = await db.select({ id: partyPlayers.userId, n: sql<number>`count(distinct ${partyPlayers.partyId})::int` })
    .from(partyPlayers).innerJoin(parties, eq(parties.id, partyPlayers.partyId))
    .where(and(publiclyHostedBy(hostId), eq(parties.status, "finished"), inArray(partyPlayers.userId, userIds)))
    .groupBy(partyPlayers.userId);
  return new Map(rows.map((r) => [r.id, Number(r.n)]));
}

/** Asks this corner has sent since `dayStart`. */
async function askedSince(cornerId: string, dayStart: Date): Promise<number> {
  const [r] = await db.select({ n: count() }).from(nudges).where(and(eq(nudges.kind, "corner_follow_ask"), eq(nudges.refId, cornerId), gt(nudges.createdAt, dayStart)));
  return Number(r.n);
}

/**
 * GET /me/corner/invite-followers: with `q`, anyone signed up the host can ask who matches (people search,
 * minus followers); without, their recent players who don't follow. Each says whether it was already asked.
 */
export async function followAskOptions(host: User, opts: { q?: string; limit?: number } = {}, now = new Date()) {
  const c = await shownCornerOf(host.id);
  const cfg = await getNudgeConfig();
  const found = opts.q
    ? await searchPeople(host, { q: opts.q, limit: opts.limit ?? FOLLOW_ASK_RECENT_SHOWN, where: and(notFollowing(c.id), eq(users.isBrand, false)) })
    : await recentPlayers(host, c.id, cfg, now);
  const ids = found.map((p) => p.id);
  const [asked, finished, sent] = await Promise.all([alreadyAsked(c.id, ids), partiesFinishedWith(host.id, ids), askedSince(c.id, startOfLocalDay(now, host.timeZone))]);
  return {
    corner: { id: c.id, name: c.name, color: c.color },
    players: found.map((p) => ({ id: p.id, handle: p.handle, displayName: p.displayName, avatarEmoji: p.avatarEmoji, isVerified: p.isVerified,
      relationship: p.relationship, partiesFinished: finished.get(p.id) ?? 0, alreadyAsked: asked.has(p.id),
    })),
    remainingToday: Math.max(0, cfg.followAsksPerDay - sent),
    dailyLimit: cfg.followAsksPerDay,
  };
}

export type FollowAskRefusal = "already_asked" | "already_following" | "not_found";

/**
 * POST /me/corner/invite-followers: ask these people. Anyone who can't be asked refuses the whole request
 * (422 not_eligible, details.userIds and details.reasons: already_asked, already_following, or not_found for
 * anyone who isn't there to ask, which is all a blocked, banned, deleted or guest account ever looks like), and
 * so does a request past today's limit (429 follow_asks_limit), so nothing is half-sent.
 */
export async function askToFollow(host: User, userIds: string[], now = new Date()) {
  const c = await shownCornerOf(host.id);
  const cfg = await getNudgeConfig();
  const ids = [...new Set(userIds)];
  const [found, following, asked] = await Promise.all([
    db.select({ id: users.id }).from(users).where(and(inArray(users.id, ids), askable(host))),
    db.select({ id: follows.followerId }).from(follows).where(and(eq(follows.cornerId, c.id), inArray(follows.followerId, ids))),
    alreadyAsked(c.id, ids),
  ]);
  const there = new Set(found.map((r) => r.id));
  const follows_ = new Set(following.map((r) => r.id));
  const reasons: Record<string, FollowAskRefusal> = {};
  for (const id of ids) {
    if (!there.has(id)) reasons[id] = "not_found";
    else if (follows_.has(id)) reasons[id] = "already_following";
    else if (asked.has(id)) reasons[id] = "already_asked";
  }
  const notEligible = Object.keys(reasons);
  if (notEligible.length) throw Object.assign(refusal("not_eligible", 422), { details: { userIds: notEligible, reasons } });
  const remaining = cfg.followAsksPerDay - (await askedSince(c.id, startOfLocalDay(now, host.timeZone)));
  if (ids.length > remaining) throw Object.assign(refusal("follow_asks_limit", 429), { details: { remainingToday: Math.max(0, remaining) } });
  await db.transaction(async (tx) => {
    for (const userId of ids) {
      await nudge(tx, {
        userId, kind: "corner_follow_ask", data: { cornerId: c.id, cornerName: c.name, hostName: host.displayName },
        ref: { type: "corner", id: c.id }, dedupeKey: followAskKey(c.id), actor: { id: host.id, name: host.displayName },
      }, now);
    }
  });
  return { asked: ids.length, remainingToday: remaining - ids.length };
}

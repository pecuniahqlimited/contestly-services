import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, count, desc, eq, inArray, min, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { climbRuns, climbWeeks, db, dmPermissionBetween, liveUser, users, parties, partyPlayers, partiesHostedBy, viewerSafetyState, yourPeople } from "@contestly/db";
import { currentStreak, feedQuerySchema, lagosDay, MAX_PROFILE_RECENT_PARTIES, peopleSearchQuerySchema, peopleSearchResponseSchema, type Person } from "@contestly/shared";
import { countSearch, findPeople } from "../peopleSearch.js";
import { requireUser } from "../auth.js";
import { publicParties } from "../partyView.js";
import { personColumns } from "../people.js";
import { hostCornerOf } from "../corners.js";
import { headToHead } from "../social.js";
import { feedPage } from "../feed.js";

export const publicUser = (u: typeof users.$inferSelect) => ({ id: u.id, handle: u.handle, displayName: u.displayName, avatarEmoji: u.avatarEmoji, bio: u.bio, interests: u.interests, isBrand: u.isBrand, isVerified: u.isVerified, streakDays: currentStreak(u.lastPlayedOn, u.streakDays, lagosDay()) });

/** A party on someone's profile: public, or one the viewer was in too. Private parties stay private. */
const visibleTo = (viewerId: string | undefined): SQL =>
  viewerId
    ? or(eq(parties.visibility, "public"), sql`exists (select 1 from ${partyPlayers} v where v.party_id = ${parties.id} and v.user_id = ${viewerId})`)!
    : eq(parties.visibility, "public");

/** Their seats in finished parties: what stats and recent parties count. */
const finishedSeatOf = (userId: string) => and(eq(partyPlayers.userId, userId), eq(parties.status, "finished"));

async function headToHeadWith(meId: string, themId: string) {
  const them = alias(partyPlayers, "them");
  const rows = await db.select({ myRank: partyPlayers.rank, theirRank: them.rank }).from(partyPlayers)
    .innerJoin(them, and(eq(them.partyId, partyPlayers.partyId), eq(them.userId, themId)))
    .innerJoin(parties, eq(parties.id, partyPlayers.partyId))
    .where(finishedSeatOf(meId));
  return headToHead(rows);
}

async function recentParties(userId: string, viewerId: string | undefined) {
  const rows = await db.select({
    id: parties.id, title: parties.title, category: parties.category, coverColor: parties.coverColor, coverEmoji: parties.coverEmoji, startsAt: parties.startsAt,
    rank: partyPlayers.rank, playerCount: sql<number>`(select count(*) from ${partyPlayers} pc where pc.party_id = ${parties.id})`,
  }).from(partyPlayers).innerJoin(parties, eq(parties.id, partyPlayers.partyId))
    .where(and(finishedSeatOf(userId), visibleTo(viewerId)))
    .orderBy(desc(sql`coalesce(${parties.endedAt}, ${parties.startsAt})`)).limit(MAX_PROFILE_RECENT_PARTIES);
  return rows.map((r) => ({ ...r, playerCount: Number(r.playerCount) }));
}

/** Mutual faces shown on a profile. */
const MUTUAL_FACES = 3;

/** Their best Climb ever: most points, most stages, and whether any run cleared the whole ladder. */
async function climbBest(userId: string) {
  const [[runs], [weeks]] = await Promise.all([
    db.select({ points: sql<number>`coalesce(max(${climbRuns.points}), 0)`, stages: sql<number>`coalesce(max(${climbRuns.stagesCleared}), 0)` }).from(climbRuns).where(eq(climbRuns.userId, userId)),
    db.select({ clearedAll: sql<boolean>`coalesce(bool_or(${climbWeeks.clearedAll}), false)` }).from(climbWeeks).where(eq(climbWeeks.userId, userId)),
  ]);
  return { bestRunPoints: Number(runs.points), bestStagesCleared: Number(runs.stages), clearedAll: !!weeks.clearedAll };
}

/** People who are both the viewer's people and theirs (ADR 0012). */
async function mutuals(viewerId: string | undefined, userId: string) {
  if (!viewerId || viewerId === userId) return { count: 0, faces: [] as Person[] };
  const [mine, theirs] = await Promise.all([yourPeople(viewerId), yourPeople(userId)]);
  const both = [...mine].filter((id) => theirs.has(id));
  if (!both.length) return { count: 0, faces: [] as Person[] };
  const rows = await db.select(personColumns).from(users).where(and(inArray(users.id, both), liveUser)).orderBy(asc(users.displayName));
  return { count: rows.length, faces: rows.slice(0, MUTUAL_FACES) };
}

/** A live party they're playing that the viewer could open (public, or one the viewer is in). */
async function playingNow(userId: string, viewerId: string | undefined) {
  const [row] = await db.select({ id: parties.id, title: parties.title }).from(partyPlayers).innerJoin(parties, eq(parties.id, partyPlayers.partyId))
    .where(and(eq(partyPlayers.userId, userId), eq(parties.status, "live"), visibleTo(viewerId))).limit(1);
  return row ?? null;
}

async function userByHandle(req: FastifyRequest, reply: FastifyReply) {
  const { handle } = req.params as { handle: string };
  const [u] = await db.select().from(users).where(and(eq(users.handle, handle), eq(users.isSystem, false), eq(users.isGuest, false), liveUser));
  if (!u) reply.code(404).send({ error: "not_found" });
  return u;
}

export async function usersRoutes(app: FastifyInstance) {
  /** People search: signed-up accounts only, rate-limited per user (RATE_LIMIT_PEOPLE_SEARCH_PER_MINUTE). */
  app.get("/users/search", async (req) => {
    const me = requireUser(req);
    const { q, limit } = peopleSearchQuerySchema.parse(req.query);
    await countSearch(me.id, app.limits.peopleSearchPerMinute);
    return peopleSearchResponseSchema.parse({ people: await findPeople(me, q, limit) });
  });

  app.get("/users/:handle", async (req, reply) => {
    const u = await userByHandle(req, reply);
    if (!u) return reply;
    const me = req.auth?.user;
    const [[stats], corner, recent, h2h, hosted, climb, mutual, live, canMessage] = await Promise.all([
      db.select({ parties: count(), wins: sql<number>`count(*) filter (where ${partyPlayers.rank} = 1)`, bestRank: min(partyPlayers.rank) })
        .from(partyPlayers).innerJoin(parties, eq(parties.id, partyPlayers.partyId)).where(finishedSeatOf(u.id)),
      hostCornerOf(u.id, me?.id),
      recentParties(u.id, me?.id),
      me && me.id !== u.id ? headToHeadWith(me.id, u.id) : null,
      partiesHostedBy(u.id),
      climbBest(u.id),
      mutuals(me?.id, u.id),
      playingNow(u.id, me?.id),
      me && me.id !== u.id ? dmPermissionBetween(db, me, u) : null,
    ]);
    const safety = me && me.id !== u.id ? await viewerSafetyState(me.id, u.id) : { blockedByYou: false, mutedByYou: false };
    const hosting = await publicParties(hosted.filter((p) => (p.status === "open" || p.status === "live") && (p.visibility === "public" || me?.id === u.id))
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()));
    return {
      ...publicUser(u),
      stats: { parties: Number(stats.parties), wins: Number(stats.wins), bestRank: stats.bestRank === null ? null : Number(stats.bestRank) },
      corner, headToHead: h2h, recent, hosting,
      climb, streak: { current: currentStreak(u.lastPlayedOn, u.streakDays, lagosDay()), best: u.bestStreakDays }, mutuals: mutual, canMessage, playingNow: live, ...safety,
    };
  });

  /** What they did lately (their profile's Activity tab): the same events the feed shows. */
  app.get("/users/:handle/activity", async (req, reply) => {
    const u = await userByHandle(req, reply);
    if (!u) return reply;
    const viewerId = requireUser(req).id;
    return feedPage([u.id], viewerId, feedQuerySchema.parse(req.query ?? {}));
  });
}

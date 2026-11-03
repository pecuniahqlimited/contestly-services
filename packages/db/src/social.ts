/**
 * The social record (row 6b, ADR 0008; ADR 0012 for who your people are): feed events written where things
 * happen, party points written at settlement, played-with by the worker's record_progress after it, your people, and the scores every friends and
 * crew board is ranked from. API, worker and the Climb share these so a rule lives once.
 */
import { and, desc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { isBraggingRights, lagosDay, partyPointsFor, weekOf, type BoardPeriod, type ChatMessage, type ClimbDay, type FeedData, type FeedKind } from "@contestly/shared";
import type { SocialScore } from "@contestly/game";
import { db, type Tx } from "./client.js";
import { chatThreads, climbDays, climbRuns, contactMatches, crewMembers, crews, feedEvents, partyDays, partyPlayers, playedWith, users, type Party } from "./schema.js";
import { getSocialConfig } from "./config.js";
import { systemLineIn } from "./chat.js";

type Conn = Tx | typeof db;

/** Append a feed event. A party's finish is written once per player. */
export async function addFeedEvent<K extends FeedKind>(q: Conn, userId: string, kind: K, data: FeedData<K>, ref: { partyId?: string; cornerPostId?: string } = {}) {
  await q.insert(feedEvents).values({ userId, kind, data, ...ref }).onConflictDoNothing();
}

export interface FinishedSeat { userId: string; rank: number | null; isGuest: boolean; bannedAt: Date | null }

/**
 * A party settled: each signed-up player's finish goes in the feed, and in a bragging-rights party (free,
 * nothing to win) each signed-up player in good standing earns party points for the Lagos day it ended,
 * up to the daily cap. Inside settlement's transaction, which runs once per party.
 */
export async function recordPartyFinish(tx: Tx, party: Party, seats: FinishedSeat[], endedAt = new Date()) {
  const cfg = await getSocialConfig();
  for (const s of seats) {
    if (s.isGuest) continue;
    await addFeedEvent(tx, s.userId, "party_finished", { partyId: party.id, title: party.title, rank: s.rank, playerCount: seats.length }, { partyId: party.id });
  }
  if (!isBraggingRights(party)) return;
  const day = lagosDay(endedAt);
  for (const s of seats) {
    if (s.isGuest || s.bannedAt || s.rank === null) continue;
    const points = partyPointsFor(s.rank, seats.length, cfg);
    if (!points) continue;
    await tx.insert(partyDays).values({ userId: s.userId, day, week: weekOf(day) }).onConflictDoNothing();
    await tx.update(partyDays).set({
      points: sql`${partyDays.points} + ${points}`,
      parties: sql`${partyDays.parties} + 1`,
      wins: sql`${partyDays.wins} + ${s.rank === 1 ? 1 : 0}`,
    }).where(and(eq(partyDays.userId, s.userId), eq(partyDays.day, day), lt(partyDays.parties, cfg.partyPointsDailyCap)));
  }
}

// ---- played with, contacts and your people (ADR 0012) ----------------------------------

/**
 * Every pair of signed-up players in a finished party played together: one statement, in record_progress's
 * transaction (which runs once per party, partyProgress.ts), so a pair's count goes up once per party.
 */
export async function recordPlayedWith(tx: Tx, partyId: string, endedAt = new Date()) {
  await tx.execute(sql`
    insert into ${playedWith} (user_a, user_b, parties, last_played_at)
    select a.user_id, b.user_id, 1, ${endedAt.toISOString()}::timestamptz
    from ${partyPlayers} a join ${partyPlayers} b on b.party_id = a.party_id and a.user_id < b.user_id
    join ${users} ua on ua.id = a.user_id join ${users} ub on ub.id = b.user_id
    where a.party_id = ${partyId} and not ua.is_guest and not ub.is_guest
    on conflict (user_a, user_b) do update set parties = ${playedWith.parties} + 1, last_played_at = greatest(${playedWith.lastPlayedAt}, excluded.last_played_at)`);
}

/** The ordered pair key played_with uses. */
const pair = (a: string, b: string) => (a < b ? [a, b] : [b, a]);

/** Whether two people have finished a party together, ever. */
export async function playedTogether(q: Conn, a: string, b: string): Promise<boolean> {
  const [x, y] = pair(a, b);
  const [row] = await q.select({ n: playedWith.parties }).from(playedWith).where(and(eq(playedWith.userA, x), eq(playedWith.userB, y)));
  return !!row;
}

/** Whether either has the other's number in their contacts. */
export async function areContacts(q: Conn, a: string, b: string): Promise<boolean> {
  const [row] = await q.select({ u: contactMatches.userId }).from(contactMatches)
    .where(or(and(eq(contactMatches.userId, a), eq(contactMatches.contactUserId, b)), and(eq(contactMatches.userId, b), eq(contactMatches.contactUserId, a)))).limit(1);
  return !!row;
}

/** Contacts matched just now: kept, so they count as your people and for DMs. */
export async function recordContactMatches(userId: string, contactIds: string[]) {
  if (contactIds.length) await db.insert(contactMatches).values(contactIds.map((contactUserId) => ({ userId, contactUserId }))).onConflictDoNothing();
}

/**
 * Your people (ADR 0012): crew mates, matched contacts (either way), and people you've finished a party with
 * in the last `yourPeopleDays`. Never you, never a deleted account. The one source for the friends boards,
 * mutuals, the lobby's "who's in", the feed and (row 9) nudges.
 */
export async function yourPeople(userId: string, conn: Conn = db): Promise<Set<string>> {
  const { yourPeopleDays } = await getSocialConfig(conn);
  const since = new Date(Date.now() - yourPeopleDays * 86_400_000);
  const rows = await conn.execute(sql`
    select other from (
      select b.user_id as other from ${crewMembers} a join ${crewMembers} b on b.crew_id = a.crew_id
        join ${crews} c on c.id = a.crew_id and c.archived_at is null where a.user_id = ${userId}
      union select contact_user_id from ${contactMatches} where user_id = ${userId}
      union select user_id from ${contactMatches} where contact_user_id = ${userId}
      union select case when user_a = ${userId} then user_b else user_a end from ${playedWith}
        where (user_a = ${userId} or user_b = ${userId}) and last_played_at >= ${since.toISOString()}::timestamptz
    ) p join ${users} u on u.id = p.other where p.other <> ${userId} and u.deleted_at is null`);
  return new Set((rows as unknown as { other: string }[]).map((r) => r.other));
}

/**
 * Board scores for these people: Climb points (best run each day plus Today's challenge) and party points,
 * this week or all time. For the week, `prevTotal` is the total as today began (null if it was 0).
 */
export async function socialScores(userIds: string[], period: BoardPeriod, today: ClimbDay = lagosDay()): Promise<SocialScore[]> {
  if (!userIds.length) return [];
  const week = weekOf(today);
  const inWeek = period === "week";
  const [climb, parties] = await Promise.all([
    db.select({
      userId: climbDays.userId,
      total: sql<number>`sum(${climbDays.bestRunPoints} + ${climbDays.challengePoints})`,
      before: sql<number>`coalesce(sum(${climbDays.bestRunPoints} + ${climbDays.challengePoints}) filter (where ${climbDays.day} < ${today}), 0)`,
    }).from(climbDays).where(and(inArray(climbDays.userId, userIds), inWeek ? eq(climbDays.week, week) : undefined)).groupBy(climbDays.userId),
    db.select({
      userId: partyDays.userId,
      total: sql<number>`sum(${partyDays.points})`,
      before: sql<number>`coalesce(sum(${partyDays.points}) filter (where ${partyDays.day} < ${today}), 0)`,
    }).from(partyDays).where(and(inArray(partyDays.userId, userIds), inWeek ? eq(partyDays.week, week) : undefined)).groupBy(partyDays.userId),
  ]);
  const climbOf = new Map(climb.map((r) => [r.userId, r]));
  const partiesOf = new Map(parties.map((r) => [r.userId, r]));
  return userIds.map((userId) => {
    const c = climbOf.get(userId), p = partiesOf.get(userId);
    const before = Number(c?.before ?? 0) + Number(p?.before ?? 0);
    return { userId, climb: Number(c?.total ?? 0), parties: Number(p?.total ?? 0), prevTotal: inWeek && before > 0 ? before : null };
  });
}

// ---- crews -----------------------------------------------------------------------------

/** The crew's chat thread, made on first use. */
export async function crewThreadId(q: Conn, crewId: string): Promise<string> {
  const [made] = await q.insert(chatThreads).values({ kind: "crew", crewId }).onConflictDoNothing({ target: chatThreads.crewId }).returning({ id: chatThreads.id });
  if (made) return made.id;
  const [row] = await q.select({ id: chatThreads.id }).from(chatThreads).where(eq(chatThreads.crewId, crewId));
  return row.id;
}

/** A system line in a crew's chat. Inside the caller's transaction; publish it after commit. */
export async function crewLine(q: Conn, crewId: string, text: string): Promise<ChatMessage> {
  return systemLineIn(q, await crewThreadId(q, crewId), text);
}

/** The live crews someone is in. */
export const crewsOf = (q: Conn, userId: string) =>
  q.select({ crewId: crewMembers.crewId }).from(crewMembers).innerJoin(crews, and(eq(crews.id, crewMembers.crewId), isNull(crews.archivedAt))).where(eq(crewMembers.userId, userId));

/**
 * A Climb run ended: a new personal best goes in the feed, and in each of the runner's crews where it
 * climbed further than any current member ever has, a "new crew record" line. Returns the lines to publish.
 */
export async function recordRunEnded(tx: Tx, run: { id: string; userId: string; points: number; stagesCleared: number }, stageCount: number): Promise<ChatMessage[]> {
  if (run.points <= 0) return [];
  const [runner] = await tx.select({ name: users.displayName, isGuest: users.isGuest }).from(users).where(eq(users.id, run.userId));
  if (runner.isGuest) return []; // guests have no feed and no crews
  const [prev] = await tx.select({ best: sql<number>`coalesce(max(${climbRuns.points}), 0)` }).from(climbRuns)
    .where(and(eq(climbRuns.userId, run.userId), ne(climbRuns.id, run.id)));
  const clearedAll = run.stagesCleared === stageCount;
  if (run.points > Number(prev.best)) await addFeedEvent(tx, run.userId, "climb_best", { points: run.points, stagesCleared: run.stagesCleared, stageCount, clearedAll });

  const lines: ChatMessage[] = [];
  for (const { crewId } of await crewsOf(tx, run.userId)) {
    const [record] = await tx.select({ best: sql<number>`coalesce(max(${climbRuns.stagesCleared}), 0)` }).from(climbRuns)
      .innerJoin(crewMembers, and(eq(crewMembers.userId, climbRuns.userId), eq(crewMembers.crewId, crewId)))
      .where(ne(climbRuns.id, run.id));
    if (run.stagesCleared <= Number(record.best)) continue;
    const reach = clearedAll ? `cleared all ${stageCount} stages` : `reached stage ${run.stagesCleared} of ${stageCount}`;
    lines.push(await crewLine(tx, crewId, `${runner.name} ${reach}. New crew record.`));
  }
  return lines;
}

/**
 * The newest feed events, newest first, before a cursor (an event id): what `userIds` did (finishes, Climb
 * bests, streaks) and the posts of `cornerIds` (the corners the viewer follows, while they're shown).
 */
export async function feedFor(userIds: string[], opts: { before?: string; limit: number; viewerId: string; cornerIds?: string[] }) {
  const cornerIds = opts.cornerIds ?? [];
  if (!userIds.length && !cornerIds.length) return { rows: [], before: null as string | null };
  let cursor;
  if (opts.before) {
    const [b] = await db.select({ createdAt: feedEvents.createdAt }).from(feedEvents).where(eq(feedEvents.id, opts.before));
    if (b) cursor = lt(feedEvents.createdAt, b.createdAt);
  }
  // A private party's finish only for people who were in it (or hosted it).
  const visible = sql`(${feedEvents.partyId} is null or exists (select 1 from parties p where p.id = ${feedEvents.partyId} and (p.visibility = 'public' or p.created_by_user_id = ${opts.viewerId}
    or exists (select 1 from party_players v where v.party_id = p.id and v.user_id = ${opts.viewerId}))))`;
  // A deleted account's events leave the feed with it.
  const live = sql`not exists (select 1 from users d where d.id = ${feedEvents.userId} and d.deleted_at is not null)`;
  const people = userIds.length ? and(ne(feedEvents.kind, "corner_post"), inArray(feedEvents.userId, userIds)) : undefined;
  const posts = cornerIds.length
    ? sql`(${feedEvents.kind} = 'corner_post' and exists (select 1 from corner_posts cp join corners c on c.id = cp.corner_id
        where cp.id = ${feedEvents.cornerPostId} and cp.deleted_at is null and c.id in ${cornerIds} and c.status = 'unlocked' and c.archived_at is null
        and not exists (select 1 from users o where o.id = c.owner_user_id and (o.banned_at is not null or o.deleted_at is not null))))`
    : undefined;
  const rows = await db.select().from(feedEvents).where(and(or(people, posts), cursor, visible, live))
    .orderBy(desc(feedEvents.createdAt)).limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit);
  return { rows: page, before: rows.length > opts.limit ? page.at(-1)!.id : null };
}

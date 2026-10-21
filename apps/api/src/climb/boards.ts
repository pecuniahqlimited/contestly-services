/**
 * Climb leaderboards. Everyone is a Valkey sorted set per week (member = user id, score = week points);
 * Friends reads the same set for the people the viewer follows. Postgres (climb_weeks) is the record:
 * a missing set is rebuilt from it. ▲/▼ compare with the snapshot the worker takes when each Lagos day begins.
 */
import { and, eq, inArray } from "drizzle-orm";
import { climbWeeks, db, follows, users } from "@contestly/db";
import { makeRedis } from "@contestly/queue";
import { CLIMB_BOARD_TTL_SECONDS, climbBoardKey, climbBoardStartOfDayKey, type ClimbBoardRow, type ClimbDay, type Person } from "@contestly/shared";
import { competitionRanks } from "@contestly/game";
import { personColumns } from "../people.js";

let redis: ReturnType<typeof makeRedis> | undefined;
const r = () => (redis ??= makeRedis());

export async function setWeekPoints(week: ClimbDay, userId: string, points: number) {
  const key = climbBoardKey(week);
  await ensureBoard(week);
  await r().multi().zadd(key, points, userId).expire(key, CLIMB_BOARD_TTL_SECONDS).exec();
}

/** If Valkey lost the week's set, put it back from Postgres. */
async function ensureBoard(week: ClimbDay) {
  const key = climbBoardKey(week);
  if (await r().exists(key)) return;
  const rows = await db.select({ userId: climbWeeks.userId, points: climbWeeks.points }).from(climbWeeks).where(eq(climbWeeks.week, week));
  if (!rows.length) return;
  await r().multi().zadd(key, ...rows.flatMap((x) => [x.points, x.userId])).expire(key, CLIMB_BOARD_TTL_SECONDS).exec();
}

/** Competition rank on a sorted set (1 + how many scored more), or null if the user isn't on it. */
async function rankIn(key: string, userId: string): Promise<{ rank: number; points: number } | null> {
  const score = await r().zscore(key, userId);
  if (score === null) return null;
  const above = await r().zcount(key, `(${score}`, "+inf");
  return { rank: above + 1, points: Number(score) };
}

/** The points at the last paid place right now (null while fewer than `places` have scored). */
export async function prizeLine(week: ClimbDay, places: number) {
  if (places <= 0) return { places, points: null };
  await ensureBoard(week);
  const [, score] = await r().zrevrange(climbBoardKey(week), places - 1, places - 1, "WITHSCORES");
  return { places, points: score === undefined ? null : Number(score) };
}

export async function everyoneRank(week: ClimbDay, userId: string) {
  await ensureBoard(week);
  return (await rankIn(climbBoardKey(week), userId))?.rank ?? null;
}

type Scored = { userId: string; points: number; rank: number; prevRank: number | null };

/** People and their week's best run, for the rows a board shows. */
async function hydrate(week: ClimbDay, scored: Scored[], viewerId: string): Promise<ClimbBoardRow[]> {
  const ids = scored.map((s) => s.userId);
  if (!ids.length) return [];
  const [people, weeks] = await Promise.all([
    db.select(personColumns).from(users).where(inArray(users.id, ids)),
    db.select().from(climbWeeks).where(and(eq(climbWeeks.week, week), inArray(climbWeeks.userId, ids))),
  ]);
  const personOf = new Map(people.map((p) => [p.id, p as Person]));
  const weekOf = new Map(weeks.map((w) => [w.userId, w]));
  return scored.filter((s) => personOf.has(s.userId)).map((s) => ({
    rank: s.rank,
    prevRank: s.prevRank,
    person: personOf.get(s.userId)!,
    points: s.points,
    bestStagesCleared: weekOf.get(s.userId)?.bestRunStages ?? 0,
    clearedAll: weekOf.get(s.userId)?.clearedAll ?? false,
    isMe: s.userId === viewerId,
  }));
}

/** The row above the viewer (by rank, then board order) and the gap to it. */
function aheadOf(rows: ClimbBoardRow[], me: ClimbBoardRow | null) {
  if (!me) return null;
  const above = rows.filter((x) => x.points > me.points).at(-1);
  return above ? { person: above.person, gap: above.points - me.points } : null;
}

export interface Board { rows: ClimbBoardRow[]; me: ClimbBoardRow | null; ahead: { person: Person; gap: number } | null }

/** Everyone: the top `limit`, and the viewer pinned if they're further down. */
export async function everyoneBoard(week: ClimbDay, viewerId: string, limit: number): Promise<Board> {
  await ensureBoard(week);
  const key = climbBoardKey(week), sod = climbBoardStartOfDayKey(week);
  const flat = await r().zrevrange(key, 0, limit - 1, "WITHSCORES");
  const top = Array.from({ length: flat.length / 2 }, (_, i) => ({ userId: flat[2 * i], points: Number(flat[2 * i + 1]) }));
  const ranked = competitionRanks(top);
  const scored: Scored[] = await Promise.all(ranked.map(async (x) => ({ ...x, prevRank: (await rankIn(sod, x.userId))?.rank ?? null })));
  if (!scored.some((s) => s.userId === viewerId)) {
    const mine = await rankIn(key, viewerId);
    if (mine) scored.push({ userId: viewerId, ...mine, prevRank: (await rankIn(sod, viewerId))?.rank ?? null });
  }
  const all = await hydrate(week, scored, viewerId);
  const me = all.find((x) => x.isMe) ?? null;
  const rows = all.filter((x) => !x.isMe || x.rank <= limit);
  // The row above the viewer when they're outside the top: one rank up on the full board.
  let ahead = aheadOf(all, me);
  if (me && me.rank > limit) {
    const [aboveId, aboveScore] = await r().zrangebyscore(key, `(${me.points}`, "+inf", "WITHSCORES", "LIMIT", 0, 1);
    const [above] = aboveId ? await hydrate(week, [{ userId: aboveId, points: Number(aboveScore), rank: 0, prevRank: null }], viewerId) : [];
    ahead = above ? { person: above.person, gap: above.points - me.points } : null;
  }
  return { rows, me, ahead };
}

/** Friends: the viewer and everyone they follow who has played this week, ranked among themselves. */
export async function friendsBoard(week: ClimbDay, viewerId: string): Promise<Board> {
  await ensureBoard(week);
  const followed = await db.select({ id: follows.followeeId }).from(follows).where(eq(follows.followerId, viewerId));
  const ids = [viewerId, ...followed.map((f) => f.id)];
  const [now, then] = await Promise.all([r().zmscore(climbBoardKey(week), ...ids), r().zmscore(climbBoardStartOfDayKey(week), ...ids)]);
  const present = ids.map((userId, i) => ({ userId, points: now[i], prev: then[i] })).filter((x) => x.points !== null);
  const ranked = competitionRanks(present.map((x) => ({ userId: x.userId, points: Number(x.points) })));
  const prevRanked = new Map(competitionRanks(present.filter((x) => x.prev !== null).map((x) => ({ userId: x.userId, points: Number(x.prev) }))).map((x) => [x.userId, x.rank]));
  const rows = await hydrate(week, ranked.map((x) => ({ ...x, prevRank: prevRanked.get(x.userId) ?? null })), viewerId);
  const me = rows.find((x) => x.isMe) ?? null;
  return { rows, me, ahead: aheadOf(rows, me) };
}

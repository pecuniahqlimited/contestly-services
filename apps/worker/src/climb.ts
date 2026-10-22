/**
 * The Climb's scheduled work. Runs and scores are written by the API as they're played (ADR 0005);
 * the worker only marks the Lagos clock: a board snapshot as each day begins, and week close.
 */
import { and, eq, lt, notExists, sql } from "drizzle-orm";
import type { makeRedis } from "@contestly/queue";
import { climbAwards, climbWeekResults, climbWeeks, db, pinWeekPrizes, prizesForWeek, users } from "@contestly/db";
import { weekPlaces, weeklyAwards } from "@contestly/game";
import { CLIMB_BOARD_TTL_SECONDS, climbBoardKey, climbBoardStartOfDayKey, lagosDay, weekOf } from "@contestly/shared";

const EVERYONE = "everyone";

/**
 * As each Lagos day begins: fix this week's prize version if it isn't yet (on Monday that's the version
 * current as the week begins), and copy the Everyone board as it stands; ▲/▼ on the boards compare with it.
 */
export async function startDay(redis: ReturnType<typeof makeRedis>) {
  const week = weekOf(lagosDay());
  await pinWeekPrizes(db, week);
  const from = climbBoardKey(week), to = climbBoardStartOfDayKey(week);
  // A new week has no board yet: no snapshot, so everyone's ▲/▼ is blank until tomorrow.
  if (!(await redis.copy(from, to, "REPLACE"))) await redis.del(to);
  else await redis.expire(to, CLIMB_BOARD_TTL_SECONDS);
  console.log(`[climb] day start: board snapshot for week ${week}`);
}

/**
 * Close every finished week that isn't closed yet: its final Everyone places (points, then who got there
 * first) and the pending awards for the paid places. Idempotent on the unique places, and a week
 * missed while the worker was down is closed on the next run.
 */
export async function closeWeeks() {
  const current = weekOf(lagosDay());
  const open = await db.selectDistinct({ week: climbWeeks.week }).from(climbWeeks)
    .where(and(lt(climbWeeks.week, current), notExists(db.select({ one: sql`1` }).from(climbWeekResults).where(and(eq(climbWeekResults.week, climbWeeks.week), eq(climbWeekResults.scope, EVERYONE))))));
  if (!open.length) return;
  for (const { week } of open) {
    await db.transaction(async (tx) => {
      await pinWeekPrizes(tx, week); // a week nothing pinned (scores written outside the API) closes with the current version, recorded
      const { version, prizes } = await prizesForWeek(tx, week);
      // Guests climb but don't place: boards and awards need an account.
      const rows = await tx.select({ userId: climbWeeks.userId, points: climbWeeks.points, reachedAt: climbWeeks.reachedAt }).from(climbWeeks)
        .innerJoin(users, and(eq(users.id, climbWeeks.userId), eq(users.isGuest, false))).where(eq(climbWeeks.week, week));
      const places = weekPlaces(rows);
      if (places.length) await tx.insert(climbWeekResults).values(places.map((p) => ({ week, scope: EVERYONE, userId: p.userId, place: p.place, points: p.points }))).onConflictDoNothing();
      const awards = weeklyAwards(places, prizes.prizeKobo);
      if (awards.length) await tx.insert(climbAwards).values(awards.map((a) => ({ week, scope: EVERYONE, ...a }))).onConflictDoNothing();
      console.log(`[climb] week ${week} closed: ${places.length} placed, ${awards.length} pending award(s) for an admin (prizes v${version ?? "none"})`);
    });
  }
}

/**
 * The Climb's record in Postgres: ladder versions, the day and week scores every board is built from,
 * streaks, and paying a weekly prize. The rules (what clears a stage, who places where) are in
 * @contestly/game; this module only persists their results.
 */
import { and, desc, eq, sql as dsql } from "drizzle-orm";
import { DEFAULT_CLIMB_LADDER, NO_CLIMB_PRIZES, climbLadderSchema, climbPrizesSchema, nextStreak, weekOf, type ClimbDay, type ClimbLadder, type ClimbPrizes } from "@contestly/shared";
import { db, type Tx } from "./client.js";
import { climbAwards, climbDays, climbLadders, climbPrizeConfigs, climbWeekPrizes, climbWeeks, users, type ClimbRunRow, type User } from "./schema.js";
import * as ledger from "./ledger.js";
import { canBePaidCash } from "./payable.js";
import { getSocialConfig } from "./config.js";
import { addFeedEvent } from "./social.js";

type Conn = Tx | typeof db;

// ---------------------------------------------------------------- ladder

export interface LadderVersion { version: number; ladder: ClimbLadder }

/** The newest ladder. The default is written as version 1 the first time anyone asks. */
export async function currentLadder(conn: Conn = db): Promise<LadderVersion> {
  const [row] = await conn.select().from(climbLadders).orderBy(desc(climbLadders.version)).limit(1);
  if (row) return { version: row.version, ladder: climbLadderSchema.parse(row.config) };
  // Two first readers at once may each write the default; that's two identical versions, which is harmless.
  const [first] = await conn.insert(climbLadders).values({ config: DEFAULT_CLIMB_LADDER }).returning();
  return { version: first.version, ladder: first.config };
}

export async function ladderAt(version: number, conn: Conn = db): Promise<ClimbLadder> {
  const [row] = await conn.select().from(climbLadders).where(eq(climbLadders.version, version));
  if (!row) throw new Error(`climb ladder version ${version} not found`);
  return climbLadderSchema.parse(row.config);
}

/** An admin save: a new version for every run started from now on. Runs in progress keep theirs. */
export async function saveLadder(ladder: ClimbLadder, byUserId: string): Promise<LadderVersion> {
  await currentLadder(); // so the first save is version 2 and version 1 stays the default runs may already use
  const [row] = await db.insert(climbLadders).values({ config: climbLadderSchema.parse(ladder), createdByUserId: byUserId }).returning();
  return { version: row.version, ladder: row.config };
}

// ---------------------------------------------------------------- weekly prizes config

export interface PrizeVersion { version: number; prizes: ClimbPrizes; createdAt: Date }

const toPrizeVersion = (row: typeof climbPrizeConfigs.$inferSelect): PrizeVersion =>
  ({ version: row.version, prizes: climbPrizesSchema.parse({ winners: row.winners, prizeKobo: row.prizeKobo }), createdAt: row.createdAt });

/** The newest prize version, or null if an admin has never set one (then nobody wins). */
export async function currentPrizes(conn: Conn = db): Promise<PrizeVersion | null> {
  const [row] = await conn.select().from(climbPrizeConfigs).orderBy(desc(climbPrizeConfigs.version)).limit(1);
  return row ? toPrizeVersion(row) : null;
}

/** An admin save: a new version, used from the next week that begins. The week being played keeps its own. */
export async function savePrizes(prizes: ClimbPrizes, byUserId: string | null, conn: Conn = db): Promise<PrizeVersion> {
  const p = climbPrizesSchema.parse(prizes);
  const [row] = await conn.insert(climbPrizeConfigs).values({ winners: p.winners, prizeKobo: p.prizeKobo, createdByUserId: byUserId }).returning();
  return toPrizeVersion(row);
}

/** Fix the week's prizes to the version current now, unless it's already fixed. Nothing to pin before any version exists. */
export async function pinWeekPrizes(conn: Conn, week: ClimbDay) {
  await conn.execute(dsql`insert into ${climbWeekPrizes} (week, prize_version)
    select ${week}, max(version) from ${climbPrizeConfigs} having max(version) is not null
    on conflict (week) do nothing`);
}

/** The prizes a week closes with: its pinned version, else (not pinned yet) the current one. */
export async function prizesForWeek(conn: Conn, week: ClimbDay): Promise<{ version: number | null; prizes: ClimbPrizes }> {
  const [pinned] = await conn.select().from(climbWeekPrizes).innerJoin(climbPrizeConfigs, eq(climbPrizeConfigs.version, climbWeekPrizes.prizeVersion)).where(eq(climbWeekPrizes.week, week));
  const v = pinned ? toPrizeVersion(pinned.climb_prize_configs) : await currentPrizes(conn);
  return v ? { version: v.version, prizes: v.prizes } : { version: null, prizes: NO_CLIMB_PRIZES };
}

// ---------------------------------------------------------------- days, weeks, streaks

/** The day row, created if it's the first thing today, and locked for this transaction. */
async function lockDay(tx: Tx, userId: string, day: ClimbDay) {
  await tx.insert(climbDays).values({ userId, day, week: weekOf(day) }).onConflictDoNothing();
  const [row] = await tx.select().from(climbDays).where(and(eq(climbDays.userId, userId), eq(climbDays.day, day))).for("update");
  return row;
}

/** Re-add the week from its days. Returns the week's points, for the board. */
async function refreshWeek(tx: Tx, userId: string, week: ClimbDay, best?: { stages: number; clearedAll: boolean }): Promise<number> {
  await pinWeekPrizes(tx, week); // normally the worker pinned it at the week's first midnight; this covers a missed one
  const [{ points }] = await tx.select({ points: dsql<number>`coalesce(sum(${climbDays.bestRunPoints} + ${climbDays.challengePoints}), 0)::int` })
    .from(climbDays).where(and(eq(climbDays.userId, userId), eq(climbDays.week, week)));
  await tx.insert(climbWeeks).values({ userId, week, points, bestRunStages: best?.stages ?? 0, clearedAll: best?.clearedAll ?? false })
    .onConflictDoUpdate({
      target: [climbWeeks.userId, climbWeeks.week],
      set: {
        points,
        bestRunStages: dsql`greatest(${climbWeeks.bestRunStages}, ${best?.stages ?? 0})`,
        clearedAll: dsql`${climbWeeks.clearedAll} or ${best?.clearedAll ?? false}`,
        // The prize tie-break: when the points last went up.
        reachedAt: dsql`case when ${points} > ${climbWeeks.points} then now() else ${climbWeeks.reachedAt} end`,
      },
    });
  return points;
}

/** A run started: count it on its day, and extend the player's streak. Returns the week's points. */
export async function recordRunStarted(tx: Tx, user: Pick<User, "id" | "streakDays" | "lastPlayedOn">, day: ClimbDay): Promise<number> {
  await lockDay(tx, user.id, day);
  await tx.update(climbDays).set({ runs: dsql`${climbDays.runs} + 1` }).where(and(eq(climbDays.userId, user.id), eq(climbDays.day, day)));
  const [{ streakDays, lastPlayedOn }] = await tx.select({ streakDays: users.streakDays, lastPlayedOn: users.lastPlayedOn }).from(users).where(eq(users.id, user.id)).for("update");
  const streak = nextStreak(lastPlayedOn, streakDays, day);
  await tx.update(users).set({ streakDays: streak, lastPlayedOn: day, bestStreakDays: dsql`greatest(${users.bestStreakDays}, ${streak})` }).where(eq(users.id, user.id));
  if (streak > streakDays && (await getSocialConfig()).streakMilestones.includes(streak)) await addFeedEvent(tx, user.id, "streak", { days: streak });
  return refreshWeek(tx, user.id, weekOf(day));
}

/** A run's points changed (a stage cleared) or it ended: its day keeps the best run. Returns the week's points. */
export async function recordRunPoints(tx: Tx, run: ClimbRunRow, stageCount: number): Promise<number> {
  const day = await lockDay(tx, run.userId, run.day);
  if (run.points > day.bestRunPoints) {
    await tx.update(climbDays).set({ bestRunPoints: run.points, bestRunStages: run.stagesCleared, bestRunId: run.id })
      .where(and(eq(climbDays.userId, run.userId), eq(climbDays.day, run.day)));
  }
  return refreshWeek(tx, run.userId, weekOf(run.day), { stages: run.stagesCleared, clearedAll: run.stagesCleared === stageCount });
}

/** Today's challenge finished: its points join that day. Returns the week's points. */
export async function recordChallengePoints(tx: Tx, userId: string, day: ClimbDay, points: number): Promise<number> {
  await lockDay(tx, userId, day);
  await tx.update(climbDays).set({ challengePoints: points }).where(and(eq(climbDays.userId, userId), eq(climbDays.day, day)));
  return refreshWeek(tx, userId, weekOf(day));
}

// ---------------------------------------------------------------- weekly prizes

const refused = (message: string) => Object.assign(new Error(message), { statusCode: 409 });

/**
 * An admin approves a weekly prize. It's paid to the winner's cash now if their account can be paid,
 * otherwise it stays approved until it can (approving again, or payHeldAwards when they sign up, then pays it). Idempotent: the ledger key
 * is the award's, so it's never paid twice.
 */
export async function approveAward(tx: Tx, awardId: string, adminId: string) {
  const [award] = await tx.select().from(climbAwards).where(eq(climbAwards.id, awardId)).for("update");
  if (!award) throw Object.assign(new Error("not_found"), { statusCode: 404 });
  if (award.status === "rejected") throw refused("award_rejected");
  if (award.status === "void") throw refused("award_void");
  if (award.status === "paid") return award;
  const decided = award.status === "pending" ? { decidedByUserId: adminId, decidedAt: new Date() } : {};
  const [winner] = await tx.select().from(users).where(eq(users.id, award.userId));
  if (!canBePaidCash(winner)) {
    const [held] = await tx.update(climbAwards).set({ status: "approved", ...decided }).where(eq(climbAwards.id, awardId)).returning();
    return held;
  }
  await ledger.post(tx, { userId: award.userId, kind: "cash", amountKobo: award.amountKobo, type: "climb_prize", refType: "climb_award", refId: award.id, idempotencyKey: `climb_award:${award.id}` });
  const [paid] = await tx.update(climbAwards).set({ status: "paid", paidAt: new Date(), ...decided }).where(eq(climbAwards.id, awardId)).returning();
  return paid;
}

/** An admin turns a prize down. Only one that hasn't been paid. */
export async function rejectAward(tx: Tx, awardId: string, adminId: string) {
  const [award] = await tx.select().from(climbAwards).where(eq(climbAwards.id, awardId)).for("update");
  if (!award) throw Object.assign(new Error("not_found"), { statusCode: 404 });
  if (award.status === "paid") throw refused("award_paid");
  if (award.status === "void") throw refused("award_void");
  const [rejected] = await tx.update(climbAwards).set({ status: "rejected", decidedByUserId: adminId, decidedAt: new Date() }).where(eq(climbAwards.id, awardId)).returning();
  return rejected;
}

/** Pay every approved-but-unpaid award of a user who can now be paid (they just signed up). Idempotent. */
export async function payHeldAwards(tx: Tx, userId: string) {
  const held = await tx.select({ id: climbAwards.id, decidedByUserId: climbAwards.decidedByUserId }).from(climbAwards)
    .where(and(eq(climbAwards.userId, userId), eq(climbAwards.status, "approved")));
  for (const a of held) await approveAward(tx, a.id, a.decidedByUserId!);
  return held.length;
}

/**
 * The Climb's record in Postgres: ladder versions, the day and week scores every board is built from,
 * streaks, and paying a weekly prize. The rules (what clears a stage, who places where) are in
 * @contestly/game; this module only persists their results.
 */
import { and, desc, eq, sql as dsql } from "drizzle-orm";
import { DEFAULT_CLIMB_LADDER, climbLadderSchema, nextStreak, weekOf, type ClimbDay, type ClimbLadder } from "@contestly/shared";
import { db, type Tx } from "./client.js";
import { climbAwards, climbDays, climbLadders, climbWeeks, users, type ClimbRunRow, type User } from "./schema.js";
import * as ledger from "./ledger.js";

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

// ---------------------------------------------------------------- days, weeks, streaks

/** The day row, created if it's the first thing today, and locked for this transaction. */
async function lockDay(tx: Tx, userId: string, day: ClimbDay) {
  await tx.insert(climbDays).values({ userId, day, week: weekOf(day) }).onConflictDoNothing();
  const [row] = await tx.select().from(climbDays).where(and(eq(climbDays.userId, userId), eq(climbDays.day, day))).for("update");
  return row;
}

/** Re-add the week from its days. Returns the week's points, for the board. */
async function refreshWeek(tx: Tx, userId: string, week: ClimbDay, best?: { stages: number; clearedAll: boolean }): Promise<number> {
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
  await tx.update(users).set({ streakDays: nextStreak(lastPlayedOn, streakDays, day), lastPlayedOn: day }).where(eq(users.id, user.id));
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

/**
 * Whether cash can be paid to this account. Payouts only go to signed-in accounts: today that means a
 * phone number verified at sign-in. Row 5 (Firebase Auth) changes only this body.
 */
export const canBePaidCash = (u: Pick<User, "phone" | "isSystem">) => !u.isSystem && !!u.phone;

const refused = (message: string) => Object.assign(new Error(message), { statusCode: 409 });

/**
 * An admin approves a weekly prize. It's paid to the winner's cash now if their account can be paid,
 * otherwise it stays approved until it can (approving again then pays it). Idempotent: the ledger key
 * is the award's, so it's never paid twice.
 */
export async function approveAward(tx: Tx, awardId: string, adminId: string) {
  const [award] = await tx.select().from(climbAwards).where(eq(climbAwards.id, awardId)).for("update");
  if (!award) throw Object.assign(new Error("not_found"), { statusCode: 404 });
  if (award.status === "rejected") throw refused("award_rejected");
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
  const [rejected] = await tx.update(climbAwards).set({ status: "rejected", decidedByUserId: adminId, decidedAt: new Date() }).where(eq(climbAwards.id, awardId)).returning();
  return rejected;
}

/**
 * Today's challenge: an admin-written quiz for one Lagos day. One go per player, options shuffled per
 * player, each question on the server's clock like a Climb round (ADR 0005). Its points join the day
 * it was written for.
 */
import { and, asc, eq } from "drizzle-orm";
import { climbChallengeAnswers, climbChallengeAttempts, climbChallenges, db, getClimbSettings, recordChallengePoints, type ClimbAttemptRow, type ClimbChallengeRow, type Tx, type User } from "@contestly/db";
import { challengePoints, closesAt, expired, onTime, shuffle } from "@contestly/game";
import { lagosDay, weekOf, type ChallengeAnswerResponse, type ChallengePlayState, type ClimbSettings, type TodayChallenge } from "@contestly/shared";
import { setWeekPoints } from "./boards.js";
import { freshRng } from "./rng.js";

const fail = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

export const challengeFor = async (day: string, conn: Tx | typeof db = db) =>
  (await conn.select().from(climbChallenges).where(eq(climbChallenges.day, day)))[0] ?? null;

const answersOf = (tx: Tx | typeof db, attemptId: string) =>
  tx.select().from(climbChallengeAnswers).where(eq(climbChallengeAnswers.attemptId, attemptId)).orderBy(asc(climbChallengeAnswers.idx));

const attemptOf = async (conn: Tx | typeof db, challengeId: string, userId: string) =>
  (await conn.select().from(climbChallengeAttempts).where(and(eq(climbChallengeAttempts.challengeId, challengeId), eq(climbChallengeAttempts.userId, userId))))[0] ?? null;

/** The challenge as a player sees it: never its questions. */
export function challengeCard(ch: ClimbChallengeRow, attempt: ClimbAttemptRow | null): TodayChallenge {
  const state = !attempt ? "not_started" : attempt.finishedAt ? "finished" : "in_progress";
  return {
    id: ch.id, day: ch.day, title: ch.title, questionCount: ch.questions.length, seconds: ch.seconds, maxPoints: ch.maxPoints,
    attempt: { state, correct: attempt?.correct ?? 0, points: attempt?.points ?? 0 },
  };
}

/** For Climb home: today's challenge and how the player stands with it, or null when none is scheduled. */
export async function todayChallenge(user: User): Promise<TodayChallenge | null> {
  const ch = await challengeFor(lagosDay());
  return ch ? challengeCard(ch, await attemptOf(db, ch.id, user.id)) : null;
}

interface Ctx { tx: Tx; ch: ClimbChallengeRow; settings: ClimbSettings; weekPoints: number | null }

async function openQuestion(c: Ctx, attemptId: string, idx: number, opensAtMs: number) {
  await c.tx.insert(climbChallengeAnswers).values({ attemptId, idx, opensAt: new Date(opensAtMs), closesAt: new Date(closesAt(opensAtMs, c.ch.seconds)) });
}

/** A question was decided at `decidedAtMs`: open the next after the reveal pause, or finish and bank the points. */
async function advance(c: Ctx, attempt: ClimbAttemptRow, idx: number, decidedAtMs: number): Promise<{ attempt: ClimbAttemptRow; nextOpensAtMs: number | null }> {
  const decided = (await answersOf(c.tx, attempt.id)).filter((a) => a.correct !== null);
  const correct = decided.filter((a) => a.correct).length;
  const total = c.ch.questions.length;
  if (idx + 1 < total) {
    const at = decidedAtMs + c.settings.revealSeconds * 1000;
    await openQuestion(c, attempt.id, idx + 1, at);
    const [next] = await c.tx.update(climbChallengeAttempts).set({ correct }).where(eq(climbChallengeAttempts.id, attempt.id)).returning();
    return { attempt: next, nextOpensAtMs: at };
  }
  const points = challengePoints(correct, total, c.ch.maxPoints);
  const [done] = await c.tx.update(climbChallengeAttempts).set({ correct, points, finishedAt: new Date(decidedAtMs) }).where(eq(climbChallengeAttempts.id, attempt.id)).returning();
  c.weekPoints = await recordChallengePoints(c.tx, attempt.userId, c.ch.day, points);
  return { attempt: done, nextOpensAtMs: null };
}

/** Every question whose clock ran out unanswered is wrong; play forward to now. */
async function catchUp(c: Ctx, attempt: ClimbAttemptRow, nowMs: number): Promise<ClimbAttemptRow> {
  while (!attempt.finishedAt) {
    const cur = (await answersOf(c.tx, attempt.id)).at(-1)!;
    if (cur.correct !== null || !expired(nowMs, cur.closesAt.getTime(), c.settings.latencyAllowanceMs)) return attempt;
    await c.tx.update(climbChallengeAnswers).set({ correct: false }).where(and(eq(climbChallengeAnswers.attemptId, attempt.id), eq(climbChallengeAnswers.idx, cur.idx)));
    ({ attempt } = await advance(c, attempt, cur.idx, cur.closesAt.getTime() + c.settings.latencyAllowanceMs));
  }
  return attempt;
}

async function playState(c: Ctx, attempt: ClimbAttemptRow, nowMs: number): Promise<ChallengePlayState> {
  const card = challengeCard(c.ch, attempt);
  if (attempt.finishedAt) return { challenge: card, question: null, nextOpensAt: null };
  const cur = (await answersOf(c.tx, attempt.id)).at(-1)!;
  if (cur.opensAt.getTime() > nowMs) return { challenge: card, question: null, nextOpensAt: cur.opensAt.toISOString() };
  const q = c.ch.questions[cur.idx];
  return {
    challenge: card,
    question: { idx: cur.idx, total: c.ch.questions.length, prompt: q.prompt, options: attempt.optionOrder[cur.idx].map((i) => q.options[i]), opensAt: cur.opensAt.toISOString(), closesAt: cur.closesAt.toISOString() },
    nextOpensAt: null,
  };
}

/** Run against today's challenge (404 if none is scheduled); a finished attempt's week points go to the board after commit. */
async function inTx<T>(user: User, work: (c: Ctx) => Promise<T>): Promise<T> {
  const settings = await getClimbSettings();
  const ch = await challengeFor(lagosDay());
  if (!ch) throw fail("no_challenge_today", 404);
  let weekPoints: number | null = null;
  const result = await db.transaction(async (tx) => {
    const c: Ctx = { tx, ch, settings, weekPoints: null };
    const out = await work(c);
    weekPoints = c.weekPoints;
    return out;
  });
  if (weekPoints !== null) await setWeekPoints(weekOf(ch.day), user.id, weekPoints);
  return result;
}

const lockAttempt = async (c: Ctx, userId: string) => {
  const [a] = await c.tx.select().from(climbChallengeAttempts).where(and(eq(climbChallengeAttempts.challengeId, c.ch.id), eq(climbChallengeAttempts.userId, userId))).for("update");
  return a ?? null;
};

/** Start today's challenge, or pick up the one go already under way. A finished attempt is returned as is. */
export async function startChallenge(user: User): Promise<ChallengePlayState> {
  return inTx(user, async (c) => {
    const now = Date.now();
    const rng = freshRng();
    const optionOrder = c.ch.questions.map((q) => shuffle(rng, q.options.map((_, i) => i)));
    const [created] = await c.tx.insert(climbChallengeAttempts).values({ challengeId: c.ch.id, userId: user.id, optionOrder }).onConflictDoNothing().returning();
    if (created) await openQuestion(c, created.id, 0, now);
    const attempt = await catchUp(c, (await lockAttempt(c, user.id))!, now);
    return playState(c, attempt, now);
  });
}

export async function challengeState(user: User): Promise<ChallengePlayState> {
  return inTx(user, async (c) => {
    const now = Date.now();
    const found = await lockAttempt(c, user.id);
    if (!found) return { challenge: challengeCard(c.ch, null), question: null, nextOpensAt: null };
    return playState(c, await catchUp(c, found, now), now);
  });
}

/** Grade one question (first answer only; late is wrong). `index` is in this player's option order. */
export async function answerChallenge(user: User, idx: number, index: number): Promise<ChallengeAnswerResponse> {
  return inTx(user, async (c) => {
    const receivedAt = Date.now();
    const found = await lockAttempt(c, user.id);
    if (!found) throw fail("challenge_not_started", 409);
    const attempt = await catchUp(c, found, receivedAt);
    if (attempt.finishedAt) throw fail("challenge_over", 409);
    const cur = (await answersOf(c.tx, attempt.id)).at(-1)!;
    if (cur.idx !== idx) throw fail("question_closed", 409);
    if (cur.opensAt.getTime() > receivedAt) throw fail("question_not_open", 409);
    const order = attempt.optionOrder[idx];
    const q = c.ch.questions[idx];
    const original = order[index] ?? -1;
    const correct = onTime(receivedAt, cur.closesAt.getTime(), c.settings.latencyAllowanceMs) && original === q.correctIndex;
    await c.tx.update(climbChallengeAnswers).set({ answer: original, answeredAt: new Date(receivedAt), correct }).where(and(eq(climbChallengeAnswers.attemptId, attempt.id), eq(climbChallengeAnswers.idx, idx)));
    const moved = await advance(c, attempt, idx, receivedAt);
    return {
      correct,
      correctIndex: order.indexOf(q.correctIndex),
      challenge: challengeCard(c.ch, moved.attempt),
      nextOpensAt: moved.nextOpensAtMs === null ? null : new Date(moved.nextOpensAtMs).toISOString(),
    };
  });
}

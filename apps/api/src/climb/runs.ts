/**
 * Climb runs, server-authoritative (ADR 0005): the server makes every round, stamps when it opens and
 * when the answer arrives, keeps the answer until the round is decided, and grades. Rounds are
 * scheduled, so a run left alone is played forward (its unanswered rounds missed) the next time it's
 * touched. Rules come from @contestly/game; scores are persisted through @contestly/db.
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import {
  activeWordsFor, climbRounds, climbRuns, currentLadder, db, getClimbSettings, ladderAt, recordRunEnded, recordRunPoints, recordRunStarted, users,
  type ClimbRoundRow, type ClimbRunRow, type Tx, type User,
} from "@contestly/db";
import {
  afterRound, closesAt, expired, generateRound, gradeRound, nextOpensAt, NoWordsFit, onTime, pickRoundType, roundReveal, roundView, roundWords, wordGameOf,
  type RunStep, type StageOutcome, type WordHistory,
} from "@contestly/game";
import { lagosDay, weekOf, type ChatMessage, type ClimbAnswerResponse, type ClimbGameType, type ClimbLadder, type ClimbRound, type ClimbRun, type ClimbRunState, type ClimbSettings } from "@contestly/shared";
import { setWeekPoints } from "./boards.js";
import { publishLine } from "../chats.js";
import { freshRng } from "./rng.js";

const fail = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

/** What a transaction changed on the boards, applied to Valkey after it commits. */
type BoardWrite = { week: string; userId: string; points: number };

/** `lines`: crew "new record" lines written in the transaction, published after it commits. */
interface Ctx { tx: Tx; ladder: ClimbLadder; settings: ClimbSettings; boards: BoardWrite[]; lines: ChatMessage[]; log: FastifyBaseLogger }

const position = (run: ClimbRunRow) => ({ stageIdx: run.stageIdx, stagesCleared: run.stagesCleared, points: run.points });

/** Runs whose words count as "recent": word games repeat these only when nothing else is left. This run is one of them. */
const RECENT_RUNS = 3;
/** Runs whose words count as already seen: word games prefer words from further back, or new ones. */
const SEEN_RUNS = 20;

/** Words the player was given in their latest runs (this one included), newest runs first. */
async function wordHistory(tx: Tx, userId: string): Promise<WordHistory> {
  const runs = await tx.select({ id: climbRuns.id }).from(climbRuns).where(eq(climbRuns.userId, userId)).orderBy(desc(climbRuns.startedAt)).limit(SEEN_RUNS);
  if (!runs.length) return { seen: new Set(), recent: new Set() };
  const rounds = await tx.select({ runId: climbRounds.runId, type: climbRounds.gameType, payload: climbRounds.payload }).from(climbRounds).where(inArray(climbRounds.runId, runs.map((r) => r.id)));
  const recentRuns = new Set(runs.slice(0, RECENT_RUNS).map((r) => r.id));
  const seen = new Set<string>(), recent = new Set<string>();
  for (const r of rounds) for (const w of roundWords(r.type as ClimbGameType, r.payload)) {
    seen.add(w);
    if (recentRuns.has(r.runId)) recent.add(w);
  }
  return { seen, recent };
}

/**
 * Open a stage's round (`roundIdx` 0-based within the stage) from the run's ladder settings; its clock comes from the round
 * itself. A word game short of words uses other lengths or words met before (logged). Only when its list has no usable
 * word at all is the run ended, as abandoned with its banked points kept (The Climb has no entry, so there's nothing to
 * refund). The run as it now stands.
 */
async function openRound(c: Ctx, run: ClimbRunRow, seq: number, stageIdx: number, roundIdx: number, opensAtMs: number): Promise<ClimbRunRow> {
  const rng = freshRng();
  const type = pickRoundType(c.ladder, stageIdx, rng);
  const wordGame = wordGameOf(type);
  let made;
  try {
    made = generateRound(c.ladder.stages[stageIdx], type, roundIdx, {
      rng, words: wordGame ? await activeWordsFor(c.tx, wordGame) : [], history: wordGame ? await wordHistory(c.tx, run.userId) : undefined,
    });
  } catch (err) {
    if (!(err instanceof NoWordsFit)) throw err;
    c.log.error({ runId: run.id, userId: run.userId, stage: stageIdx + 1, type }, "climb: no usable word on the list, run abandoned");
    return abandon(c, run, opensAtMs);
  }
  if (made.words?.fallback) c.log.warn({ runId: run.id, stage: stageIdx + 1, round: roundIdx + 1, type, words: made.words }, "climb: word list short, round made from a fallback pool");
  await c.tx.insert(climbRounds).values({
    runId: run.id, seq, stageIdx, gameType: type, payload: made.payload,
    opensAt: new Date(opensAtMs), closesAt: new Date(closesAt(opensAtMs, made.seconds)),
  });
  return run;
}

/** End a run early as abandoned: its banked points still count as a run. */
async function abandon(c: Ctx, run: ClimbRunRow, atMs: number): Promise<ClimbRunRow> {
  const [ended] = await c.tx.update(climbRuns).set({ status: "abandoned", endedAt: new Date(atMs) }).where(eq(climbRuns.id, run.id)).returning();
  c.lines.push(...await recordRunEnded(c.tx, ended, c.ladder.stages.length));
  return ended;
}

const stageRounds = (tx: Tx, runId: string, stageIdx: number) =>
  tx.select().from(climbRounds).where(and(eq(climbRounds.runId, runId), eq(climbRounds.stageIdx, stageIdx))).orderBy(asc(climbRounds.seq));

/** The run's newest round. Every run opens its first round when it starts, so there always is one. */
const latestRound = async (tx: Tx, runId: string): Promise<ClimbRoundRow> =>
  (await tx.select().from(climbRounds).where(eq(climbRounds.runId, runId)).orderBy(desc(climbRounds.seq)).limit(1))[0];

/**
 * A round was just decided (answered, or its clock ran out) at `decidedAtMs`: move the run on. Banks a
 * cleared stage's points on the run's day, ends the run on a miss or after the last stage, and
 * otherwise schedules the next round.
 */
async function advance(c: Ctx, run: ClimbRunRow, round: ClimbRoundRow, decidedAtMs: number): Promise<{ run: ClimbRunRow; step: RunStep; nextOpensAtMs: number | null }> {
  const played = await stageRounds(c.tx, run.id, round.stageIdx);
  const step = afterRound(c.ladder, position(run), played.map((x) => x.correct === true));
  if (step.outcome === "continue") {
    const at = nextOpensAt(decidedAtMs, step.outcome, c.settings);
    const after = await openRound(c, run, round.seq + 1, run.stageIdx, played.length, at);
    return { run: after, step, nextOpensAtMs: after.status === "active" ? at : null };
  }
  const stageMs = step.outcome === "cleared" ? [...run.stageMs, decidedAtMs - played[0].opensAt.getTime()] : run.stageMs;
  const status = !step.ended ? "active" : step.outcome === "missed" ? "missed" : "cleared";
  const [next] = await c.tx.update(climbRuns).set({ ...step.position, status, stageMs, endedAt: step.ended ? new Date(decidedAtMs) : null }).where(eq(climbRuns.id, run.id)).returning();
  if (step.outcome === "cleared") c.boards.push({ week: weekOf(next.day), userId: next.userId, points: await recordRunPoints(c.tx, next, c.ladder.stages.length) });
  if (step.ended) {
    // A new personal best goes in the feed; beating every crewmate's climb is a crew record.
    c.lines.push(...await recordRunEnded(c.tx, next, c.ladder.stages.length));
    return { run: next, step, nextOpensAtMs: null };
  }
  const at = nextOpensAt(decidedAtMs, step.outcome, c.settings);
  const after = await openRound(c, next, round.seq + 1, next.stageIdx, 0, at);
  return { run: after, step, nextOpensAtMs: after.status === "active" ? at : null };
}

/** Play an active run forward to now: every round whose clock (plus the allowance) ran out unanswered is a miss. */
async function catchUp(c: Ctx, run: ClimbRunRow, nowMs: number): Promise<ClimbRunRow> {
  while (run.status === "active") {
    const cur = await latestRound(c.tx, run.id);
    if (cur.correct !== null || !expired(nowMs, cur.closesAt.getTime(), c.settings.latencyAllowanceMs)) return run;
    await c.tx.update(climbRounds).set({ correct: false }).where(eq(climbRounds.id, cur.id));
    ({ run } = await advance(c, run, { ...cur, correct: false }, cur.closesAt.getTime() + c.settings.latencyAllowanceMs));
  }
  return run;
}

async function lockRun(tx: Tx, user: User, runId: string) {
  const [run] = await tx.select().from(climbRuns).where(and(eq(climbRuns.id, runId), eq(climbRuns.userId, user.id))).for("update");
  if (!run) throw fail("not_found", 404);
  return run;
}

async function runView(tx: Tx, ladder: ClimbLadder, run: ClimbRunRow): Promise<ClimbRun> {
  const rounds = await stageRounds(tx, run.id, run.stageIdx);
  const decided = rounds.filter((x) => x.correct !== null);
  return {
    id: run.id, status: run.status, ladderVersion: run.ladderVersion,
    stage: run.stageIdx + 1, stageCount: ladder.stages.length, stagesCleared: run.stagesCleared, points: run.points,
    stageRight: decided.filter((x) => x.correct).length, stagePlayed: decided.length,
    startedAt: run.startedAt.toISOString(), endedAt: run.endedAt?.toISOString() ?? null,
  };
}

const MS_PER_SECOND = 1000;

async function roundPublic(tx: Tx, ladder: ClimbLadder, round: ClimbRoundRow): Promise<ClimbRound> {
  const stage = ladder.stages[round.stageIdx];
  const inStage = (await stageRounds(tx, round.runId, round.stageIdx)).findIndex((x) => x.id === round.id) + 1;
  const type = round.gameType as ClimbGameType;
  return {
    id: round.id, type, view: roundView(type, round.payload), stage: round.stageIdx + 1, round: inStage, rounds: stage.rounds, toClear: stage.toClear,
    seconds: Math.round((round.closesAt.getTime() - round.opensAt.getTime()) / MS_PER_SECOND), opensAt: round.opensAt.toISOString(), closesAt: round.closesAt.toISOString(),
  } as ClimbRound;
}

/** The run as the player may see it now: the open round's view, or when the next one opens. */
async function state(c: Ctx, run: ClimbRunRow, nowMs: number): Promise<ClimbRunState> {
  const view = await runView(c.tx, c.ladder, run);
  const serverNow = new Date(nowMs).toISOString();
  if (run.status !== "active") return { run: view, round: null, nextOpensAt: null, serverNow };
  const cur = await latestRound(c.tx, run.id);
  if (cur.opensAt.getTime() > nowMs) return { run: view, round: null, nextOpensAt: cur.opensAt.toISOString(), serverNow };
  return { run: view, round: await roundPublic(c.tx, c.ladder, cur), nextOpensAt: null, serverNow };
}

async function inTx<T>(log: FastifyBaseLogger, ladderOf: (tx: Tx) => Promise<ClimbLadder>, work: (c: Ctx) => Promise<T>): Promise<T> {
  const settings = await getClimbSettings();
  const boards: BoardWrite[] = [];
  const lines: ChatMessage[] = [];
  const result = await db.transaction(async (tx) => work({ tx, ladder: await ladderOf(tx), settings, boards, lines, log }));
  // After commit, so the board never shows points the record doesn't have.
  for (const b of boards) await setWeekPoints(b.week, b.userId, b.points);
  for (const line of lines) await publishLine(line);
  return result;
}

/** The player's active run, if any (played forward to now). */
export async function activeRunId(user: User): Promise<string | null> {
  const [run] = await db.select({ id: climbRuns.id }).from(climbRuns).where(and(eq(climbRuns.userId, user.id), eq(climbRuns.status, "active")));
  return run?.id ?? null;
}

/** Start a run on the current ladder. A run still going is ended first (abandoned, its banked points kept). */
export async function startRun(user: User, log: FastifyBaseLogger): Promise<ClimbRunState> {
  let ladderVersion = 0;
  return inTx(log, async (tx) => {
    const { version, ladder } = await currentLadder(tx);
    ladderVersion = version;
    return ladder;
  }, async (c) => {
    const now = Date.now();
    await c.tx.select({ id: users.id }).from(users).where(eq(users.id, user.id)).for("update"); // one start at a time per player
    const [old] = await c.tx.select().from(climbRuns).where(and(eq(climbRuns.userId, user.id), eq(climbRuns.status, "active"))).for("update");
    if (old) {
      const oldLadder = await ladderAt(old.ladderVersion, c.tx);
      const played = await catchUp({ ...c, ladder: oldLadder }, old, now);
      if (played.status === "active") await abandon({ ...c, ladder: oldLadder }, played, now);
    }
    const day = lagosDay(new Date(now));
    const [run] = await c.tx.insert(climbRuns).values({ userId: user.id, ladderVersion, day }).returning();
    c.boards.push({ week: weekOf(day), userId: user.id, points: await recordRunStarted(c.tx, user, day) });
    return state(c, await openRound(c, run, 0, 0, 0, now), now);
  });
}

/** The ladder version a player's run was started on; 404 if it isn't their run. */
async function runLadderVersion(user: User, runId: string) {
  const [found] = await db.select({ v: climbRuns.ladderVersion }).from(climbRuns).where(and(eq(climbRuns.id, runId), eq(climbRuns.userId, user.id)));
  if (!found) throw fail("not_found", 404);
  return found.v;
}

export async function getRun(user: User, runId: string, log: FastifyBaseLogger): Promise<ClimbRunState> {
  const version = await runLadderVersion(user, runId);
  return inTx(log, (tx) => ladderAt(version, tx), async (c) => {
    const now = Date.now();
    const run = await catchUp(c, await lockRun(c.tx, user, runId), now);
    return state(c, run, now);
  });
}

/** Grade the open round (first answer only; late is wrong) and decide its stage. */
export async function answerRound(user: User, runId: string, roundId: string, answer: unknown, log: FastifyBaseLogger): Promise<ClimbAnswerResponse> {
  const version = await runLadderVersion(user, runId);
  return inTx(log, (tx) => ladderAt(version, tx), async (c) => {
    const receivedAt = Date.now(); // stamped before anything else, so the work below never costs the player time
    const run = await catchUp(c, await lockRun(c.tx, user, runId), receivedAt);
    if (run.status !== "active") throw fail("run_over", 409);
    const cur = await latestRound(c.tx, run.id);
    if (cur.id !== roundId) throw fail("round_closed", 409);
    if (cur.opensAt.getTime() > receivedAt) throw fail("round_not_open", 409);
    const type = cur.gameType as ClimbGameType;
    const correct = onTime(receivedAt, cur.closesAt.getTime(), c.settings.latencyAllowanceMs) && gradeRound(type, cur.payload, answer);
    await c.tx.update(climbRounds).set({ answer: answer ?? null, answeredAt: new Date(receivedAt), correct }).where(eq(climbRounds.id, cur.id));
    const moved = await advance(c, run, { ...cur, correct }, receivedAt);
    return {
      correct,
      reveal: { type, answer: roundReveal(type, cur.payload) } as ClimbAnswerResponse["reveal"],
      stageOutcome: moved.step.outcome satisfies StageOutcome,
      run: await runView(c.tx, c.ladder, moved.run),
      nextOpensAt: moved.nextOpensAtMs === null ? null : new Date(moved.nextOpensAtMs).toISOString(),
      serverNow: new Date(receivedAt).toISOString(),
    };
  });
}

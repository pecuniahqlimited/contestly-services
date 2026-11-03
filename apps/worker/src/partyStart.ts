/**
 * Starting a party at startsAt, or cancelling it with refunds, and the sweep that catches any party whose
 * start job never ran. Kept out of the worker's entry file so it can run against a real database in tests;
 * what it tells the outside world (room events, chat lines, follow-up jobs) is passed in.
 */
import { and, asc, count, eq, lte } from "drizzle-orm";
import { db, getPartyConfig, getQuestionsConfig, parties, partyAnswers, partyLifecycleLine, partyLineByKey, partyPlayers, partyQuestions, refundAndCancel, seenInSet, type Party, type Tx } from "@contestly/db";
import { stallThresholdSeconds, type ChatMessage } from "@contestly/shared";
import { standingsFromRecords } from "@contestly/game";

/**
 * What the party jobs tell the outside world, all after their transaction commits, and all safe to repeat:
 * a replayed job sends them again (rooms ignore a repeated event, and drop a line id they've relayed), and
 * every follow-up job is queued under a fixed id, so a second add is a no-op.
 */
export interface StartDeps {
  /** Tell the party's room (the `party:events` channel). */
  emit(ev: { partyId: string; status: string }): Promise<unknown>;
  /** Deliver a committed system line to the party's room and inboxes. */
  publishLine(line: ChatMessage): Promise<unknown>;
  /** Queue the questions service: swap seen questions, or build a set that was never started. */
  queueQuestions(kind: "reseal_for_roster" | "generate_set", partyId: string, jobId: string): Promise<unknown>;
  /** Queue the first watchdog check of a live party. */
  queueWatchdog(partyId: string, jobId: string): Promise<unknown>;
}

/** The fixed job ids of what a start queues (BullMQ ignores an add whose id it already holds). */
export const startJobIds = {
  reseal_for_roster: (partyId: string) => `reseal-${partyId}`,
  generate_set: (partyId: string) => `generate-set-${partyId}-start`,
  watchdog: (partyId: string) => `watchdog-${partyId}-start`,
};

export const GENERATION_FAILED_MESSAGE = "We couldn't build the questions for this party. Everyone has been refunded.";

/**
 * Tell the room and the chat a party was cancelled: only once the cancel's transaction has committed, so
 * a cancel that rolls back (a deadlock at commit, say) never closes a room whose party then goes on.
 */
export async function announceCancelled(deps: Pick<StartDeps, "emit" | "publishLine">, partyId: string, line: ChatMessage) {
  await deps.publishLine(line);
  await deps.emit({ partyId, status: "cancelled" });
}

/**
 * A live party's set couldn't be made playable (the start-time re-check, or a build still running at
 * start, exhausted its retries): fail closed, refund and cancel, unless the set became ready meanwhile.
 * Money only ever moves here, never in questions. True when this call cancelled it.
 */
export async function cancelFailedGeneration(deps: Pick<StartDeps, "emit" | "publishLine">, partyId: string): Promise<boolean> {
  const line = await db.transaction(async (tx) => {
    const [p] = await tx.select().from(parties).where(eq(parties.id, partyId)).for("update");
    if (p && cancelledLiveBySystem(p)) return partyLineByKey(tx, partyId, "cancelled"); // a replay: announce it again
    if (!p || p.status !== "live") return null; // before start a failed set never cancels: the host retries
    if (p.questionsStatus === "ready") return null; // a retry made the set playable after all; let the round run
    const out = await refundAndCancel(tx, p, GENERATION_FAILED_MESSAGE);
    console.log(`[party] ${p.title}: question generation failed, cancelled and ${out.players} refunded`);
    return out.line;
  });
  if (!line) return false;
  await announceCancelled(deps, partyId, line);
  return true;
}

/** Cancelled by the system after it went live (a refund job, the stall check): what a replayed refund job finds. */
const cancelledLiveBySystem = (p: Party) => p.status === "cancelled" && p.cancelledBy === "system" && p.liveAt !== null;

export const INTERRUPTED_MESSAGE = "The round was interrupted. Everyone has been refunded.";

/** The watchdog's refund: the room vanished mid-round, or the set never arrived. True when this call cancelled it. */
export async function refundInterrupted(deps: Pick<StartDeps, "emit" | "publishLine">, partyId: string, generationStalled: boolean): Promise<boolean> {
  const line = await db.transaction(async (tx) => {
    const [p] = await tx.select().from(parties).where(eq(parties.id, partyId)).for("update");
    if (p && cancelledLiveBySystem(p)) return partyLineByKey(tx, partyId, "cancelled"); // a replay: announce it again
    if (!p || p.status !== "live") return null;
    const out = await refundAndCancel(tx, p, generationStalled ? GENERATION_FAILED_MESSAGE : INTERRUPTED_MESSAGE);
    console.log(`[party] ${p.title}: ${generationStalled ? "generation stalled" : "room disappeared mid-round"}, cancelled and ${out.players} refunded`);
    return out.line;
  });
  if (!line) return false;
  await announceCancelled(deps, partyId, line);
  return true;
}

/** A curate party may start only when its whole play order exists and every question in it was approved. */
async function curateSetApproved(tx: Tx, p: Party): Promise<boolean> {
  const rows = await tx.select({ status: partyQuestions.status }).from(partyQuestions).where(and(eq(partyQuestions.partyId, p.id), eq(partyQuestions.reserve, false)));
  return rows.length === p.questionCount && rows.every((r) => r.status === "pending");
}

/**
 * What a sealed set needs at start (ADR 0002). It was built at creation, so normally the only work
 * is checking the final roster: if nobody seated has seen any of its questions it starts as is,
 * instantly; otherwise just those are swapped first.
 */
type StartFollowUp = "none" | "reseal" | "generate";

async function sealedFollowUp(p: Party): Promise<StartFollowUp> {
  if (p.mode !== "sealed") return "none";
  if (p.questionsStatus === "not_started") return "generate"; // a party from before sets were built at creation
  if (p.questionsStatus === "generating") return "none"; // still building: it runs the roster check itself when done
  return (await seenInSet(p.id)).length ? "reseal" : "none";
}

/**
 * live: it started. cancelled: refunded and cancelled. replayed: it had already started or been cancelled at
 * its start (a retry after a failure past the commit), and this call finished what that one began.
 * skipped: it wasn't open, and isn't this start's to finish (over, cancelled some other way, or gone).
 */
export type StartOutcome = "live" | "cancelled" | "replayed" | "skipped";

type StartDecision =
  | { outcome: "live" | "replayed"; status: "live"; line: ChatMessage | null; followUp: StartFollowUp }
  | { outcome: "cancelled" | "replayed"; status: "cancelled"; line: ChatMessage | null }
  | { outcome: "skipped" };

/**
 * Start a party at startsAt, or cancel + refund if too few people joined or it has nothing to play. Everything
 * the outside world hears comes after the commit; a replay that finds the party already live (or cancelled
 * before it ever went live) sends it all again: the event, the chat line, and the follow-up jobs.
 */
export async function startOrCancel(deps: StartDeps, partyId: string): Promise<StartOutcome> {
  const cfg = await getPartyConfig();
  const cancel = async (tx: Tx, p: Party, message: string, why: string): Promise<StartDecision> => {
    const out = await refundAndCancel(tx, p, message);
    console.log(`[party] ${p.title}: ${why}, cancelled and ${out.players} refunded`);
    return { outcome: "cancelled", status: "cancelled", line: out.line };
  };
  const decided = await db.transaction(async (tx): Promise<StartDecision> => {
    const [p] = await tx.select().from(parties).where(eq(parties.id, partyId)).for("update");
    if (!p) return { outcome: "skipped" };
    if (p.status === "live") {
      // Already started: the questions follow-up only while it's still pending (the set is still being made).
      const followUp = p.questionsStatus === "generating" ? (p.startFollowUp ?? "none") : "none";
      return { outcome: "replayed", status: "live", line: await partyLineByKey(tx, partyId, "live"), followUp };
    }
    if (p.status === "cancelled" && p.cancelledBy === "system" && !p.liveAt) {
      return { outcome: "replayed", status: "cancelled", line: await partyLineByKey(tx, partyId, "cancelled") };
    }
    if (p.status !== "open") return { outcome: "skipped" };
    const [{ n }] = await tx.select({ n: count() }).from(partyPlayers).where(eq(partyPlayers.partyId, partyId));
    if (Number(n) < cfg.minPlayers) return cancel(tx, p, "Not enough players joined. Everyone has been refunded.", `${n} player(s), fewer than ${cfg.minPlayers}`);
    if (p.mode === "curate" && !(await curateSetApproved(tx, p))) return cancel(tx, p, "The host didn't finish reviewing the questions. Everyone has been refunded.", "curate set not approved at start");
    if (p.mode === "sealed" && p.questionsStatus === "failed") return cancel(tx, p, GENERATION_FAILED_MESSAGE, "question set still failed at start");
    const followUp = await sealedFollowUp(p);
    await tx.update(parties).set({
      status: "live",
      liveAt: new Date(),
      ...(followUp === "none" ? {} : { questionsStatus: "generating" as const, startFollowUp: followUp }),
    }).where(eq(parties.id, partyId));
    const line = await partyLifecycleLine(tx, partyId, "live", "The party is starting. Good luck!");
    console.log(`[party] ${p.title} is live with ${n} players${followUp === "reseal" ? "; swapping questions a player has already seen" : ""}`);
    return { outcome: "live", status: "live", line, followUp };
  });
  if (decided.outcome === "skipped") return "skipped";
  if (decided.status === "cancelled") {
    if (decided.line) await announceCancelled(deps, partyId, decided.line);
    else await deps.emit({ partyId, status: "cancelled" });
    return decided.outcome;
  }
  if (decided.line) await deps.publishLine(decided.line);
  // After commit, so the room never reads the set's state from before this transaction.
  await deps.emit({ partyId, status: "live" });
  if (decided.followUp === "reseal") await deps.queueQuestions("reseal_for_roster", partyId, startJobIds.reseal_for_roster(partyId));
  if (decided.followUp === "generate") await deps.queueQuestions("generate_set", partyId, startJobIds.generate_set(partyId));
  // Watchdog: if the realtime room's heartbeat key goes stale mid-round, cancel and refund.
  await deps.queueWatchdog(partyId, startJobIds.watchdog(partyId));
  return decided.outcome;
}

/** A start job normally fires on time; the sweep leaves a party this long so it only picks up what was missed. */
export const SWEEP_GRACE_MS = 30_000;
const SWEEP_BATCH = 100;

export interface SweptParty { id: string; title: string; lateMs: number; outcome: StartOutcome }

/**
 * Any open party more than the grace period past its startsAt (its start job lost to a Valkey flush or a
 * crash, a worker that was down, or a party written straight to the database) starts or cancels with
 * refunds now, through the same startOrCancel as the start job. That locks the row and re-checks the
 * status, so racing the real start job is harmless. Each party it acts on is logged with how late it was.
 */
export async function sweepOverdue(deps: StartDeps, now = new Date()): Promise<SweptParty[]> {
  const overdue = await db.select({ id: parties.id, title: parties.title, startsAt: parties.startsAt }).from(parties)
    .where(and(eq(parties.status, "open"), lte(parties.startsAt, new Date(now.getTime() - SWEEP_GRACE_MS))))
    .orderBy(asc(parties.startsAt)).limit(SWEEP_BATCH);
  const swept: SweptParty[] = [];
  const failures: unknown[] = [];
  for (const p of overdue) {
    const lateMs = now.getTime() - p.startsAt.getTime();
    // One party that can't start mustn't hold up the rest: it'd be first in line again every minute.
    try {
      const outcome = await startOrCancel(deps, p.id);
      console.log(`[party] sweep: ${p.title} (${p.id}) was ${Math.round(lateMs / 1000)}s past its start → ${outcome}`);
      swept.push({ id: p.id, title: p.title, lateMs, outcome });
    } catch (err) {
      console.error(`[party] sweep: ${p.title} (${p.id}) was ${Math.round(lateMs / 1000)}s past its start and failed to start or cancel`, err);
      failures.push(err);
    }
  }
  // The job still fails (and shows in BullMQ) when any party did; the next sweep tries those again.
  if (failures.length) throw new AggregateError(failures, `sweep: ${failures.length} overdue party(s) failed`);
  return swept;
}

/** What the room and chat are told when a stalled live party is ended. */
export const STALLED_MESSAGE = "Something went wrong and this party couldn't continue. Every entry has been refunded.";

export interface StalledParty { id: string; title: string; stalledMs: number; outcome: "rekicked" | "cancelled" | "settled" }

/** What the stall check needs: the room events and lines, and the one settle path (partySettle.ts). */
export type StallDeps = Pick<StartDeps, "emit" | "publishLine"> & { settle(partyId: string): Promise<boolean> };

/**
 * Every minute: a live party whose room isn't moving. A healthy room opens a question at least every
 * stallThresholdSeconds (one whole question cycle plus a grace; while its set is still being sealed, the
 * generation timeout plus the grace). Past that with no progress:
 *
 * - Every question of the play order played (replacements included) and its scores recorded: the room
 *   died, or its settle is late, after the last question. It's settled from the recorded scores through
 *   the one settle path (ranks rebuilt by standingsFromRecords if the room never wrote them); a late
 *   settle from the room is then a no-op. Never refunded.
 * - Questions still unplayed: the start is republished once (a lost event, a room that missed it); still
 *   nothing a threshold later, and it's cancelled by the system with every seat refunded the way it was
 *   paid (refundAndCancel), never settled, room and chat told.
 *
 * Each intervention is logged with the path it took and how long the party had been stalled.
 */
export async function sweepStalled(deps: StallDeps, now = new Date()): Promise<StalledParty[]> {
  const [cfg, qcfg] = await Promise.all([getPartyConfig(), getQuestionsConfig()]);
  const live = await db.select().from(parties).where(eq(parties.status, "live")).orderBy(asc(parties.liveAt)).limit(SWEEP_BATCH);
  const out: StalledParty[] = [];
  const failures: unknown[] = [];
  for (const p of live) {
    const thresholdMs = 1000 * (p.questionsStatus === "ready" ? stallThresholdSeconds(p.questionSeconds, cfg) : qcfg.generationTimeoutSeconds + cfg.stallGraceSeconds);
    const since = progressSince(p);
    const stalledMs = now.getTime() - since.getTime();
    if (stalledMs < thresholdMs) continue;
    const rekickedSinceProgress = p.stallRekickedAt !== null && p.stallRekickedAt > since;
    try {
      const complete = p.questionsStatus === "ready" && (await allQuestionsPlayed(p.id));
      if (!complete && rekickedSinceProgress && now.getTime() - p.stallRekickedAt!.getTime() < thresholdMs) continue; // give the re-kick its chance
      const outcome = complete ? await settleFromRecords(deps, p.id) : rekickedSinceProgress ? await endStalled(deps, p.id) : await rekick(deps, p.id, now);
      if (!outcome) continue; // it moved, or ended, in the meantime
      console.log(`[party] stall: ${p.title} (${p.id}) live with no round progress for ${Math.round(stalledMs / 1000)}s (threshold ${thresholdMs / 1000}s) → ${outcome}`);
      out.push({ id: p.id, title: p.title, stalledMs, outcome });
    } catch (err) {
      console.error(`[party] stall: ${p.title} (${p.id}) stalled for ${Math.round(stalledMs / 1000)}s and the intervention failed`, err);
      failures.push(err);
    }
  }
  if (failures.length) throw new AggregateError(failures, `stall sweep: ${failures.length} live party(s) failed`);
  return out;
}

/** Every question of the play order (reserves promoted as replacements included) has been played or voided, and at least one played. */
export async function allQuestionsPlayed(partyId: string): Promise<boolean> {
  const order = await db.select({ status: partyQuestions.status }).from(partyQuestions).where(and(eq(partyQuestions.partyId, partyId), eq(partyQuestions.reserve, false)));
  return order.some((q) => q.status === "played") && order.every((q) => q.status === "played" || q.status === "voided");
}

/**
 * The whole set was played: write the final ranks from the recorded answers if the room never did (the
 * same standings Match keeps), then the one settle path. "settled" whether this call or a concurrent room
 * settle got there (settle pays once either way); null if it ended some other way meanwhile.
 */
export async function settleFromRecords(deps: StallDeps, partyId: string): Promise<"settled" | null> {
  const ready = await db.transaction(async (tx) => {
    const p = await stillStalled(tx, partyId);
    if (!p) return false;
    const seats = await tx.select({ userId: partyPlayers.userId, rank: partyPlayers.rank }).from(partyPlayers).where(eq(partyPlayers.partyId, partyId));
    if (seats.length && seats.every((s) => s.rank !== null)) return true; // the room wrote them before it stopped
    const questions = await tx.select({ id: partyQuestions.id, seconds: partyQuestions.seconds, status: partyQuestions.status }).from(partyQuestions)
      .where(and(eq(partyQuestions.partyId, partyId), eq(partyQuestions.reserve, false))).orderBy(asc(partyQuestions.idx));
    const answers = await tx.select({ questionId: partyAnswers.questionId, userId: partyAnswers.userId, points: partyAnswers.points, answeredMs: partyAnswers.answeredMs })
      .from(partyAnswers).where(eq(partyAnswers.partyId, partyId));
    const rows = standingsFromRecords(seats.map((s) => s.userId), questions.map((q) => ({ id: q.id, seconds: q.seconds, voided: q.status === "voided" })), answers);
    for (const r of rows) await tx.update(partyPlayers).set({ score: r.score, rank: r.rank }).where(and(eq(partyPlayers.partyId, partyId), eq(partyPlayers.userId, r.userId)));
    return true;
  });
  if (!ready) return null;
  await deps.settle(partyId);
  const [after] = await db.select({ status: parties.status }).from(parties).where(eq(parties.id, partyId));
  return after?.status === "finished" ? "settled" : null;
}

/** The last sign of life: a question opening, else going live. */
const progressSince = (p: Pick<Party, "roundProgressAt" | "liveAt" | "startsAt">) => p.roundProgressAt ?? p.liveAt ?? p.startsAt;

/** Locked re-check: still live and still no progress since `seen`? */
async function stillStalled(tx: Tx, partyId: string) {
  const [p] = await tx.select().from(parties).where(eq(parties.id, partyId)).for("update");
  return p && p.status === "live" ? p : null;
}

/** Republish the start once: a room that missed it (or the set's readiness) picks the round up. */
async function rekick(deps: Pick<StallDeps, "emit">, partyId: string, now: Date): Promise<"rekicked" | null> {
  const marked = await db.transaction(async (tx) => {
    const p = await stillStalled(tx, partyId);
    if (!p) return false;
    await tx.update(parties).set({ stallRekickedAt: now }).where(eq(parties.id, partyId));
    return true;
  });
  if (!marked) return null;
  await deps.emit({ partyId, status: "live" });
  return "rekicked";
}

/** Still stalled after the re-kick: cancel by the system with every seat refunded. A finished party is never touched. */
async function endStalled(deps: Pick<StallDeps, "emit" | "publishLine">, partyId: string): Promise<"cancelled" | null> {
  const line = await db.transaction(async (tx) => {
    const p = await stillStalled(tx, partyId);
    if (!p || (p.roundProgressAt && p.stallRekickedAt && p.roundProgressAt > p.stallRekickedAt)) return null; // it came back
    return (await refundAndCancel(tx, p, STALLED_MESSAGE, { by: "system" })).line;
  });
  if (!line) return null;
  await announceCancelled(deps, partyId, line);
  return "cancelled";
}

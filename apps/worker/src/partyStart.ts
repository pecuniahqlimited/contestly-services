/**
 * Starting a party at startsAt, or cancelling it with refunds, and the sweep that catches any party whose
 * start job never ran. Kept out of the worker's entry file so it can run against a real database in tests;
 * what it tells the outside world (room events, chat lines, follow-up jobs) is passed in.
 */
import { and, asc, count, eq, lte } from "drizzle-orm";
import { db, getPartyConfig, parties, partyPlayers, partyQuestions, refundAndCancel, seenInSet, systemLine, type Party, type Tx } from "@contestly/db";
import type { ChatMessage } from "@contestly/shared";

export interface StartDeps {
  /** Tell the party's room (the `party:events` channel). */
  emit(ev: { partyId: string; status: string }): Promise<unknown>;
  /** Deliver a committed system line to the party's room and inboxes. */
  publishLine(line: ChatMessage): Promise<unknown>;
  /** Queue the questions service: swap seen questions, or build a set that was never started. */
  queueQuestions(kind: "reseal_for_roster" | "generate_set", partyId: string): Promise<unknown>;
  /** Queue the first watchdog check of a live party. */
  queueWatchdog(partyId: string): Promise<unknown>;
}

export const GENERATION_FAILED_MESSAGE = "We couldn't build the questions for this party. Everyone has been refunded.";

/** Refund and cancel (packages/db, the one cancel path), then tell the room. */
export async function refundParty(deps: Pick<StartDeps, "emit">, tx: Tx, p: Party, message: string) {
  const { players: refunded } = await refundAndCancel(tx, p, message);
  await deps.emit({ partyId: p.id, status: "cancelled" });
  return refunded;
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

/** live: it started. cancelled: refunded and cancelled. skipped: it wasn't open (already started, over, or gone). */
export type StartOutcome = "live" | "cancelled" | "skipped";

/** Start a party at startsAt, or cancel + refund if too few people joined or it has nothing to play. */
export async function startOrCancel(deps: StartDeps, partyId: string): Promise<StartOutcome> {
  const cfg = await getPartyConfig();
  let line: ChatMessage | undefined;
  const started = await db.transaction(async (tx): Promise<StartFollowUp | StartOutcome> => {
    const [p] = await tx.select().from(parties).where(eq(parties.id, partyId)).for("update");
    if (!p || p.status !== "open") return "skipped";
    const [{ n }] = await tx.select({ n: count() }).from(partyPlayers).where(eq(partyPlayers.partyId, partyId));
    if (Number(n) < cfg.minPlayers) {
      const refunded = await refundParty(deps, tx, p, "Not enough players joined. Everyone has been refunded.");
      console.log(`[party] ${p.title} cancelled, ${refunded} refunded`);
      return "cancelled";
    }
    if (p.mode === "curate" && !(await curateSetApproved(tx, p))) {
      const refunded = await refundParty(deps, tx, p, "The host didn't finish reviewing the questions. Everyone has been refunded.");
      console.log(`[party] ${p.title}: curate set not approved at start, cancelled and ${refunded} refunded`);
      return "cancelled";
    }
    if (p.mode === "sealed" && p.questionsStatus === "failed") {
      const refunded = await refundParty(deps, tx, p, GENERATION_FAILED_MESSAGE);
      console.log(`[party] ${p.title}: question set still failed at start, cancelled and ${refunded} refunded`);
      return "cancelled";
    }
    const followUp = await sealedFollowUp(p);
    await tx.update(parties).set({
      status: "live",
      liveAt: new Date(),
      ...(followUp === "none" ? {} : { questionsStatus: "generating" as const }),
    }).where(eq(parties.id, partyId));
    line = await systemLine(tx, partyId, "The party is starting. Good luck!");
    console.log(`[party] ${p.title} is live with ${n} players${followUp === "reseal" ? "; swapping questions a player has already seen" : ""}`);
    return followUp;
  });
  if (started === "skipped" || started === "cancelled") return started;
  if (line) await deps.publishLine(line);
  // After commit, so the room never reads the set's state from before this transaction.
  await deps.emit({ partyId, status: "live" });
  if (started === "reseal") await deps.queueQuestions("reseal_for_roster", partyId);
  if (started === "generate") await deps.queueQuestions("generate_set", partyId);
  // Watchdog: if the realtime room's heartbeat key goes stale mid-round, cancel and refund.
  await deps.queueWatchdog(partyId);
  return "live";
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

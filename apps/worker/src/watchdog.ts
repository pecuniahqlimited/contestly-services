/**
 * The heartbeat watchdog: one link every WATCHDOG_EVERY_MS for each live party, looking for its room's heartbeat
 * key (`partyRoomKey`, written by PartyRoom every 10 s with a 30 s TTL). A key can lapse without the room being
 * gone (a busy event loop, a GC pause, a briefly suspended machine), so a missing key alone never refunds:
 *
 * 1. Two looks in a row without a heartbeat, then the stall sweep's recovery: the start republished once
 *    (`rekick`, which marks `stall_rekicked_at`), logged.
 * 2. Still no heartbeat at the next look, and no question opened since the re-kick: the room is really gone,
 *    and the party is cancelled and refunded (`refundInterrupted`).
 *
 * A heartbeat at any look starts the count again, and so does a question opening since the re-kick: a party whose
 * rounds are still progressing is never refunded. A missing key after the last question settles from the recorded
 * scores, and a live party whose set never arrived is still refunded at the generation timeout, as before.
 * Kept out of the worker's entry file so it runs against a real database in tests.
 */
import { eq } from "drizzle-orm";
import { db, getQuestionsConfig, parties } from "@contestly/db";
import { allQuestionsPlayed, refundInterrupted, rekick, settleFromRecords, type StallDeps } from "./partyStart.js";

/** Looks in a row without a heartbeat before the re-kick. */
export const WATCHDOG_MISSES_BEFORE_REKICK = 2;

/** What the watchdog remembers between links about one party: its run of missed looks, when it re-kicked, and the link that wrote it. */
export interface WatchState { misses: number; rekickedAt: string | null; link: string | null }

/** Where that lives between links (Valkey in the worker; forgetting it only restarts the count, never refunds). */
export interface WatchdogMemory {
  get(partyId: string): Promise<WatchState | null>;
  set(partyId: string, state: WatchState): Promise<unknown>;
  clear(partyId: string): Promise<unknown>;
}

export type WatchdogDeps = StallDeps & {
  /** Is the room's heartbeat key there? */
  roomAlive(partyId: string): Promise<boolean>;
  /** Queue the next link. */
  next(partyId: string): Promise<unknown>;
  memory: WatchdogMemory;
};

/**
 * What one link did. retired: the party isn't live (a refund of the watchdog's own that failed after its commit is
 * announced again). alive: the heartbeat is there. missed: a missed look short of the re-kick. rekicked: the
 * recovery. progressing: no heartbeat, but a question opened since the re-kick. settled / refunded: the end.
 */
export type WatchdogOutcome = "retired" | "alive" | "missed" | "rekicked" | "progressing" | "settled" | "refunded";

/**
 * One look. `link` is the job's id: a retried link (its next link failed to queue) repeats its own step rather than
 * counting as the next look, so a retry never turns a re-kick straight into a refund.
 */
export async function watchdogLink(deps: WatchdogDeps, partyId: string, link: string | null, now = new Date()): Promise<WatchdogOutcome> {
  const [p] = await db.select().from(parties).where(eq(parties.id, partyId));
  if (!p || p.status !== "live") {
    await deps.memory.clear(partyId);
    if (p?.status === "cancelled") await refundInterrupted(deps, partyId, false);
    return "retired";
  }
  const qcfg = await getQuestionsConfig();
  const generationStalled = p.liveAt !== null && now.getTime() - p.liveAt.getTime() > qcfg.generationTimeoutSeconds * 1000 && p.questionsStatus !== "ready";
  if (generationStalled) {
    await deps.memory.clear(partyId);
    await refundInterrupted(deps, partyId, true);
    return "refunded";
  }
  const carryOn = async (outcome: WatchdogOutcome, state: WatchState | null) => {
    await (state ? deps.memory.set(partyId, state) : deps.memory.clear(partyId));
    await deps.next(partyId);
    return outcome;
  };
  if (await deps.roomAlive(partyId)) return carryOn("alive", null);
  // The room is gone (or its heartbeat stopped when the match finished) after every question was played:
  // settle by the recorded scores, never refund a finished party.
  if (await allQuestionsPlayed(partyId)) {
    await deps.memory.clear(partyId);
    const out = await settleFromRecords(deps, partyId);
    console.log(`[party] watchdog: ${p.title} (${p.id}) room gone after the last question → ${out ?? "already ended"} from the recorded scores`);
    return "settled";
  }
  const was = (await deps.memory.get(partyId)) ?? { misses: 0, rekickedAt: null, link: null };
  if (link && was.link === link) {
    await deps.next(partyId);
    return was.rekickedAt ? "rekicked" : "missed";
  }
  const misses = was.misses + 1;
  if (!was.rekickedAt) {
    if (misses < WATCHDOG_MISSES_BEFORE_REKICK) {
      console.log(`[party] watchdog: ${p.title} (${p.id}) no heartbeat (${misses} of ${WATCHDOG_MISSES_BEFORE_REKICK} looks in a row); looking again`);
      return carryOn("missed", { misses, rekickedAt: null, link });
    }
    const kicked = await rekick(deps, partyId, now);
    console.log(`[party] watchdog: ${p.title} (${p.id}) no heartbeat for ${misses} looks in a row → ${kicked ?? "no longer live"}`);
    return carryOn("rekicked", { misses, rekickedAt: now.toISOString(), link });
  }
  if (p.roundProgressAt && p.roundProgressAt > new Date(was.rekickedAt)) {
    console.log(`[party] watchdog: ${p.title} (${p.id}) no heartbeat, but a question opened since the re-kick; still progressing, counting again`);
    return carryOn("progressing", null);
  }
  await deps.memory.clear(partyId);
  const refunded = await refundInterrupted(deps, partyId, false);
  console.log(`[party] watchdog: ${p.title} (${p.id}) no heartbeat and no progress since the re-kick at ${was.rekickedAt} → ${refunded ? "cancelled and refunded" : "already ended"}`);
  return "refunded";
}

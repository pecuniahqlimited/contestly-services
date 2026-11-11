/**
 * The nudge engine's clock (row 9): deliver_nudges every few seconds, nudge_minute and nudge_hourly. It has a queue
 * of its own, so a burst of event jobs on the notify queue never waits ahead of a tick, and a few slots, so one slow
 * tick doesn't hold the next: BullMQ queues a scheduler's next run as soon as the current one is picked up. Each
 * run has a deadline; one still going after it fails, freeing its slot. Overlapping ticks are safe: a tick claims
 * its rows with FOR UPDATE SKIP LOCKED, and the minute and hourly emitters record under dedupe keys.
 */
import { Worker, type ConnectionOptions } from "bullmq";
import { QUEUES, type NudgeClockJob } from "@contestly/shared";
import { withinDeadline } from "./deadline.js";

export type ClockKind = NudgeClockJob["kind"];

/** Slots for clock runs: a stuck one can hold at most one of these until its deadline. */
export const NUDGE_CLOCK_CONCURRENCY = 3;
/** How long a run may take before it's given up (well over a healthy run, well under a stall alert). */
export const NUDGE_CLOCK_DEADLINE_MS: Record<ClockKind, number> = { deliver_nudges: 30_000, nudge_minute: 120_000, nudge_hourly: 600_000 };

export interface NudgeClockOptions {
  connection: ConnectionOptions;
  prefix: string;
  /** What each kind does. */
  run: Record<ClockKind, () => Promise<unknown>>;
  /** Tests: a queue of their own and short deadlines. */
  queueName?: string;
  deadlinesMs?: Record<ClockKind, number>;
}

export function nudgeClockWorker(opts: NudgeClockOptions): Worker<NudgeClockJob> {
  const deadlines = opts.deadlinesMs ?? NUDGE_CLOCK_DEADLINE_MS;
  return new Worker<NudgeClockJob>(opts.queueName ?? QUEUES.nudgeClock,
    (job) => withinDeadline(deadlines[job.data.kind], `nudge clock ${job.data.kind}`, opts.run[job.data.kind]),
    { connection: opts.connection, prefix: opts.prefix, concurrency: NUDGE_CLOCK_CONCURRENCY });
}

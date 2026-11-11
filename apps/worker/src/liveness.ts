/**
 * Liveness of the repeatable jobs: every scheduler registered through schedule() (the nudge clock, the party and
 * payments sweeps, the invariants, the Climb's day start, alert delivery…) and each live party's watchdog chain.
 * A worker writes `liveness:<key>` when one completes; a plain timer here (not a queue job, so a stuck queue
 * can't silence it) raises a critical `jobs.stalled` admin alert for any that hasn't completed in
 * ALERT_JOB_MISSED_INTERVALS times its interval, never less than a minute.
 *
 * A gap between two checks far longer than the check's own interval means this process was suspended (a machine
 * asleep, a paused container): nothing could run, so baselines start again from the wake instead of alerting on
 * everything at once. A job that was already stuck alerts a threshold after the wake.
 */
import type { Queue, RepeatOptions, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { adminAlert } from "@contestly/db";

export interface WatchedJob {
  /** Its liveness key: `<queue>:<scheduler>`, or `watchdog:<partyId>`. */
  key: string;
  label: string;
  /** How often it should complete. */
  everyMs: number;
  /** Not expected before this (a live party's first watchdog look). Epoch ms. */
  notBefore?: number;
}

export const livenessKey = (key: string) => `liveness:${key}`;
/** A threshold never shorter than this, so one slow run of a 5-second tick isn't a page. */
export const MIN_STALL_MS = 60_000;
/** How often the check runs. */
export const LIVENESS_CHECK_EVERY_MS = 30_000;
/** A gap this many check intervals long means the process was suspended. */
const PAUSED_AFTER_CHECKS = 3;
export const DEFAULT_MISSED_INTERVALS = 3;

/** ALERT_JOB_MISSED_INTERVALS: how many intervals a repeatable job may miss before the critical alert (default 3). */
export function missedIntervalsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ALERT_JOB_MISSED_INTERVALS;
  if (raw === undefined || raw === "") return DEFAULT_MISSED_INTERVALS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`ALERT_JOB_MISSED_INTERVALS must be a whole number ≥ 1 (got "${raw}")`);
  return n;
}

// ---- registering and recording --------------------------------------------------------

const scheduled: WatchedJob[] = [];

/**
 * Upsert a repeatable job and watch it. `everyMs` is how often it runs: the `every` itself, or for a cron pattern
 * its period (a day, an hour).
 */
export async function schedule<T>(queue: Queue<T>, name: string, repeat: RepeatOptions, data: NoInfer<T>, everyMs: number, opts?: { attempts?: number }): Promise<void> {
  // BullMQ's Queue<T> types the template loosely across its generics; the data is the job's own.
  await (queue as Queue).upsertJobScheduler(name, repeat, { name, data, ...(opts ? { opts } : {}) });
  const key = `${queue.name}:${name}`;
  if (!scheduled.some((j) => j.key === key)) scheduled.push({ key, label: `${queue.name} ${name}`, everyMs });
}
export const scheduledJobs = (): WatchedJob[] => [...scheduled];

/** Record a completion (the worker's "completed" event for a scheduler's job; each watchdog link). */
export const recordCompletion = (redis: Redis, key: string, now = Date.now(), ttlMs?: number) =>
  ttlMs ? redis.set(livenessKey(key), String(now), "PX", ttlMs) : redis.set(livenessKey(key), String(now));

/** Each scheduler run this worker completes is recorded under `<queue>:<scheduler>` (one-off jobs aren't watched). */
export function watchCompletions(worker: Worker, redis: Redis): void {
  worker.on("completed", (job) => {
    if (job.repeatJobKey) recordCompletion(redis, `${worker.name}:${job.name}`).catch((err) => console.error(`[liveness] couldn't record ${worker.name} ${job.name}`, err));
  });
}

export async function lastCompletions(redis: Redis, keys: string[]): Promise<(number | null)[]> {
  if (!keys.length) return [];
  return (await redis.mget(keys.map(livenessKey))).map((v) => (v === null ? null : Number(v)));
}

// ---- the check ---------------------------------------------------------------------------

export interface Stall { job: WatchedJob; lastCompletedAt: number | null; thresholdMs: number; overdueMs: number }

export interface LivenessDeps {
  /** What should be completing right now. */
  jobs(): Promise<WatchedJob[]>;
  lastCompleted(keys: string[]): Promise<(number | null)[]>;
  stalled(s: Stall): Promise<unknown>;
  now?: () => number;
}

/** A check to run every LIVENESS_CHECK_EVERY_MS. Returns the stalls it raised. */
export function livenessCheck(deps: LivenessDeps, opts: { missedIntervals: number; checkEveryMs?: number; startedAt?: number }) {
  const now = deps.now ?? Date.now;
  const checkEveryMs = opts.checkEveryMs ?? LIVENESS_CHECK_EVERY_MS;
  let since = opts.startedAt ?? now();
  let lastCheck = since;
  return async function check(): Promise<Stall[]> {
    const t = now();
    if (t - lastCheck > PAUSED_AFTER_CHECKS * checkEveryMs) {
      console.warn(`[liveness] ${Math.round((t - lastCheck) / 1000)}s since the last check: this process was suspended; counting again from now`);
      since = t;
    }
    lastCheck = t;
    const jobs = await deps.jobs();
    const last = await deps.lastCompleted(jobs.map((j) => j.key));
    const stalls: Stall[] = [];
    for (const [i, job] of jobs.entries()) {
      const thresholdMs = Math.max(MIN_STALL_MS, opts.missedIntervals * job.everyMs);
      const overdueMs = t - Math.max(last[i] ?? 0, since, job.notBefore ?? 0) - thresholdMs;
      if (overdueMs <= 0) continue;
      const stall = { job, lastCompletedAt: last[i], thresholdMs, overdueMs };
      await deps.stalled(stall);
      stalls.push(stall);
    }
    return stalls;
  };
}

/** The critical alert for a stall (recorded only; the worker's alert delivery sends it). One open alert per job. */
export function raiseStalled({ job, lastCompletedAt, thresholdMs }: Stall) {
  const minutes = Math.round(thresholdMs / 60_000);
  return adminAlert({
    kind: "jobs.stalled", severity: "critical",
    subject: `${job.label} hasn't completed in ${minutes >= 1 ? `${minutes} min` : `${Math.round(thresholdMs / 1000)} s`}`,
    details: { job: job.key, everySeconds: job.everyMs / 1000, thresholdSeconds: thresholdMs / 1000, lastCompletedAt: lastCompletedAt ? new Date(lastCompletedAt).toISOString() : null },
    dedupeKey: `jobs.stalled:${job.key}`, dedupeWindowSeconds: 3600,
  });
}

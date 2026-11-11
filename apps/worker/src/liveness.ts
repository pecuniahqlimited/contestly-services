/**
 * Liveness of the repeatable jobs: every scheduler registered through schedule() (the nudge clock, the party and
 * payments sweeps, the invariants, the Climb's day start, alert delivery…) and each live party's watchdog chain.
 * A worker writes `liveness:<key>` when one completes; a plain timer here (not a queue job, so a stuck queue
 * can't silence it) raises a critical `jobs.stalled` admin alert for any that hasn't completed in
 * ALERT_JOB_MISSED_INTERVALS times its interval, never less than a minute. A job on a cron pattern that runs once
 * a day or less often (the Climb's day start and week close, the reconciliation, the purges) is instead late when
 * it hasn't completed ALERT_JOB_GRACE_MINUTES after it was due: N days or weeks would be far too long to wait.
 *
 * A gap between two checks far longer than the check's own interval means this process was suspended (a machine
 * asleep, a paused container): nothing could run, so baselines start again from the wake instead of alerting on
 * everything at once. A job that was already stuck alerts a threshold after the wake.
 */
import type { Queue, RepeatOptions, Worker } from "bullmq";
import type { Redis } from "ioredis";
import cronParser from "cron-parser";
import { adminAlert } from "@contestly/db";

export interface WatchedJob {
  /** Its liveness key: `<queue>:<scheduler>`, or `watchdog:<partyId>`. */
  key: string;
  label: string;
  /** How often it should complete. */
  everyMs: number;
  /** Not expected before this (a live party's first watchdog look; for a due job, when it was first scheduled). Epoch ms. */
  notBefore?: number;
  /** Watched by when it was due rather than by its interval: daily and weekly jobs. */
  due?: { pattern: string; tz?: string };
}

export const livenessKey = (key: string) => `liveness:${key}`;
/** A threshold never shorter than this, so one slow run of a 5-second tick isn't a page. */
export const MIN_STALL_MS = 60_000;
/** How often the check runs. */
export const LIVENESS_CHECK_EVERY_MS = 30_000;
/** A gap this many check intervals long means the process was suspended. */
const PAUSED_AFTER_CHECKS = 3;
export const DEFAULT_MISSED_INTERVALS = 3;
/** A cron job that runs this rarely or rarer is watched by when it was due (DAY_MS: daily and weekly jobs). */
export const DUE_WATCHED_FROM_MS = 24 * 3600_000;
export const DEFAULT_GRACE_MINUTES = 60;

/** ALERT_JOB_MISSED_INTERVALS: how many intervals a repeatable job may miss before the critical alert (default 3). */
export function missedIntervalsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ALERT_JOB_MISSED_INTERVALS;
  if (raw === undefined || raw === "") return DEFAULT_MISSED_INTERVALS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`ALERT_JOB_MISSED_INTERVALS must be a whole number ≥ 1 (got "${raw}")`);
  return n;
}

/** ALERT_JOB_GRACE_MINUTES: how long after it was due a daily or weekly job may go without completing (default 60). */
export function graceMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ALERT_JOB_GRACE_MINUTES;
  if (raw === undefined || raw === "") return DEFAULT_GRACE_MINUTES * 60_000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`ALERT_JOB_GRACE_MINUTES must be a whole number ≥ 1 (got "${raw}")`);
  return n * 60_000;
}

/** When a cron job was last due at or before `t`. */
export function lastDueAt(due: NonNullable<WatchedJob["due"]>, t: number): number {
  return cronParser.parseExpression(due.pattern, { currentDate: new Date(t + 1), tz: due.tz }).prev().getTime();
}

// ---- registering and recording --------------------------------------------------------

const scheduled: WatchedJob[] = [];

const firstScheduledKey = (key: string) => `liveness:since:${key}`;

/**
 * Upsert a repeatable job and watch it. `everyMs` is how often it runs: the `every` itself, or for a cron pattern
 * its period (a day, an hour). A cron job of a day or longer is watched by when it was due, from the first time it
 * was ever scheduled (kept in Valkey), so a run due before the scheduler existed is never expected.
 */
export async function schedule<T>(queue: Queue<T>, name: string, repeat: RepeatOptions, data: NoInfer<T>, everyMs: number, opts?: { attempts?: number }): Promise<void> {
  // BullMQ's Queue<T> types the template loosely across its generics; the data is the job's own.
  await (queue as Queue).upsertJobScheduler(name, repeat, { name, data, ...(opts ? { opts } : {}) });
  const key = `${queue.name}:${name}`;
  const job: WatchedJob = { key, label: `${queue.name} ${name}`, everyMs };
  if (repeat.pattern && everyMs >= DUE_WATCHED_FROM_MS) {
    // The queue's own connection: ioredis under BullMQ's narrower client type.
    const redis = (await queue.client) as unknown as Redis;
    await redis.set(firstScheduledKey(key), String(Date.now()), "NX");
    job.due = { pattern: repeat.pattern, ...(repeat.tz ? { tz: repeat.tz } : {}) };
    job.notBefore = Number(await redis.get(firstScheduledKey(key)));
  }
  const at = scheduled.findIndex((j) => j.key === key);
  if (at >= 0) scheduled[at] = job;
  else scheduled.push(job);
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

/** A late job: `thresholdMs` is N intervals, or for a due job the grace after `dueAt`. */
export interface Stall { job: WatchedJob; lastCompletedAt: number | null; thresholdMs: number; overdueMs: number; dueAt?: number }

export interface LivenessDeps {
  /** What should be completing right now. */
  jobs(): Promise<WatchedJob[]>;
  lastCompleted(keys: string[]): Promise<(number | null)[]>;
  stalled(s: Stall): Promise<unknown>;
  now?: () => number;
}

/** A check to run every LIVENESS_CHECK_EVERY_MS. Returns the stalls it raised. */
export function livenessCheck(deps: LivenessDeps, opts: { missedIntervals: number; graceMs?: number; checkEveryMs?: number; startedAt?: number }) {
  const now = deps.now ?? Date.now;
  const checkEveryMs = opts.checkEveryMs ?? LIVENESS_CHECK_EVERY_MS;
  let since = opts.startedAt ?? now();
  let lastCheck = since;
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MINUTES * 60_000;
  /** How late the job is now (≤ 0: not late), and when it was due if it's watched that way. */
  const lateness = (job: WatchedJob, last: number | null, t: number): { overdueMs: number; thresholdMs: number; dueAt?: number } => {
    if (job.due) {
      const dueAt = lastDueAt(job.due, t);
      // Due before it was ever scheduled, or done since it was due: nothing owed.
      if (dueAt < (job.notBefore ?? 0) || (last ?? 0) >= dueAt) return { overdueMs: 0, thresholdMs: graceMs, dueAt };
      return { overdueMs: t - Math.max(dueAt, since) - graceMs, thresholdMs: graceMs, dueAt };
    }
    const thresholdMs = Math.max(MIN_STALL_MS, opts.missedIntervals * job.everyMs);
    return { overdueMs: t - Math.max(last ?? 0, since, job.notBefore ?? 0) - thresholdMs, thresholdMs };
  };
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
      const { overdueMs, thresholdMs, dueAt } = lateness(job, last[i], t);
      if (overdueMs <= 0) continue;
      const stall: Stall = { job, lastCompletedAt: last[i], thresholdMs, overdueMs, ...(dueAt !== undefined ? { dueAt } : {}) };
      await deps.stalled(stall);
      stalls.push(stall);
    }
    return stalls;
  };
}

/** The critical alert for a stall (recorded only; the worker's alert delivery sends it). One open alert per job. */
export function raiseStalled({ job, lastCompletedAt, thresholdMs, dueAt }: Stall) {
  const minutes = Math.round(thresholdMs / 60_000);
  const span = minutes >= 1 ? `${minutes} min` : `${Math.round(thresholdMs / 1000)} s`;
  const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);
  return adminAlert({
    kind: "jobs.stalled", severity: "critical",
    subject: dueAt !== undefined ? `${job.label} was due at ${dueTime(dueAt, job.due?.tz)} and hasn't completed ${span} later` : `${job.label} hasn't completed in ${span}`,
    details: {
      job: job.key, everySeconds: job.everyMs / 1000, thresholdSeconds: thresholdMs / 1000, lastCompletedAt: iso(lastCompletedAt),
      ...(dueAt !== undefined ? { dueAt: iso(dueAt), pattern: job.due?.pattern, timeZone: job.due?.tz ?? "UTC" } : {}),
    },
    dedupeKey: `jobs.stalled:${job.key}`, dedupeWindowSeconds: 3600,
  });
}

/** "Mon 17 Nov, 00:15 Africa/Lagos": when a due job was due, in its own time zone. */
function dueTime(ms: number, tz = "UTC"): string {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${f.format(new Date(ms)).replace(" at", ",")} ${tz}`;
}

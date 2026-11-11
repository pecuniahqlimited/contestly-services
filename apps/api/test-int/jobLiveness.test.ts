/**
 * Repeatable jobs against real Valkey and Postgres: the nudge clock keeps ticking past a tick that never returns
 * (apps/worker/src/nudgeClock.ts), and a repeatable job that stops completing raises one critical admin alert
 * (apps/worker/src/liveness.ts), recorded from the worker's own completions.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Queue, type Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { adminAlerts, db, sql } from "@contestly/db";
import { QUEUE_PREFIX, makeRedis } from "@contestly/queue";
import type { NudgeClockJob } from "@contestly/shared";
import { nudgeClockWorker, type ClockKind } from "../../worker/src/nudgeClock.js";
import { lastCompletions, livenessCheck, raiseStalled, schedule, scheduledJobs, watchCompletions } from "../../worker/src/liveness.js";

const redis = makeRedis();
const opened: { close(): Promise<unknown> }[] = [];
const waitUntil = async (ok: () => boolean, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (ok()) return true;
  return ok();
};

afterAll(async () => {
  for (const o of opened.reverse()) await o.close();
  await redis.quit();
  await sql.end();
});

describe("the nudge clock", () => {
  it("a tick that never returns is given up at its deadline, and the ticks after it still run", async () => {
    const queueName = `nudge_clock_test_${randomUUID().slice(0, 8)}`;
    const queue = new Queue<NudgeClockJob>(queueName, { connection: makeRedis(), prefix: QUEUE_PREFIX });
    let calls = 0;
    let delivered = 0;
    const failures: string[] = [];
    const never = () => new Promise<void>(() => {});
    const worker = nudgeClockWorker({
      connection: makeRedis(), prefix: QUEUE_PREFIX, queueName,
      // The first tick hangs forever (a push provider that never answers); every later one delivers.
      run: { deliver_nudges: async () => (++calls === 1 ? never() : void delivered++), nudge_minute: async () => {}, nudge_hourly: async () => {} },
      deadlinesMs: { deliver_nudges: 400, nudge_minute: 400, nudge_hourly: 400 } satisfies Record<ClockKind, number>,
    });
    worker.on("failed", (_job, err) => failures.push(err.name));
    opened.push(queue, worker);
    await queue.upsertJobScheduler("deliver_nudges", { every: 100 }, { name: "deliver_nudges", data: { kind: "deliver_nudges" } });
    // Ticks go on while the first is stuck (another slot), and its deadline frees its slot.
    expect(await waitUntil(() => delivered >= 5 && failures.length >= 1)).toBe(true);
    expect(failures[0]).toBe("DeadlineExceeded");
  });
});

describe("liveness of repeatable jobs", () => {
  it("a scheduler's completions are recorded; once they stop for N intervals, one critical alert (a repeat only counts)", async () => {
    const queueName = `liveness_test_${randomUUID().slice(0, 8)}`;
    const queue = new Queue<{ kind: string }>(queueName, { connection: makeRedis(), prefix: QUEUE_PREFIX });
    opened.push(queue);
    const { Worker: BullWorker } = await import("bullmq");
    const worker: Worker = new BullWorker(queueName, async () => "ok", { connection: makeRedis(), prefix: QUEUE_PREFIX });
    watchCompletions(worker, redis);
    opened.push(worker);
    const EVERY = 200;
    await schedule(queue, "tick", { every: EVERY }, { kind: "tick" }, EVERY);
    const job = scheduledJobs().find((j) => j.key === `${queueName}:tick`)!;
    expect(job).toMatchObject({ label: `${queueName} tick`, everyMs: EVERY });
    expect(await waitUntil(() => false, 700)).toBe(false); // let a few runs complete
    const [last] = await lastCompletions(redis, [job.key]);
    expect(last).toBeGreaterThan(Date.now() - 2000);

    // The check on a clock of its own: fresh now; then the worker stops, and three minutes on it's stalled.
    let now = Date.now();
    const check = livenessCheck({ jobs: async () => [job], lastCompleted: (keys) => lastCompletions(redis, keys), stalled: raiseStalled, now: () => now }, { missedIntervals: 3, checkEveryMs: 30_000, startedAt: now - 60_000 });
    expect(await check()).toEqual([]);
    await worker.close();
    await queue.removeJobScheduler("tick");
    for (let i = 0; i < 6; i++) {
      now += 30_000;
      await check();
    }
    const alerts = await db.select().from(adminAlerts).where(eq(adminAlerts.dedupeKey, `jobs.stalled:${job.key}`));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "jobs.stalled", severity: "critical", subject: `${queueName} tick hasn't completed in 1 min` });
    expect(alerts[0].details).toMatchObject({ job: job.key, thresholdSeconds: 60 });
    expect(alerts[0].count).toBeGreaterThan(1);
  });
});

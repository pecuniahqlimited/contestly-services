/** The repeatable jobs' liveness check (liveness.ts) on a fake clock, and the deadline a clock run gets (deadline.ts). */
import { describe, expect, it } from "vitest";
import { DEFAULT_MISSED_INTERVALS, MIN_STALL_MS, livenessCheck, missedIntervalsFromEnv, type Stall, type WatchedJob } from "../src/liveness.js";
import { DeadlineExceeded, withinDeadline } from "../src/deadline.js";

const T0 = Date.UTC(2026, 10, 11, 9);
const tick: WatchedJob = { key: "nudge_clock:deliver_nudges", label: "nudge_clock deliver_nudges", everyMs: 5_000 };
const sweep: WatchedJob = { key: "party:sweep", label: "party sweep", everyMs: 60_000 };

/** A check on a clock the test moves, with completions the test writes. */
function harness(jobs: WatchedJob[], missedIntervals = 3) {
  let now = T0;
  const done = new Map<string, number>();
  const raised: Stall[] = [];
  const check = livenessCheck({
    jobs: async () => jobs, lastCompleted: async (keys) => keys.map((k) => done.get(k) ?? null), stalled: async (s) => raised.push(s), now: () => now,
  }, { missedIntervals, checkEveryMs: 30_000, startedAt: T0 });
  return {
    raised, done,
    /** Move the clock in 30-second checks, as the timer would, running each. */
    async run(seconds: number) {
      const out: Stall[][] = [];
      for (let s = 0; s < seconds; s += 30) {
        now += 30_000;
        out.push(await check());
      }
      return out.flat();
    },
    /** One check after a jump, as after a machine wakes. */
    async jump(seconds: number) { now += seconds * 1000; return check(); },
    complete(job: WatchedJob) { done.set(job.key, now); },
  };
}

describe("the liveness check", () => {
  it("a job completing on time is never raised", async () => {
    const h = harness([sweep]);
    for (let i = 0; i < 10; i++) {
      await h.run(60);
      h.complete(sweep);
    }
    expect(h.raised).toEqual([]);
  });

  it("past N intervals without a completion: raised with how late it is (and again at each check while it stays stuck)", async () => {
    const h = harness([sweep]);
    h.complete(sweep);
    expect(await h.run(180)).toEqual([]); // exactly 3 intervals: not yet
    const [stall] = await h.run(30);
    expect(stall).toMatchObject({ job: sweep, lastCompletedAt: T0, thresholdMs: 180_000, overdueMs: 30_000 });
    expect((await h.run(30)).length).toBe(1); // the alert dedupes; the check keeps saying so
  });

  it("a fast tick's threshold is never under a minute: one slow run isn't a page", async () => {
    const h = harness([tick]);
    h.complete(tick);
    expect(await h.run(60)).toEqual([]);
    expect((await h.run(30))[0]).toMatchObject({ thresholdMs: MIN_STALL_MS });
  });

  it("never completed since the worker started: counted from the start", async () => {
    const h = harness([sweep]);
    expect(await h.run(180)).toEqual([]);
    expect(await h.run(30)).toHaveLength(1);
  });

  it("after the process was suspended (a sleeping machine), counting starts again from the wake", async () => {
    const h = harness([sweep]);
    h.complete(sweep);
    expect(await h.jump(419)).toEqual([]); // 7 minutes asleep: nothing ran, so nothing is late yet
    expect(await h.run(180)).toEqual([]);
    expect(await h.run(30)).toHaveLength(1); // still nothing a threshold after the wake: raised
  });

  it("a watchdog chain isn't expected before its first look", async () => {
    const chain: WatchedJob = { key: "watchdog:p1", label: "the watchdog for p1", everyMs: 30_000, notBefore: T0 + 600_000 };
    const h = harness([chain]);
    expect(await h.run(690)).toEqual([]); // first look at +10 min, then 3 × 30 s, floored at a minute: +11 min 30 s
    expect(await h.run(30)).toHaveLength(1);
  });

  it("N is ALERT_JOB_MISSED_INTERVALS, 3 by default; nonsense refuses to start", () => {
    expect(missedIntervalsFromEnv({})).toBe(DEFAULT_MISSED_INTERVALS);
    expect(missedIntervalsFromEnv({ ALERT_JOB_MISSED_INTERVALS: "5" })).toBe(5);
    expect(() => missedIntervalsFromEnv({ ALERT_JOB_MISSED_INTERVALS: "0" })).toThrow(/ALERT_JOB_MISSED_INTERVALS/);
    expect(() => missedIntervalsFromEnv({ ALERT_JOB_MISSED_INTERVALS: "soon" })).toThrow(/ALERT_JOB_MISSED_INTERVALS/);
  });
});

describe("a clock run's deadline", () => {
  it("a run inside it resolves; one past it rejects so the job ends", async () => {
    await expect(withinDeadline(1000, "fast", async () => 7)).resolves.toBe(7);
    await expect(withinDeadline(20, "stuck", () => new Promise(() => {}))).rejects.toBeInstanceOf(DeadlineExceeded);
    await expect(withinDeadline(1000, "broken", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  });
});

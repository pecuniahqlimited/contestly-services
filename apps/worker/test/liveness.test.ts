/** The repeatable jobs' liveness check (liveness.ts) on a fake clock, and the deadline a clock run gets (deadline.ts). */
import { describe, expect, it } from "vitest";
import { DEFAULT_MISSED_INTERVALS, MIN_STALL_MS, graceMsFromEnv, lastDueAt, livenessCheck, missedIntervalsFromEnv, type Stall, type WatchedJob } from "../src/liveness.js";
import { DeadlineExceeded, withinDeadline } from "../src/deadline.js";

const T0 = Date.UTC(2026, 10, 11, 9);
const tick: WatchedJob = { key: "nudge_clock:deliver_nudges", label: "nudge_clock deliver_nudges", everyMs: 5_000 };
const sweep: WatchedJob = { key: "party:sweep", label: "party sweep", everyMs: 60_000 };

/** A check on a clock the test moves, with completions the test writes. */
function harness(jobs: WatchedJob[], missedIntervals = 3, start = T0) {
  let now = start;
  const done = new Map<string, number>();
  const raised: Stall[] = [];
  const check = livenessCheck({
    jobs: async () => jobs, lastCompleted: async (keys) => keys.map((k) => done.get(k) ?? null), stalled: async (s) => raised.push(s), now: () => now,
  }, { missedIntervals, graceMs: 60 * 60_000, checkEveryMs: 30_000, startedAt: start });
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

describe("daily and weekly jobs: late a grace period after they were due", () => {
  const LAGOS = "Africa/Lagos";
  /** 23:00 UTC is midnight in Lagos: the day start's due time. 22:50 UTC on 11 Nov, ten minutes before it. */
  const BEFORE_MIDNIGHT = Date.UTC(2026, 10, 11, 22, 50);
  const MIDNIGHT = Date.UTC(2026, 10, 11, 23);
  const dayStart = (notBefore = BEFORE_MIDNIGHT - 86_400_000): WatchedJob =>
    ({ key: "climb:day_start", label: "climb day_start", everyMs: 86_400_000, due: { pattern: "0 0 * * *", tz: LAGOS }, notBefore });

  it("lastDueAt is the cron's last time at or before now, in its own time zone", () => {
    expect(lastDueAt({ pattern: "0 0 * * *", tz: LAGOS }, MIDNIGHT)).toBe(MIDNIGHT);
    expect(lastDueAt({ pattern: "0 0 * * *", tz: LAGOS }, MIDNIGHT - 1)).toBe(MIDNIGHT - 86_400_000);
    // The week close, Mondays 00:15 Lagos: Sunday 23:15 UTC.
    expect(new Date(lastDueAt({ pattern: "15 0 * * 1", tz: LAGOS }, MIDNIGHT)).toISOString()).toBe("2026-11-08T23:15:00.000Z");
  });

  it("done soon after it was due: never raised, all day", async () => {
    const job = dayStart();
    const h = harness([job], 3, BEFORE_MIDNIGHT);
    h.complete(job); // yesterday's run, done
    await h.run(10 * 60 + 30); // midnight passes
    h.complete(job);
    expect(await h.run(3 * 3600)).toEqual([]);
  });

  it("not done an hour after it was due: one alert naming the due time, not three days of intervals", async () => {
    const job = dayStart();
    const h = harness([job], 3, BEFORE_MIDNIGHT);
    h.complete(job);
    expect(await h.run(10 * 60 + 60 * 60)).toEqual([]); // midnight, then exactly the grace
    const [stall] = await h.run(30);
    expect(stall).toMatchObject({ job, dueAt: MIDNIGHT, thresholdMs: 3_600_000, overdueMs: 30_000 });
  });

  it("a run due before the job was first scheduled is never expected (a new install, a new job)", async () => {
    const job = dayStart(MIDNIGHT + 3600_000); // first scheduled at 01:00 Lagos
    const h = harness([job], 3, MIDNIGHT + 3600_000);
    expect(await h.run(6 * 3600)).toEqual([]);
  });

  it("asleep over its due time: the grace counts from the wake (the run happens on wake)", async () => {
    const job = dayStart();
    const h = harness([job], 3, BEFORE_MIDNIGHT);
    h.complete(job);
    expect(await h.jump(3 * 3600)).toEqual([]); // woke at 01:50 Lagos
    expect(await h.run(3600)).toEqual([]);
    expect(await h.run(30)).toHaveLength(1);
  });

  it("frequent and hourly jobs keep N intervals alongside them", async () => {
    const job = dayStart();
    const h = harness([job, sweep], 3, BEFORE_MIDNIGHT);
    h.complete(job);
    h.complete(sweep);
    const late = await h.run(210);
    expect(late.map((s) => s.job.key)).toEqual(["party:sweep"]);
  });

  it("the grace is ALERT_JOB_GRACE_MINUTES, 60 by default; nonsense refuses to start", () => {
    expect(graceMsFromEnv({})).toBe(3_600_000);
    expect(graceMsFromEnv({ ALERT_JOB_GRACE_MINUTES: "90" })).toBe(90 * 60_000);
    expect(() => graceMsFromEnv({ ALERT_JOB_GRACE_MINUTES: "-1" })).toThrow(/ALERT_JOB_GRACE_MINUTES/);
  });
});

describe("a clock run's deadline", () => {
  it("a run inside it resolves; one past it rejects so the job ends", async () => {
    await expect(withinDeadline(1000, "fast", async () => 7)).resolves.toBe(7);
    await expect(withinDeadline(20, "stuck", () => new Promise(() => {}))).rejects.toBeInstanceOf(DeadlineExceeded);
    await expect(withinDeadline(1000, "broken", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  });
});

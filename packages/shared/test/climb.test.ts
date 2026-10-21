import { describe, expect, it } from "vitest";
import { DEFAULT_CLIMB_LADDER, DEFAULT_CLIMB_SETTINGS, addDays, climbLadderSchema, climbPrizesSchema, climbSettingsSchema, NO_CLIMB_PRIZES, weeklyPrizeTotalKobo, dayStartsAt, lagosDay, upsertChallengeSchema, weekDays, weekEndsAt, weekOf } from "../src/index.js";

describe("the Lagos calendar", () => {
  it("a Lagos day starts at 23:00 UTC the evening before", () => {
    expect(lagosDay(new Date("2026-10-18T22:59:59Z"))).toBe("2026-10-18");
    expect(lagosDay(new Date("2026-10-18T23:00:00Z"))).toBe("2026-10-19");
    expect(dayStartsAt("2026-10-19").toISOString()).toBe("2026-10-18T23:00:00.000Z");
  });
  it("weeks run Monday to Sunday", () => {
    expect(weekOf("2026-10-19")).toBe("2026-10-19"); // Monday
    expect(weekOf("2026-10-25")).toBe("2026-10-19"); // Sunday
    expect(weekOf("2026-10-26")).toBe("2026-10-26");
    expect(weekDays("2026-10-19")).toEqual(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]);
  });
  it("Sunday 23:30 Lagos is still last week; the week ends at Monday 00:00 Lagos", () => {
    expect(weekOf(lagosDay(new Date("2026-10-25T22:30:00Z")))).toBe("2026-10-19");
    expect(weekEndsAt("2026-10-19").toISOString()).toBe("2026-10-25T23:00:00.000Z");
  });
  it("adding days crosses months and years", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(weekOf("2027-01-01")).toBe("2026-12-28");
  });
});

describe("ladder config", () => {
  it("the default is valid", () => expect(climbLadderSchema.safeParse(DEFAULT_CLIMB_LADDER).success).toBe(true));
  it("refuses a stage that needs more right than it has rounds", () => {
    const bad = { ...DEFAULT_CLIMB_LADDER, stages: [{ types: ["pattern"], rounds: 2, toClear: 3, seconds: 10, points: 10 }] };
    expect(climbLadderSchema.safeParse(bad).success).toBe(false);
  });
  it("refuses a stage left with no game type switched on", () => {
    const bad = { ...DEFAULT_CLIMB_LADDER, enabledTypes: ["pattern", "scramble", "word_hunt", "quick_maths"] }; // memory off; stage 5 still has quick maths
    expect(climbLadderSchema.safeParse(bad).success).toBe(true);
    const worse = { ...DEFAULT_CLIMB_LADDER, enabledTypes: ["scramble"] };
    const r = climbLadderSchema.safeParse(worse);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].message).toBe("stage 1 has no game type switched on");
  });
  it("the default settings are valid", () => expect(climbSettingsSchema.safeParse(DEFAULT_CLIMB_SETTINGS).success).toBe(true));
});

describe("weekly prizes", () => {
  it("need exactly one positive amount per winner", () => {
    expect(climbPrizesSchema.safeParse({ winners: 2, prizeKobo: [500_000, 300_000] }).success).toBe(true);
    expect(climbPrizesSchema.safeParse({ winners: 3, prizeKobo: [500_000, 300_000] }).success).toBe(false);
    expect(climbPrizesSchema.safeParse({ winners: 1, prizeKobo: [0] }).success).toBe(false);
    expect(climbPrizesSchema.safeParse({ winners: 1, prizeKobo: [1.5] }).success).toBe(false);
    expect(climbPrizesSchema.safeParse(NO_CLIMB_PRIZES).success).toBe(true);
  });
  it("the weekly total is the sum of the places", () => {
    expect(weeklyPrizeTotalKobo({ winners: 3, prizeKobo: [500_000, 300_000, 200_000] })).toBe(1_000_000);
    expect(weeklyPrizeTotalKobo(NO_CLIMB_PRIZES)).toBe(0);
  });
});

describe("Today's challenge questions", () => {
  it("the correct option must exist, and options must differ", () => {
    const ok = { title: "Naija music", questions: [{ prompt: "Who sang Ojuelegba?", options: ["Wizkid", "Davido"], correctIndex: 0 }] };
    expect(upsertChallengeSchema.safeParse(ok).success).toBe(true);
    expect(upsertChallengeSchema.safeParse({ ...ok, questions: [{ ...ok.questions[0], correctIndex: 2 }] }).success).toBe(false);
    expect(upsertChallengeSchema.safeParse({ ...ok, questions: [{ ...ok.questions[0], options: ["Wizkid", "wizkid"] }] }).success).toBe(false);
  });
});

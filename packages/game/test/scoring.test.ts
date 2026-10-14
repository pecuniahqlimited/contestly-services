import { describe, expect, it } from "vitest";
import { points, speedBonus } from "../src/scoring.js";
import { computeStandings, rankMap } from "../src/standings.js";

const cfg = { basePoints: 100, maxSpeedBonus: 100 };

describe("speed bonus", () => {
  it("falls linearly with time taken", () => {
    expect(speedBonus(0, 10_000, 100)).toBe(100);
    expect(speedBonus(5_000, 10_000, 100)).toBe(50);
    expect(speedBonus(10_000, 10_000, 100)).toBe(0);
    expect(speedBonus(12_000, 10_000, 100)).toBe(0); // never negative
  });
});

describe("points = correctness × (base + speed bonus)", () => {
  it("full marks, instant answer", () => expect(points(1, 0, 10_000, cfg)).toBe(200));
  it("full marks, last-moment answer", () => expect(points(1, 10_000, 10_000, cfg)).toBe(100));
  it("partial credit scales the whole sum", () => expect(points(0.5, 5_000, 10_000, cfg)).toBe(75));
  it("wrong answers earn nothing however fast", () => expect(points(0, 0, 10_000, cfg)).toBe(0));
});

describe("standings and tie-breaks", () => {
  it("ranks by score, then cumulative speed, then userId", () => {
    const rows = computeStandings([
      { userId: "c", score: 100, timeMs: 4000 },
      { userId: "a", score: 200, timeMs: 9000 },
      { userId: "b", score: 100, timeMs: 3000 },
      { userId: "d", score: 100, timeMs: 4000 },
    ]);
    expect(rows.map((r) => r.userId)).toEqual(["a", "b", "c", "d"]);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
  });
  it("prev_rank comes from the previous table, null the first time", () => {
    const first = computeStandings([
      { userId: "a", score: 10, timeMs: 1 },
      { userId: "b", score: 20, timeMs: 1 },
    ]);
    expect(first.every((r) => r.prevRank === null)).toBe(true);
    const second = computeStandings(
      [
        { userId: "a", score: 40, timeMs: 2 },
        { userId: "b", score: 30, timeMs: 2 },
      ],
      rankMap(first),
    );
    expect(second.find((r) => r.userId === "a")).toMatchObject({ rank: 1, prevRank: 2 });
    expect(second.find((r) => r.userId === "b")).toMatchObject({ rank: 2, prevRank: 1 });
  });
});

import { describe, expect, it } from "vitest";
import { evenShares, nextPlaced, reviewPrize, type GradedAnswer } from "../src/hostWritten.js";

const answers = (rows: [string, boolean, number][]): GradedAnswer[] => rows.map(([userId, hostWritten, correctnessPct]) => ({ userId, hostWritten, correctnessPct }));

describe("reviewPrize", () => {
  // Two host-written questions: the winner got both, the room one in four.
  const played = answers([
    ["w", true, 100], ["w", true, 100], ["w", false, 0],
    ["a", true, 0], ["a", true, 100], ["b", true, 0], ["b", true, 0],
  ]);

  it("flags a linked winner far above the room on the host's questions", () => {
    const r = reviewPrize({ winnerId: "w", links: ["people"], answers: played, marginPct: 30 });
    expect(r.flagged).toBe(true);
    expect(r.evidence).toMatchObject({ links: ["people"], hostQuestionsPlayed: 2, winnerAccuracyPct: 100, roomAccuracyPct: 25, marginPct: 75, thresholdPct: 30, winnerThemedAccuracyPct: 0 });
  });

  it("never flags a winner who isn't linked, however well they did", () => {
    expect(reviewPrize({ winnerId: "w", links: [], answers: played, marginPct: 30 }).flagged).toBe(false);
  });

  it("doesn't flag a linked winner within the margin", () => {
    expect(reviewPrize({ winnerId: "w", links: ["ip"], answers: played, marginPct: 80 }).flagged).toBe(false);
    // Exactly at the margin is flagged.
    expect(reviewPrize({ winnerId: "w", links: ["ip"], answers: played, marginPct: 75 }).flagged).toBe(true);
  });

  it("doesn't flag when no host-written question was played (all voided, say)", () => {
    const themedOnly = answers([["w", false, 100], ["a", false, 0]]);
    const r = reviewPrize({ winnerId: "w", links: ["install"], answers: themedOnly, marginPct: 1 });
    expect(r.flagged).toBe(false);
    expect(r.evidence.hostQuestionsPlayed).toBe(0);
  });

  it("counts a room with nobody else as 0", () => {
    const r = reviewPrize({ winnerId: "w", links: ["people"], answers: answers([["w", true, 50]]), marginPct: 30 });
    expect(r.evidence.roomAccuracyPct).toBe(0);
    expect(r.flagged).toBe(true);
  });
});

describe("nextPlaced", () => {
  const seats = [
    { userId: "first", rank: 1, eligible: true },
    { userId: "second", rank: 2, eligible: true },
    { userId: "banned", rank: 3, eligible: false },
    { userId: "fourth", rank: 4, eligible: true },
    { userId: "unranked", rank: null, eligible: true },
  ];
  it("passes to the best-ranked eligible seat without a prize", () => {
    expect(nextPlaced(seats, new Set(["first", "second"]), new Set(["first"]))).toBe("fourth");
  });
  it("skips the excluded and the paid", () => {
    expect(nextPlaced(seats, new Set(["second"]), new Set(["first"]))).toBe("fourth");
    expect(nextPlaced(seats, new Set(), new Set(["first"]))).toBe("second");
  });
  it("is null when nobody is left", () => {
    expect(nextPlaced(seats, new Set(["first", "second", "fourth"]), new Set())).toBeNull();
  });
});

describe("evenShares", () => {
  it("always sums to the amount, remainder to the first", () => {
    expect(evenShares(1000, 3)).toEqual([334, 333, 333]);
    expect(evenShares(7, 7)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(evenShares(5, 0)).toEqual([]);
  });
});

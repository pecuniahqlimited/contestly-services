import { describe, expect, it } from "vitest";
import { evenShares, nextPlaced, reviewPrize, type GradedAnswer } from "../src/hostWritten.js";

/** Not a repeat winner. */
const NONE = { priorWins: 0, max: 2 };
/** An established account: old enough, with plenty of finished parties. */
const SETTLED = { is: false, finishedParties: 20 };
/** The unlinked threshold, well above the linked one. */
const FAR = 90;
const answers = (rows: [string, boolean, number][]): GradedAnswer[] => rows.map(([userId, hostWritten, correctnessPct]) => ({ userId, hostWritten, correctnessPct }));

describe("reviewPrize", () => {
  // Two host-written questions and one themed: the winner got both host-written, the room one in four.
  const played = answers([
    ["w", true, 100], ["w", true, 100], ["w", false, 0],
    ["a", true, 0], ["a", true, 100], ["b", true, 0], ["b", true, 0],
  ]);

  it("flags a linked winner far above the room on the host's questions, and reports both comparisons", () => {
    const r = reviewPrize({ winnerId: "w", links: ["contact"], answers: played, marginPct: 30, newcomer: SETTLED, unlinkedMarginPct: FAR, repeat: NONE });
    expect(r.flagged).toBe(true);
    expect(r.evidence).toMatchObject({
      links: ["contact"], hostQuestionsPlayed: 2, winnerAccuracyPct: 100, roomAccuracyPct: 25, marginPct: 75,
      questionsPlayed: 3, winnerAllAccuracyPct: 66.7, roomAllAccuracyPct: 25, allMarginPct: 41.7, thresholdPct: 30, flaggedOn: ["host_written", "all"],
    });
  });

  it("flags on the whole set when the host's questions are within the margin (a curate host knows every answer)", () => {
    // Even on the host's questions; far ahead on the generated ones.
    const set = answers([
      ["w", true, 100], ["w", true, 0], ["w", false, 100], ["w", false, 100], ["w", false, 100],
      ["a", true, 100], ["a", true, 0], ["a", false, 0], ["a", false, 0], ["a", false, 0],
    ]);
    const r = reviewPrize({ winnerId: "w", links: ["crew"], answers: set, marginPct: 30, newcomer: SETTLED, unlinkedMarginPct: FAR, repeat: NONE });
    expect(r.evidence).toMatchObject({ marginPct: 0, allMarginPct: 60, flaggedOn: ["all"] });
    expect(r.flagged).toBe(true);
  });

  it("flags on the host's questions when the whole set is within the margin", () => {
    const set = answers([
      ["w", true, 100], ["w", false, 0], ["w", false, 0], ["w", false, 0],
      ["a", true, 0], ["a", false, 0], ["a", false, 0], ["a", false, 0],
    ]);
    const r = reviewPrize({ winnerId: "w", links: ["ip"], answers: set, marginPct: 30, newcomer: SETTLED, unlinkedMarginPct: FAR, repeat: NONE });
    expect(r.evidence).toMatchObject({ marginPct: 100, allMarginPct: 25, flaggedOn: ["host_written"] });
  });

  it("doesn't flag an established, unlinked winner below the unlinked threshold, however far above the linked one", () => {
    const r = reviewPrize({ winnerId: "w", links: [], answers: played, marginPct: 30, newcomer: SETTLED, unlinkedMarginPct: FAR, repeat: NONE });
    expect(r.flagged).toBe(false);
    expect(r.evidence).toMatchObject({ flaggedOn: [], newcomer: false, finishedParties: 20, unlinkedThresholdPct: FAR });
  });

  it("checks a newcomer (new account or few parties) as if linked, with no link at all", () => {
    const r = reviewPrize({ winnerId: "w", links: [], answers: played, marginPct: 30, newcomer: { is: true, finishedParties: 1 }, unlinkedMarginPct: FAR, repeat: NONE });
    expect(r.evidence).toMatchObject({ links: [], newcomer: true, finishedParties: 1, flaggedOn: ["host_written", "all"] });
    // Within the margin, a newcomer is paid like anyone.
    const even = answers([["w", true, 50], ["a", true, 50]]);
    expect(reviewPrize({ winnerId: "w", links: [], answers: even, marginPct: 30, newcomer: { is: true, finishedParties: 0 }, unlinkedMarginPct: FAR, repeat: NONE }).flagged).toBe(false);
  });

  it("flags anyone at or above the unlinked threshold, linked or not, newcomer or not", () => {
    // 75 points on the host's questions, 41.7 on the set.
    expect(reviewPrize({ winnerId: "w", links: [], answers: played, marginPct: 30, newcomer: SETTLED, unlinkedMarginPct: 75, repeat: NONE }).evidence.flaggedOn).toEqual(["host_written"]);
    expect(reviewPrize({ winnerId: "w", links: [], answers: played, marginPct: 30, newcomer: SETTLED, unlinkedMarginPct: 76, repeat: NONE }).flagged).toBe(false);
  });

  it("doesn't flag a linked winner within the margin on both; exactly at it flags", () => {
    expect(reviewPrize({ winnerId: "w", links: ["ip"], answers: played, marginPct: 80, newcomer: SETTLED, unlinkedMarginPct: FAR, repeat: NONE }).flagged).toBe(false);
    expect(reviewPrize({ winnerId: "w", links: ["ip"], answers: played, marginPct: 75, newcomer: SETTLED, unlinkedMarginPct: FAR, repeat: NONE }).evidence.flaggedOn).toEqual(["host_written"]);
  });

  it("with no host-written question played (all voided, say) only the whole set counts", () => {
    const themedOnly = answers([["w", false, 100], ["a", false, 0]]);
    const r = reviewPrize({ winnerId: "w", links: ["install"], answers: themedOnly, marginPct: 30, newcomer: SETTLED, unlinkedMarginPct: FAR, repeat: NONE });
    expect(r.evidence).toMatchObject({ hostQuestionsPlayed: 0, flaggedOn: ["all"] });
    expect(reviewPrize({ winnerId: "w", links: ["install"], answers: answers([["w", false, 50], ["a", false, 50]]), marginPct: 30, newcomer: SETTLED, unlinkedMarginPct: FAR, repeat: NONE }).flagged).toBe(false);
  });

  it("counts a room with nobody else as 0", () => {
    const r = reviewPrize({ winnerId: "w", links: ["played_with"], answers: answers([["w", true, 50]]), marginPct: 30, newcomer: SETTLED, unlinkedMarginPct: FAR, repeat: NONE });
    expect(r.evidence.roomAccuracyPct).toBe(0);
    expect(r.flagged).toBe(true);
  });
  it("holds a repeat winner of the same host's parties whatever they scored, linked or not", () => {
    const even = answers([["w", true, 50], ["a", true, 50]]);
    const r = reviewPrize({ winnerId: "w", links: [], answers: even, marginPct: 30, newcomer: SETTLED, unlinkedMarginPct: FAR, repeat: { priorWins: 2, max: 2 } });
    expect(r.evidence).toMatchObject({ flaggedOn: ["repeat"], priorWins: 2, repeatWinsMax: 2 });
    expect(reviewPrize({ winnerId: "w", links: [], answers: even, marginPct: 30, newcomer: SETTLED, unlinkedMarginPct: FAR, repeat: { priorWins: 1, max: 2 } }).flagged).toBe(false);
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

import { describe, expect, it } from "vitest";
import { crewWeekPlaces, socialBoardRanks } from "../src/index.js";

describe("socialBoardRanks", () => {
  it("ranks by Climb plus party points, ties sharing a rank", () => {
    const rows = socialBoardRanks([
      { userId: "a", climb: 300, parties: 140, prevTotal: 300 },
      { userId: "b", climb: 240, parties: 140, prevTotal: 380 },
      { userId: "c", climb: 380, parties: 0, prevTotal: null },
    ]);
    expect(rows.map((r) => [r.userId, r.total, r.rank])).toEqual([["a", 440, 1], ["b", 380, 2], ["c", 380, 2]]);
  });
  it("gives the start-of-day rank among those who were on the board then", () => {
    const rows = socialBoardRanks([
      { userId: "a", climb: 300, parties: 140, prevTotal: 300 },
      { userId: "b", climb: 240, parties: 140, prevTotal: 380 },
      { userId: "c", climb: 380, parties: 0, prevTotal: null },
    ]);
    expect(Object.fromEntries(rows.map((r) => [r.userId, r.prevRank]))).toEqual({ a: 2, b: 1, c: null });
  });
  it("handles an empty board", () => expect(socialBoardRanks([])).toEqual([]));
});

describe("crewWeekPlaces", () => {
  const day = (d: number) => new Date(Date.UTC(2026, 9, d));
  it("breaks a tie on Climb points, then on who joined first, and leaves out zeros", () => {
    const places = crewWeekPlaces([
      { userId: "a", climb: 100, parties: 60, joinedAt: day(3) },
      { userId: "b", climb: 120, parties: 40, joinedAt: day(5) },
      { userId: "c", climb: 120, parties: 40, joinedAt: day(1) },
      { userId: "d", climb: 0, parties: 0, joinedAt: day(1) },
    ]);
    expect(places).toEqual([{ userId: "c", points: 160, place: 1 }, { userId: "b", points: 160, place: 2 }, { userId: "a", points: 160, place: 3 }]);
  });
});

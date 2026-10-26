import { describe, expect, it } from "vitest";
import { DEFAULT_SOCIAL_CONFIG, challengeBrief, isBraggingRights, nextCreator, partyPointsFor } from "../src/index.js";

describe("isBraggingRights", () => {
  const free = { entryKobo: 0, funding: "pooled", prizeKind: "cash", hostPoolKobo: 0 };
  it("is a free party with nothing to win", () => expect(isBraggingRights(free)).toBe(true));
  it("is not a party with an entry fee", () => expect(isBraggingRights({ ...free, entryKobo: 10_000 })).toBe(false));
  it("is not a party with a host's cash prize", () => expect(isBraggingRights({ ...free, funding: "host", hostPoolKobo: 50_000 })).toBe(false));
  it("is not a party with goods to win", () => expect(isBraggingRights({ ...free, funding: "host", prizeKind: "product" })).toBe(false));
});

describe("partyPointsFor", () => {
  it("gives the finish points plus the place's", () => {
    expect(partyPointsFor(1, 4, DEFAULT_SOCIAL_CONFIG)).toBe(50);
    expect(partyPointsFor(3, 4, DEFAULT_SOCIAL_CONFIG)).toBe(20);
    expect(partyPointsFor(4, 4, DEFAULT_SOCIAL_CONFIG)).toBe(10);
  });
  it("gives nothing in a party too small to count", () => expect(partyPointsFor(1, 2, DEFAULT_SOCIAL_CONFIG)).toBe(0));
});

describe("nextCreator", () => {
  const d = (n: number) => new Date(Date.UTC(2026, 0, n));
  it("hands the crew to the longest-standing admin", () => {
    expect(nextCreator([
      { userId: "m1", role: "member", joinedAt: d(1) },
      { userId: "a2", role: "admin", joinedAt: d(5) },
      { userId: "a1", role: "admin", joinedAt: d(3) },
    ])?.userId).toBe("a1");
  });
  it("else to the longest-standing member", () => {
    expect(nextCreator([{ userId: "m2", role: "member", joinedAt: d(4) }, { userId: "m1", role: "member", joinedAt: d(2) }])?.userId).toBe("m1");
  });
  it("is nobody when nobody's left", () => expect(nextCreator([])).toBeNull());
});

describe("challengeBrief", () => {
  it("uses the lanes you share", () => expect(challengeBrief(["Football", "Afrobeats", "Tech"], ["Afrobeats", "Football"]).brief).toBe("A head-to-head quiz on Football and Afrobeats"));
  it("falls back to yours, then general knowledge", () => {
    expect(challengeBrief(["Nollywood"], ["Maths"]).lanes).toEqual(["Nollywood"]);
    expect(challengeBrief([], []).brief).toBe("A head-to-head general knowledge quiz");
  });
});

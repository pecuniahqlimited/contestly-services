import { describe, expect, it } from "vitest";
import { computeSettlement } from "../src/settlement.js";

const cfg = { rakeBps: 1000, hostCutBps: 0 };

describe("pooled pots", () => {
  it("takes rake once, then splits", () => {
    const s = computeSettlement({ funding: "pooled", entryKobo: 20_000, playerCount: 3, hostPoolKobo: 0, split: [100], ranked: ["a", "b", "c"] }, cfg);
    expect(s).toMatchObject({ potKobo: 60_000, rakeKobo: 6_000, hostCutKobo: 0, prizePoolKobo: 54_000 });
    expect(s.prizes).toEqual([{ userId: "a", rank: 1, amountKobo: 54_000 }]);
  });

  it("supports a host cut from config", () => {
    const s = computeSettlement({ funding: "pooled", entryKobo: 10_000, playerCount: 10, hostPoolKobo: 0, split: [100], ranked: ["a", "b"] }, { rakeBps: 1000, hostCutBps: 500 });
    expect(s.rakeKobo).toBe(10_000);
    expect(s.hostCutKobo).toBe(5_000);
    expect(s.prizes[0].amountKobo).toBe(85_000);
  });

  it("splits by rank and sends the rounding remainder to 1st", () => {
    const s = computeSettlement({ funding: "pooled", entryKobo: 111, playerCount: 3, hostPoolKobo: 0, split: [60, 30, 10], ranked: ["a", "b", "c"] }, { rakeBps: 0, hostCutBps: 0 });
    // pool 333 → floors 199/99/33 = 331, remainder 2 → 1st
    expect(s.prizes).toEqual([
      { userId: "a", rank: 1, amountKobo: 201 },
      { userId: "b", rank: 2, amountKobo: 99 },
      { userId: "c", rank: 3, amountKobo: 33 },
    ]);
    expect(s.prizes.reduce((t, p) => t + p.amountKobo, 0)).toBe(s.prizePoolKobo);
  });

  it("folds unfilled ranks' shares into 1st when fewer players than split entries", () => {
    const s = computeSettlement({ funding: "pooled", entryKobo: 10_000, playerCount: 2, hostPoolKobo: 0, split: [50, 30, 20], ranked: ["a", "b"] }, { rakeBps: 0, hostCutBps: 0 });
    expect(s.prizes).toEqual([
      { userId: "a", rank: 1, amountKobo: 14_000 }, // 10k own share + 4k unclaimed 3rd-place share
      { userId: "b", rank: 2, amountKobo: 6_000 },
    ]);
  });
});

describe("host-funded pots", () => {
  it("are never raked and carry no host cut", () => {
    const s = computeSettlement({ funding: "host", entryKobo: 0, playerCount: 20, hostPoolKobo: 2_000_000, split: [70, 30], ranked: ["a", "b", "c"] }, { rakeBps: 1000, hostCutBps: 500 });
    expect(s).toMatchObject({ potKobo: 2_000_000, rakeKobo: 0, hostCutKobo: 0 });
    expect(s.prizes).toEqual([
      { userId: "a", rank: 1, amountKobo: 1_400_000 },
      { userId: "b", rank: 2, amountKobo: 600_000 },
    ]);
  });
});

it("refuses to settle with no ranked players", () => {
  expect(() => computeSettlement({ funding: "pooled", entryKobo: 1, playerCount: 0, hostPoolKobo: 0, split: [100], ranked: [] }, cfg)).toThrow();
});

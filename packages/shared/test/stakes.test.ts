import { describe, expect, it } from "vitest";
import { afterRake, checkStakes, DEFAULT_PARTY_LIMITS as limits, kobo, partyLimitsSchema, placeShares, rakePercent, splitIdOf, visibleLimits, type StakesInput } from "../src/index.js";

const pooled: StakesInput = { funding: "pooled", entryKobo: kobo(200), maxPlayers: 6, split: "winner", prizeKind: "cash", hostPoolKobo: 0, places: [] };
const hostCash: StakesInput = { ...pooled, funding: "host", entryKobo: 0, hostPoolKobo: kobo(10_000), split: "70_30" };
const goods: StakesInput = { ...hostCash, hostPoolKobo: 0, prizeKind: "product", split: "60_30_10", places: [{ text: "A PlayStation 5" }, { text: "Headphones" }, { text: "A hoodie" }] };

describe("checkStakes", () => {
  it("passes stakes inside the limits", () => {
    expect(checkStakes(pooled, limits, false)).toEqual([]);
    expect(checkStakes(hostCash, limits, false)).toEqual([]);
    expect(checkStakes(goods, limits, true)).toEqual([]);
  });

  it("holds entry, host prize and seats to their ranges, ends included", () => {
    expect(checkStakes({ ...pooled, entryKobo: limits.entryMinKobo }, limits, false)).toEqual([]);
    expect(checkStakes({ ...pooled, entryKobo: limits.entryMinKobo - 100 }, limits, false)).toEqual(["entry_out_of_range"]);
    expect(checkStakes({ ...pooled, entryKobo: limits.entryMaxKobo + 100 }, limits, false)).toEqual(["entry_out_of_range"]);
    expect(checkStakes({ ...hostCash, hostPoolKobo: kobo(499) }, limits, false)).toEqual(["host_prize_out_of_range"]);
    expect(checkStakes({ ...hostCash, hostPoolKobo: limits.hostPrizeMaxKobo + 100 }, limits, false)).toEqual(["host_prize_out_of_range"]);
    expect(checkStakes({ ...pooled, maxPlayers: limits.seatsMax + 1 }, limits, false)).toEqual(["seats_out_of_range"]);
  });

  it("lets a pooled party be free (entry 0, bragging rights), whatever the entry minimum", () => {
    expect(checkStakes({ ...pooled, entryKobo: 0 }, { ...limits, entryMinKobo: kobo(500) }, false)).toEqual([]);
  });

  it("ignores a free party's split: any split, even one turned off, and no extra seat", () => {
    const free = { ...pooled, entryKobo: 0, split: "60_30_10" as const, maxPlayers: limits.seatsMin };
    expect(checkStakes(free, { ...limits, splits: ["winner"] }, false)).toEqual([]);
    // Seats still have to be inside the limits.
    expect(checkStakes({ ...free, maxPlayers: limits.seatsMax + 1 }, limits, false)).toEqual(["seats_out_of_range"]);
  });

  it("needs one more seat than a split has winners", () => {
    expect(checkStakes({ ...pooled, split: "60_30_10", maxPlayers: 3 }, limits, false)).toEqual(["split_needs_seats"]);
    expect(checkStakes({ ...pooled, split: "60_30_10", maxPlayers: 4 }, limits, false)).toEqual([]);
    expect(checkStakes({ ...pooled, split: "70_30", maxPlayers: 2 }, limits, false)).toEqual(["split_needs_seats"]);
  });

  it("refuses a split the admin turned off", () => {
    expect(checkStakes({ ...pooled, split: "70_30" }, { ...limits, splits: ["winner"] }, false)).toEqual(["split_not_allowed"]);
  });

  it("keeps goods to verified brands, with one prize per winning place", () => {
    expect(checkStakes(goods, limits, false)).toEqual(["prize_needs_verified_brand"]);
    expect(checkStakes({ ...goods, places: goods.places.slice(0, 2) }, limits, true)).toEqual(["prizes_incomplete"]);
    expect(checkStakes({ ...goods, places: [...goods.places.slice(0, 2), { text: "  " }] }, limits, true)).toEqual(["prizes_incomplete"]);
  });

  it("lists every error in the order the scene shows its fields", () => {
    expect(checkStakes({ ...goods, maxPlayers: 1, places: [] }, { ...limits, splits: ["winner"] }, false))
      .toEqual(["prize_needs_verified_brand", "prizes_incomplete", "seats_out_of_range", "split_not_allowed", "split_needs_seats"]);
  });
});

describe("prize math", () => {
  it("takes the rake and host cut once each", () => {
    expect(afterRake(kobo(1_200), { rakeBps: 1000, hostCutBps: 0 })).toBe(kobo(1_080));
    expect(afterRake(kobo(1_000), { rakeBps: 1000, hostCutBps: 500 })).toBe(kobo(850));
  });

  it("cuts a pool by place, the rounding remainder to 1st", () => {
    expect(placeShares(kobo(10_000), [70, 30])).toEqual([kobo(7_000), kobo(3_000)]);
    const shares = placeShares(333, [60, 30, 10]);
    expect(shares).toEqual([201, 99, 33]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(333);
  });

  it("names the split a party's shares match", () => {
    expect(splitIdOf([70, 30])).toBe("70_30");
    expect(splitIdOf([50, 30, 20])).toBeNull();
  });

  it("reads a rake as a percent", () => expect(rakePercent(1000)).toBe("10%"));
});

describe("party limits", () => {
  it("hides quick picks outside their range", () => {
    const v = visibleLimits({ ...limits, entryMinKobo: kobo(150), seatsMax: 10 });
    expect(v.entryPicksKobo).toEqual([200, 500, 1_000, 2_000].map(kobo));
    expect(v.seatPicks).toEqual([4, 6, 10]);
  });

  it("refuses a range upside down", () => {
    expect(partyLimitsSchema.safeParse({ ...limits, seatsMin: 50, seatsMax: 10 }).success).toBe(false);
    expect(partyLimitsSchema.safeParse({ ...limits, hostPrizeMinKobo: kobo(600_000) }).success).toBe(false);
    expect(partyLimitsSchema.safeParse(limits).success).toBe(true);
  });
});

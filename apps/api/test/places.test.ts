import { describe, expect, it } from "vitest";
import { kobo } from "@contestly/shared";
import { placesOf } from "../src/places.js";

const cfg = { rakeBps: 1000, hostCutBps: 0 };
const party = { funding: "pooled" as const, prizeKind: "cash" as const, entryKobo: kobo(200), hostPoolKobo: 0, split: [70, 30] };

describe("placesOf", () => {
  it("shares a pooled pot right now, after the rake", () => {
    // 6 × ₦200 = ₦1,200; less 10% = ₦1,080; 70/30
    expect(placesOf(party, 6, cfg, []).map((p) => p.amountKobo)).toEqual([kobo(756), kobo(324)]);
  });

  it("shares a host's cash prize with no rake", () => {
    const host = { ...party, funding: "host" as const, entryKobo: 0, hostPoolKobo: kobo(10_000) };
    expect(placesOf(host, 1, cfg, [])).toEqual([
      { place: 1, amountKobo: kobo(7_000), text: null, valueKobo: null },
      { place: 2, amountKobo: kobo(3_000), text: null, valueKobo: null },
    ]);
  });

  it("lists goods by place", () => {
    const goods = { ...party, funding: "host" as const, prizeKind: "product" as const, entryKobo: 0, split: [70, 30] };
    expect(placesOf(goods, 3, cfg, [{ place: 2, text: "Headphones", valueKobo: null }, { place: 1, text: "A PS5", valueKobo: kobo(900_000) }])).toEqual([
      { place: 1, amountKobo: null, text: "A PS5", valueKobo: kobo(900_000) },
      { place: 2, amountKobo: null, text: "Headphones", valueKobo: null },
    ]);
  });
});

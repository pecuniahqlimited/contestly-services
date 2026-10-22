import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ONBOARDING_CONFIG, archetypeOf, handleSchema, isStaked, normaliseEmail, normalisePhone, phoneHash, sharedCoins, soloCoins, whyFits,
} from "../src/index.js";

describe("normaliseEmail (the onboarding-bonus key)", () => {
  it("lowercases", () => expect(normaliseEmail("  Ada@Example.COM ")).toBe("ada@example.com"));
  it("drops Gmail dots and +tags, and folds googlemail.com into gmail.com", () => {
    expect(normaliseEmail("A.d.A+onboarding@gmail.com")).toBe("ada@gmail.com");
    expect(normaliseEmail("ada@googlemail.com")).toBe("ada@gmail.com");
  });
  it("leaves dots and +tags alone elsewhere (they're different mailboxes there)", () => {
    expect(normaliseEmail("a.da+x@yahoo.com")).toBe("a.da+x@yahoo.com");
  });
});

describe("normalisePhone", () => {
  it.each([["0803 000 0000", "+2348030000000"], ["8030000000", "+2348030000000"], ["2348030000000", "+2348030000000"], ["+234 803-000-0000", "+2348030000000"], ["+44 7700 900123", "+447700900123"]])("%s → %s", (raw, e164) => {
    expect(normalisePhone(raw)).toBe(e164);
  });
  it.each(["", "12345", "080300000", "not a number"])("refuses %j", (raw) => expect(normalisePhone(raw)).toBeNull());
});

describe("phoneHash", () => {
  it("is lowercase hex SHA-256 of the E.164 number, as the server expects", async () => {
    expect(await phoneHash("+2348030000000")).toBe(createHash("sha256").update("+2348030000000").digest("hex"));
  });
});

describe("onboarding coins", () => {
  const tiers = DEFAULT_ONBOARDING_CONFIG.soloTiers;
  it("pays the best tier reached, and the floor for zero", () => {
    expect(soloCoins(900, tiers)).toBe(50_000);
    expect(soloCoins(800, tiers)).toBe(50_000);
    expect(soloCoins(799, tiers)).toBe(40_000);
    expect(soloCoins(0, tiers)).toBe(20_000);
  });
  it("pays everyone in a shared round, past the list at the last amount", () => {
    const byRank = DEFAULT_ONBOARDING_CONFIG.sharedByRankKobo;
    expect([1, 2, 3, 4, 7].map((r) => sharedCoins(r, byRank))).toEqual([50_000, 40_000, 30_000, 20_000, 20_000]);
  });
});

describe("picks", () => {
  it("a person's why is a person answer, a brand's a brand answer", () => {
    expect(whyFits("person", "grinder")).toBe(true);
    expect(whyFits("person", "launch")).toBe(false);
    expect(whyFits("brand", "launch")).toBe(true);
    expect(whyFits(null, "fan")).toBe(true);
  });
  it("the archetype is a person's why; brands have none", () => {
    expect(archetypeOf("person", "grinder")).toBe("grinder");
    expect(archetypeOf("brand", "reach")).toBeNull();
    expect(archetypeOf(null, null)).toBeNull();
  });
  it("guest handles are reserved", () => {
    expect(handleSchema.safeParse("guest_abc").success).toBe(false);
    expect(handleSchema.safeParse("ada.o").success).toBe(true);
  });
});

describe("isStaked (guests can't join these)", () => {
  const free = { entryKobo: 0, funding: "pooled", prizeKind: "cash", hostPoolKobo: 0 };
  it("free: no entry, no cash prize", () => expect(isStaked(free)).toBe(false));
  it("an entry fee", () => expect(isStaked({ ...free, entryKobo: 10_000 })).toBe(true));
  it("a host's cash prize", () => expect(isStaked({ ...free, funding: "host", hostPoolKobo: 500_000 })).toBe(true));
  it("goods aren't cash: guests may play, but can't win", () => expect(isStaked({ ...free, funding: "host", prizeKind: "product", hostPoolKobo: 0 })).toBe(false));
});

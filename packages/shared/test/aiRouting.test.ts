/** AI routing (ADR 0016, 11 Nov 2026): the config's rules, each tier boundary, and the ceiling. */
import { describe, expect, it } from "vitest";
import { aiRoutingConfigSchema, initialAiRouting, maxPrizeKobo, profilesOutside, tierFor, withinCeiling, type AiRoutingConfig } from "../src/index.js";

/** Bragging rights on mock, up to ₦500 on free, anything above on paid. */
const config = (): AiRoutingConfig => ({
  ...initialAiRouting("mock"),
  tiers: [{ upToKobo: 0, profile: "mock" }, { upToKobo: 50_000, profile: "free" }, { upToKobo: null, profile: "paid" }],
});

describe("the prize a party is routed by", () => {
  it("is every seat's entry plus the host's cash prize", () => {
    expect(maxPrizeKobo({ entryKobo: 10_000, maxPlayers: 4, hostPrizeKobo: 0 })).toBe(40_000);
    expect(maxPrizeKobo({ entryKobo: 0, maxPlayers: 50, hostPrizeKobo: 250_000 })).toBe(250_000);
    expect(maxPrizeKobo({ entryKobo: 5_000, maxPlayers: 10, hostPrizeKobo: 100_000 })).toBe(150_000);
  });
});

describe("tiers", () => {
  it("each boundary: ₦0 is bragging rights, a bound is inclusive, a kobo over is the next tier", () => {
    const c = config();
    expect(tierFor(c, 0)).toEqual({ index: 0, tier: { upToKobo: 0, profile: "mock" } });
    expect(tierFor(c, 1).index).toBe(1);
    expect(tierFor(c, 50_000).index).toBe(1);
    expect(tierFor(c, 50_001)).toEqual({ index: 2, tier: { upToKobo: null, profile: "paid" } });
    expect(tierFor(c, 100_000_000).index).toBe(2);
  });

  it("start at ₦0, go up, and end unbounded", () => {
    const tiers = (t: AiRoutingConfig["tiers"]) => aiRoutingConfigSchema.safeParse({ ...config(), tiers: t }).success;
    expect(tiers([{ upToKobo: null, profile: "mock" }])).toBe(false); // the first must be ₦0
    expect(tiers([{ upToKobo: 0, profile: "mock" }])).toBe(false); // the last must be unbounded
    expect(tiers([{ upToKobo: 0, profile: "mock" }, { upToKobo: null, profile: "free" }])).toBe(true);
    expect(tiers([{ upToKobo: 0, profile: "mock" }, { upToKobo: 50_000, profile: "free" }, { upToKobo: 50_000, profile: "paid" }, { upToKobo: null, profile: "paid" }])).toBe(false);
    expect(tiers([{ upToKobo: 0, profile: "mock" }, { upToKobo: null, profile: "free" }, { upToKobo: null, profile: "paid" }])).toBe(false);
    expect(tiers([])).toBe(false);
  });

  it("each profile's models: the free one only free-tier models, paid generation on Claude, never the generator verifying", () => {
    const base = config();
    const ok = (c: unknown) => aiRoutingConfigSchema.safeParse(c).success;
    expect(ok(base)).toBe(true);
    expect(ok({ ...base, profiles: { ...base.profiles, free: { ...base.profiles.free, models: { ...base.profiles.free.models, verify: "claude-opus-5-5" } } } })).toBe(false);
    expect(ok({ ...base, profiles: { ...base.profiles, paid: { ...base.profiles.paid, models: { ...base.profiles.paid.models, generate: "gemini-3.8-flash" } } } })).toBe(false);
    expect(ok({ ...base, profiles: { ...base.profiles, paid: { ...base.profiles.paid, models: { generate: "claude-opus-5-5", verify: "claude-opus-5-5", safety: "claude-haiku-5-5" } } } })).toBe(false);
  });
});

describe("the ceiling (AI_ALLOWED_PROFILES)", () => {
  it("names what a save may not use", () => {
    expect(profilesOutside(config(), ["mock", "free"])).toEqual(["paid"]);
    expect(profilesOutside(config(), ["mock", "free", "paid"])).toEqual([]);
    expect(profilesOutside({ ...config(), defaultProfile: "free" }, ["free", "paid"])).toEqual(["mock"]);
  });

  it("at call time: the configured profile if allowed, else the highest allowed below it, else none", () => {
    expect(withinCeiling("paid", ["mock", "free", "paid"])).toBe("paid");
    expect(withinCeiling("paid", ["mock", "free"])).toBe("free");
    expect(withinCeiling("paid", ["mock"])).toBe("mock");
    expect(withinCeiling("free", ["free", "paid"])).toBe("free");
    expect(withinCeiling("mock", ["free", "paid"])).toBeNull();
  });
});

describe("version 1", () => {
  it("puts the default and every tier on the initial profile, with the free and paid models it had", () => {
    const v1 = aiRoutingConfigSchema.parse(initialAiRouting("free", { generate: "claude-sonnet-5-5", verify: "gemini-3.8-flash", safety: "claude-haiku-5-5" }));
    expect(v1.defaultProfile).toBe("free");
    expect(v1.tiers.map((t) => t.profile)).toEqual(["free", "free"]);
    expect(v1.profiles.paid.models.verify).toBe("gemini-3.8-flash");
    expect(v1.profiles.free.models).toEqual({ generate: "gemini-3.5-flash-lite", verify: "gemini-3.6-flash", safety: "gemini-3.1-flash-lite" });
  });
});

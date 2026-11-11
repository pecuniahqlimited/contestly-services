/**
 * AI routing (ADR 0016, 11 Nov 2026) against the real database, set through the admin API as the console does:
 * each tier boundary; a profile outside the ceiling refused on save and the fallback at call time; a change taking
 * effect on the next job with no restart; the $0 paid cap still refusing every paid call; and the route kept on the
 * generation records and provider calls.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { adminActions, adminAlerts, aiRoutingConfigs, db, ledger, providerCalls, sql, type User } from "@contestly/db";
import { initialAiRouting, type AiProfile, type AiRoutingConfig } from "@contestly/shared";
import { generateSet } from "../../questions/src/pipeline/generateSet.js";
import { mockProviders, PROFILE_BUILDERS, ProviderRegistry, dbCallDeps } from "../../questions/src/providers/index.js";
import { routeParty, routePrize, routeStakes } from "../../questions/src/routing.js";
import { as, makeUser, testApp } from "./harness.js";

let app: Awaited<ReturnType<typeof testApp>>["app"];
let admin: User;
let n = 0;
const saved = { allowed: process.env.AI_ALLOWED_PROFILES, anthropic: process.env.ANTHROPIC_API_KEY, gemini: process.env.GEMINI_API_KEY };
const ceiling = (profiles: AiProfile[]) => { process.env.AI_ALLOWED_PROFILES = profiles.join(","); };

/** Bragging rights on mock, up to ₦500 on free, anything above on paid. */
const tiered = (over: Partial<AiRoutingConfig> = {}): AiRoutingConfig => ({
  ...initialAiRouting("mock"),
  tiers: [{ upToKobo: 0, profile: "mock" }, { upToKobo: 50_000, profile: "free" }, { upToKobo: null, profile: "paid" }],
  ...over,
});
const put = (config: AiRoutingConfig, reason = "test routing") => app.inject({ method: "PUT", url: "/admin/ai/routing", headers: as(admin), payload: { config, reason } });
const preview = (stakes: { entryKobo: number; maxPlayers: number; hostPrizeKobo?: number }) => app.inject({ method: "POST", url: "/admin/ai/routing/preview", headers: as(admin), payload: { stakes } });
const createParty = async (payload: Record<string, unknown> = {}) => {
  const host = await makeUser(`airoute${++n}${Date.now() % 100000}`);
  // The host plays, so pays the entry like anyone.
  await db.transaction((tx) => ledger.post(tx, { userId: host.id, kind: "cash", amountKobo: 100_000, type: "topup", idempotencyKey: `t:airoute:${host.id}` }));
  const res = await app.inject({ method: "POST", url: "/parties", headers: as(host), payload: { title: "Routing", brief: "Nigerian geography and landmarks", entryKobo: 0, maxPlayers: 4, funding: "pooled", split: "winner", questionCount: 3, visibility: "private", ...payload } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
};

beforeAll(async () => {
  ({ app } = await testApp());
  admin = await makeUser(`airouteadmin${Date.now() % 100000}`, { isAdmin: true });
});
afterEach(async () => {
  process.env.AI_ALLOWED_PROFILES = saved.allowed;
  process.env.ANTHROPIC_API_KEY = saved.anthropic;
  process.env.GEMINI_API_KEY = saved.gemini;
  // Leave the routing as every other test expects it: everything on mock.
  ceiling(["mock", "free"]);
  await put(initialAiRouting("mock"), "back to mock after a routing test");
  process.env.AI_ALLOWED_PROFILES = saved.allowed;
});
afterAll(async () => {
  await app.close();
  await sql.end();
});

describe("the routing config", () => {
  it("reads as a version with its ceiling; a save is a new version, logged with the reason", async () => {
    ceiling(["mock", "free", "paid"]);
    const before = (await app.inject({ method: "GET", url: "/admin/ai/routing", headers: as(admin) })).json();
    expect(before.ceiling.allowed).toEqual(["mock", "free", "paid"]);
    expect(before.ceiling.paidCapMicros).toBe(0);
    const res = await put(tiered(), "route stakes to providers");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ version: before.version + 1, reason: "route stakes to providers", createdBy: { id: admin.id } });
    const [log] = await db.select().from(adminActions).where(and(eq(adminActions.action, "config.ai_routing"), eq(adminActions.adminUserId, admin.id))).orderBy(desc(adminActions.createdAt)).limit(1);
    expect(log).toMatchObject({ reason: "route stakes to providers", targetId: "ai_routing" });
    expect((await put(tiered(), "x")).statusCode).toBe(400); // a reason is words, not a letter
    expect((await app.inject({ method: "GET", url: "/admin/ai/routing", headers: as(await makeUser(`notadmin${Date.now() % 100000}`)) })).statusCode).toBe(403);
  });

  it("each tier boundary: ₦0, the bound itself, a kobo over it; the host's cash prize counts", async () => {
    ceiling(["mock", "free", "paid"]);
    await put(tiered());
    const at = async (stakes: Parameters<typeof preview>[0]) => (await preview(stakes)).json();
    expect(await at({ entryKobo: 0, maxPlayers: 8 })).toMatchObject({ prizeKobo: 0, tier: { index: 0, upToKobo: 0 }, profile: "mock", models: null });
    expect(await at({ entryKobo: 12_500, maxPlayers: 4 })).toMatchObject({ prizeKobo: 50_000, tier: { index: 1 }, profile: "free", models: { generate: "gemini-3.5-flash-lite", embed: "gemini-embedding-2" } });
    expect(await at({ entryKobo: 0, maxPlayers: 4, hostPrizeKobo: 50_001 })).toMatchObject({ prizeKobo: 50_001, tier: { index: 2, upToKobo: null }, profile: "paid", paidOff: true });
    // The same boundaries when a party's job is routed.
    const registry = new ProviderRegistry(dbCallDeps(), { ...PROFILE_BUILDERS, free: () => mockProviders(), paid: () => mockProviders() });
    expect((await routeParty(await createParty({ entryKobo: 0 }), registry)).route).toMatchObject({ configured: "mock", profile: "mock", tier: { index: 0 }, prizeKobo: 0 });
    expect((await routeParty(await createParty({ entryKobo: 12_500, maxPlayers: 4 }), registry)).route).toMatchObject({ profile: "free", tier: { index: 1 }, prizeKobo: 50_000 });
    // Entries are whole naira, so a party lands just over the bound at ₦126 × 4 (the preview checked one kobo over).
    expect((await routeParty(await createParty({ entryKobo: 12_600, maxPlayers: 4 }), registry)).route).toMatchObject({ profile: "paid", tier: { index: 2 }, prizeKobo: 50_400 });
    // Distractor suggestions: the builder's draft stakes; none given, the default profile.
    expect((await routeStakes({ entryKobo: 12_500, maxPlayers: 4, hostPrizeKobo: 0 }, registry)).route).toMatchObject({ profile: "free", prizeKobo: 50_000 });
    expect((await routeStakes(undefined, registry)).route).toMatchObject({ tier: null });
    // Not tied to a party: the default profile.
    expect((await routePrize(null, registry)).route).toMatchObject({ configured: "mock", tier: null, prizeKobo: null });
  });
});

describe("the ceiling", () => {
  it("a profile outside AI_ALLOWED_PROFILES is refused on save, and nothing is saved", async () => {
    ceiling(["mock", "free"]);
    const [{ version }] = await db.select({ version: aiRoutingConfigs.version }).from(aiRoutingConfigs).orderBy(desc(aiRoutingConfigs.version)).limit(1);
    const res = await put(tiered());
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "ai_profile_not_allowed", details: { profiles: ["paid"], allowed: ["mock", "free"] } });
    expect((await put({ ...initialAiRouting("mock"), defaultProfile: "paid" })).json().details.profiles).toEqual(["paid"]);
    const [after] = await db.select({ version: aiRoutingConfigs.version }).from(aiRoutingConfigs).orderBy(desc(aiRoutingConfigs.version)).limit(1);
    expect(after.version).toBe(version);
  });

  it("at call time, a profile the ceiling no longer allows falls back to the highest allowed below it, logged and alerted", async () => {
    ceiling(["mock", "free", "paid"]);
    await put(tiered());
    ceiling(["mock", "free"]); // the server's ceiling came down after the save
    const registry = new ProviderRegistry(dbCallDeps(), { ...PROFILE_BUILDERS, free: () => mockProviders() });
    const { route } = await routePrize(1_000_000, registry);
    expect(route).toMatchObject({ configured: "paid", profile: "free", tier: { index: 2 } });
    const [alert] = await db.select().from(adminAlerts).where(eq(adminAlerts.dedupeKey, "ai.profile_fallback:paid:free"));
    expect(alert).toMatchObject({ kind: "ai.profile_fallback", severity: "warning" });
    // Nothing allowed at or below: nothing is called.
    ceiling(["free", "paid"]);
    const none = await routePrize(0, registry);
    expect(none.route).toMatchObject({ configured: "mock", profile: null });
    await expect(none.providers.generator.draft({ spec: {} as never, count: 1, avoid: [] })).rejects.toMatchObject({ name: "ProviderUnavailable" });
  });
});

describe("a live change", () => {
  it("takes effect on the next job, with no restart; the route is kept on each generation record", async () => {
    const built: AiProfile[] = [];
    const tagged = (profile: AiProfile) => () => { built.push(profile); return mockProviders(); };
    // One registry for the whole test, as one questions process keeps it.
    const registry = new ProviderRegistry(dbCallDeps(), { mock: tagged("mock"), free: tagged("free"), paid: tagged("paid") });
    ceiling(["mock", "free"]);
    const first = await createParty();
    const a = await routeParty(first, registry);
    expect(a.route.profile).toBe("mock");
    const { withCallContext } = await import("@contestly/ai");
    await withCallContext({ partyId: first, job: "generate_set", route: a.route }, () => generateSet(first, { providers: a.providers, publish: async () => undefined }));
    // Each generation record the job writes carries its route (the bank may have filled this small set, so build one as the fill does).
    const { generationRecord } = await import("../../questions/src/pipeline/records.js");
    const judged = { draft: { format: "pick_one", payload: {}, claim: "c" }, verify: null, nearest: null, difficulty: { value: 0.5, source: "model" }, safety: { passed: true, reasons: [] }, outcome: "accepted", bankId: "b" };
    const rec = await withCallContext({ partyId: first, job: "generate_set", route: a.route }, async () => generationRecord(judged as never, { partyId: first, brief: "b", spec: {} as never, banked: false }));
    expect(rec.route).toMatchObject({ profile: "mock", configured: "mock", tier: { index: 0, upToKobo: 0 }, prizeKobo: 0 });

    await put({ ...initialAiRouting("mock"), tiers: [{ upToKobo: 0, profile: "free" }, { upToKobo: null, profile: "free" }] }, "bragging rights on the free tier");
    const second = await createParty();
    const b = await routeParty(second, registry);
    expect(b.route).toMatchObject({ profile: "free", configured: "free" });
    expect(built).toEqual(["mock", "free"]);
  });
});

describe("the paid cap", () => {
  it("at $0, a party routed to paid makes no paid request: every call refused before it's sent, recorded under the paid profile", async () => {
    ceiling(["mock", "free", "paid"]);
    await put({ ...initialAiRouting("mock"), tiers: [{ upToKobo: 0, profile: "paid" }, { upToKobo: null, profile: "paid" }] }, "everything on paid");
    // Keys set, so the paid profile builds; AI_PAID_CAP_USD is 0 in tests, so providerCall refuses each call first.
    process.env.ANTHROPIC_API_KEY = "test-key-never-used";
    process.env.GEMINI_API_KEY = "test-key-never-used";
    const registry = new ProviderRegistry(dbCallDeps());
    const id = await createParty();
    const routed = await routeParty(id, registry);
    expect(routed.route.profile).toBe("paid");
    const { withCallContext } = await import("@contestly/ai");
    await expect(withCallContext({ partyId: id, job: "generate_set", route: routed.route }, () => generateSet(id, { providers: routed.providers, publish: async () => undefined }))).rejects.toThrow();
    const calls = await db.select().from(providerCalls).where(eq(providerCalls.partyId, id));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.outcome === "budget" && c.requests === 0 && c.costMicros === 0 && c.profile === "paid")).toBe(true);
    expect(calls[0].error).toMatch(/paid providers are off/);
  });
});

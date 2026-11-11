/**
 * OPT-IN: the real providers against the real APIs, one small call each. Run with
 * LIVE_PROVIDERS=1 npx vitest run test/live.test.ts (from apps/questions, keys in the environment).
 *
 * By default it uses only Gemini's free tier (the free profile's models): it costs nothing, and counts against
 * the free daily quotas. The Claude calls run only when AI_PAID_CAP_USD is above 0 as well, because they cost
 * money; without it they're skipped, never attempted. Usage goes to memory, not the database.
 */
import { describe, expect, it } from "vitest";
import { Breakers, claudeClient, DEFAULT_RETRY, geminiClient, MemorySink, noBudget, paidCapMicrosFromEnv, type CallDeps } from "@contestly/ai";
import { DEFAULT_PAID_MODELS, EMBEDDING_DIM, FREE_PROFILE_MODELS } from "@contestly/shared";
import { payloadSchemas } from "@contestly/game";
import { anthropicGenerator } from "../src/providers/anthropic/generator.js";
import { claudeVerifier } from "../src/providers/anthropic/verifier.js";
import { claudeSafety } from "../src/providers/anthropic/safety.js";
import { freeProviders } from "../src/providers/index.js";
import { buildSpec } from "../src/pipeline/spec.js";

const live = !!process.env.LIVE_PROVIDERS;
const paidAllowed = live && paidCapMicrosFromEnv() > 0;
const sink = new MemorySink();
const deps: CallDeps = { sink, budget: noBudget, breakers: new Breakers({ failureThreshold: 5, cooldownMs: 60_000 }), retry: DEFAULT_RETRY, timeoutMs: 180_000 };
const noCache = { get: async () => null, put: async () => {} };
const spec = buildSpec({ brief: "Naija football: the Super Eagles at the Africa Cup of Nations", difficulty: "easy", formats: ["pick_one"], questionCount: 2, questionSeconds: 15 });
const q = { format: "pick_one" as const, payload: { question: "Who coached Nigeria to the 2013 AFCON title?", options: ["Stephen Keshi", "Gernot Rohr", "Sunday Oliseh", "Clemens Westerhof"], correctIndex: 0 }, claim: "Stephen Keshi coached Nigeria to the 2013 Africa Cup of Nations title." };

describe.skipIf(!live)("live providers: the free profile (Gemini free tier, $0)", () => {
  const p = () => freeProviders(() => deps, geminiClient({ apiKey: process.env.GEMINI_API_KEY ?? "" }), noCache, async () => 10, (step) => async () => FREE_PROFILE_MODELS[step]);

  it("writes valid questions", async () => {
    const drafts = await p().generator.draft({ spec, count: 2, avoid: [] });
    expect(drafts.length).toBeGreaterThan(0);
    for (const d of drafts) expect(payloadSchemas[d.format].safeParse(d.payload).success).toBe(true);
  }, 240_000);

  it("verifies without sources, embeds and reviews safety", async () => {
    const v = await p().verifier.verify(q);
    expect(v).toMatchObject({ verdict: "correct", unsourced: true, sources: [] });
    const [e] = await p().embedder.embed([q.payload.question]);
    expect(e).toHaveLength(EMBEDDING_DIM);
    const [s] = await p().safety.review(spec, [q]);
    expect(s.passed).toBe(true);
    expect(sink.records.every((r) => r.tier === "free" && r.costMicros === 0)).toBe(true);
    expect(FREE_PROFILE_MODELS.verify).not.toBe(FREE_PROFILE_MODELS.generate);
  }, 240_000);
});

describe.skipIf(!paidAllowed)("live providers: the paid profile's Claude calls (costs money; AI_PAID_CAP_USD > 0)", () => {
  const client = () => claudeClient({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" });
  const models = DEFAULT_PAID_MODELS;

  it("Claude writes, verifies with web search and reviews safety", async () => {
    const drafts = await anthropicGenerator({ client: client(), call: deps, model: async () => models.generate }).draft({ spec, count: 2, avoid: [] });
    expect(drafts.length).toBeGreaterThan(0);
    const v = await claudeVerifier({ client: client(), call: deps, model: async () => models.verify }).verify(q);
    expect(v.verdict).toBe("correct");
    expect(v.sources.length).toBeGreaterThan(0);
    const [s] = await claudeSafety({ client: client(), call: deps, model: async () => models.safety }).review(spec, [q]);
    expect(s.passed).toBe(true);
  }, 240_000);
});

/**
 * OPT-IN: the real providers against the real APIs, one small call each. Costs a few cents; needs
 * ANTHROPIC_API_KEY (generation, the default verifier and safety check) and GEMINI_API_KEY (embeddings; the
 * Gemini verifier and safety check only with LIVE_GEMINI_CHECKS=1, since grounding needs billing). Run with: LIVE_PROVIDERS=1 npx vitest run test/live.test.ts (from
 * apps/questions, with the keys in the environment). Usage goes to memory, not the database.
 */
import { describe, expect, it } from "vitest";
import { Breakers, claudeClient, DEFAULT_RETRY, geminiClient, MemorySink, noBudget, type CallDeps } from "@contestly/ai";
import { DEFAULT_PROVIDERS_CONFIG, EMBEDDING_DIM } from "@contestly/shared";
import { payloadSchemas } from "@contestly/game";
import { anthropicGenerator } from "../src/providers/anthropic/generator.js";
import { geminiVerifier } from "../src/providers/gemini/verifier.js";
import { geminiSafety } from "../src/providers/gemini/safety.js";
import { geminiEmbedder } from "../src/providers/gemini/embedder.js";
import { claudeVerifier } from "../src/providers/anthropic/verifier.js";
import { claudeSafety } from "../src/providers/anthropic/safety.js";
import { buildSpec } from "../src/pipeline/spec.js";

const live = !!process.env.LIVE_PROVIDERS;
const sink = new MemorySink();
const deps: CallDeps = { sink, budget: noBudget, breakers: new Breakers({ failureThreshold: 5, cooldownMs: 60_000 }), retry: DEFAULT_RETRY, timeoutMs: 180_000 };
const models = DEFAULT_PROVIDERS_CONFIG.models;
const spec = buildSpec({ brief: "Naija football: the Super Eagles at the Africa Cup of Nations", difficulty: "easy", formats: ["pick_one"], questionCount: 2, questionSeconds: 15 });

describe.skipIf(!live)("live providers", () => {
  it("Claude writes valid questions", async () => {
    const gen = anthropicGenerator({ client: claudeClient({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" }), call: deps, model: async () => models.generate });
    const drafts = await gen.draft({ spec, count: 2, avoid: [] });
    expect(drafts.length).toBeGreaterThan(0);
    for (const d of drafts) expect(payloadSchemas[d.format].safeParse(d.payload).success).toBe(true);
  }, 240_000);

  const q = { format: "pick_one" as const, payload: { question: "Who coached Nigeria to the 2013 AFCON title?", options: ["Stephen Keshi", "Gernot Rohr", "Sunday Oliseh", "Clemens Westerhof"], correctIndex: 0 }, claim: "Stephen Keshi coached Nigeria to the 2013 Africa Cup of Nations title." };

  it("Claude verifies with web search and reviews safety", async () => {
    const client = claudeClient({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" });
    const verdict = await claudeVerifier({ client, call: deps, model: async () => models.verify }).verify(q);
    expect(verdict.verdict).toBe("correct");
    expect(verdict.sources.length).toBeGreaterThan(0);
    const [s] = await claudeSafety({ client, call: deps, model: async () => models.safety }).review(spec, [q]);
    expect(s.passed).toBe(true);
  }, 240_000);

  it("Gemini embeds", async () => {
    const [v] = await geminiEmbedder({ client: geminiClient({ apiKey: process.env.GEMINI_API_KEY ?? "" }), call: deps, model: "gemini-embedding-2" }).embed([q.payload.question]);
    expect(v).toHaveLength(EMBEDDING_DIM);
  }, 240_000);

  it.skipIf(!process.env.LIVE_GEMINI_CHECKS)("Gemini verifies with Google Search and reviews safety", async () => {
    const client = geminiClient({ apiKey: process.env.GEMINI_API_KEY ?? "" });
    const verdict = await geminiVerifier({ client, call: deps, model: async () => "gemini-3.8-flash" }).verify(q);
    expect(verdict.verdict).toBe("correct");
    expect(verdict.sources.length).toBeGreaterThan(0);
    const [s] = await geminiSafety({ client, call: deps, model: async () => "gemini-3.5-flash-lite" }).review(spec, [q]);
    expect(s.passed).toBe(true);
  }, 240_000);
});

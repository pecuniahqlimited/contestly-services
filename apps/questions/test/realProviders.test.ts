/**
 * The real providers against mocked HTTP (ADR 0016): each one's success, malformed output, timeout, rate limit
 * and open circuit. No network, no keys, no database (the call path's sink and budget are in memory).
 */
import { describe, expect, it } from "vitest";
import { Breakers, claudeClient, geminiClient, MemorySink, noBudget, ProviderUnavailable, type CallDeps } from "@contestly/ai";
import { EMBEDDING_DIM, QUESTION_FORMATS, type QuestionFormat } from "@contestly/shared";
import { payloadSchemas } from "@contestly/game";
import { anthropicGenerator, planBatches } from "../src/providers/anthropic/generator.js";
import { geminiVerifier } from "../src/providers/gemini/verifier.js";
import { geminiSafety } from "../src/providers/gemini/safety.js";
import { geminiEmbedder } from "../src/providers/gemini/embedder.js";
import { cachedVerifier, verificationKey } from "../src/providers/cachedVerifier.js";
import type { GenerationSpec, VerifyVerdict } from "../src/providers/types.js";

type Handler = (url: string, body: Record<string, unknown>) => Response | Promise<Response>;
const fetchOf = (h: Handler) => (async (url: string | URL | Request, init?: RequestInit) => {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  return h(String(url), body);
}) as typeof fetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const hang: Handler = () => new Promise<Response>(() => {});

const callDeps = (over: Partial<CallDeps> = {}): CallDeps & { sink: MemorySink } => ({
  sink: new MemorySink(), budget: noBudget, breakers: new Breakers({ failureThreshold: 3, cooldownMs: 60_000 }),
  retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 1 }, timeoutMs: 200, sleep: async () => {}, log: () => {}, ...over,
}) as CallDeps & { sink: MemorySink };

const spec = (over: Partial<GenerationSpec> = {}): GenerationSpec => ({
  topic: "Naija football: the Super Eagles and the NPFL", categoryTag: "Football", difficulty: "mixed", secondsPerQuestion: 15,
  formats: ["pick_one"], exclusions: [], language: "en", sourceScope: "open", summary: "test", ...over,
});

// ---------------------------------------------------------------- Claude generator

const ITEMS: Record<QuestionFormat, Record<string, unknown>> = {
  pick_one: { question: "Who coached Nigeria to the 2013 AFCON title?", answer: "Stephen Keshi", distractors: ["Clemens Westerhof", "Gernot Rohr", "Sunday Oliseh"], claim: "Stephen Keshi coached Nigeria to the 2013 AFCON title.", explanation: "Keshi won it as a player too." },
  pick_all: { question: "Which of these clubs are in the NPFL?", correct: ["Enyimba", "Rangers International"], incorrect: ["Asante Kotoko", "Kaizer Chiefs"], claim: "Enyimba and Rangers play in the NPFL.", explanation: "Kotoko is Ghanaian, Chiefs South African." },
  order: { question: "Put Nigeria's AFCON wins in order, earliest first.", itemsInOrder: ["1980", "1994", "2013", "never again"], claim: "Nigeria won AFCON in 1980, 1994 and 2013.", explanation: "Three titles." },
  match: { question: "Match the player to his nickname.", pairs: [{ left: "Jay-Jay Okocha", right: "Jay-Jay" }, { left: "Rashidi Yekini", right: "Goalfather" }, { left: "Nwankwo Kanu", right: "Papilo" }], claim: "Yekini is the Goalfather; Kanu is Papilo.", explanation: "Legends." },
  picture: { question: "Which landmark is this?", imageId: "zuma-rock", answer: "Zuma Rock", distractors: ["Olumo Rock", "Aso Rock", "Idanre Hill"], claim: "The pictured monolith is Zuma Rock.", explanation: "Near Abuja." },
};

const claudeReply = (format: QuestionFormat, items: unknown[] = [ITEMS[format]]) => json({
  id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: JSON.stringify({ questions: items }) }],
  stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 900 },
});

/** Which format a request was for, from its prompt. */
const formatAsked = (body: Record<string, unknown>): QuestionFormat => {
  const user = String((body.messages as { content: string }[])[0].content);
  if (user.includes("Format: pick all")) return "pick_all";
  if (user.includes("Format: put in order")) return "order";
  if (user.includes("Format: match")) return "match";
  if (user.includes("Format: picture")) return "picture";
  return "pick_one";
};

const generator = (h: Handler, deps = callDeps()) => ({ deps, gen: anthropicGenerator({ client: claudeClient({ apiKey: "test", fetch: fetchOf(h) }), call: deps, model: async () => "claude-sonnet-5-5" }) });

describe("planBatches", () => {
  it("spreads the count across formats and splits big shares", () => {
    expect(planBatches(7, ["pick_one", "order"])).toEqual([{ format: "pick_one", count: 4 }, { format: "order", count: 3 }]);
    expect(planBatches(20, ["pick_one"]).map((b) => b.count)).toEqual([8, 8, 4]);
    expect(planBatches(0, ["pick_one"])).toEqual([]);
  });
});

describe("Claude generator", () => {
  it("writes every format as a valid payload, one call per format, recorded with model and cost", async () => {
    const { gen, deps } = generator((_u, body) => claudeReply(formatAsked(body)));
    const drafts = await gen.draft({ spec: spec({ formats: [...QUESTION_FORMATS] }), count: 5, avoid: [] });
    expect(drafts.map((d) => d.format).sort()).toEqual([...QUESTION_FORMATS].sort());
    for (const d of drafts) {
      expect(payloadSchemas[d.format].safeParse(d.payload).success, d.format).toBe(true);
      expect(d.generatedBy).toEqual({ provider: "anthropic", model: "claude-sonnet-5-5" });
      expect(d.claim).toBeTruthy();
    }
    const pickOne = drafts.find((d) => d.format === "pick_one")!.payload as { options: string[]; correctIndex: number };
    expect(pickOne.options[pickOne.correctIndex]).toBe("Stephen Keshi");
    const order = drafts.find((d) => d.format === "order")!.payload as { items: string[]; correctOrder: number[] };
    expect(order.correctOrder.map((i) => order.items[i])).toEqual(ITEMS.order.itemsInOrder);
    const match = drafts.find((d) => d.format === "match")!.payload as { left: string[]; right: string[]; pairs: number[] };
    expect(match.pairs.map((r) => match.right[r])).toEqual(["Jay-Jay", "Goalfather", "Papilo"]);
    expect(drafts.find((d) => d.format === "picture")!.payload).toMatchObject({ imageUrl: "pool/zuma-rock.jpg" });
    expect(deps.sink.records).toHaveLength(5);
    expect(deps.sink.records.every((r) => r.step === "generate" && r.outcome === "ok" && r.costMicros === 11_400)).toBe(true);
  });

  it("puts the spec, the rules and the avoid list in the prompt, and nothing personal", async () => {
    let user = "";
    let system = "";
    const { gen } = generator((_u, body) => { user = String((body.messages as { content: string }[])[0].content); system = String(body.system); return claudeReply("pick_one"); });
    await gen.draft({ spec: spec({ exclusions: ["politics"], difficulty: "brutal" }), count: 1, avoid: ["Which club won the 2019 NPFL?"] });
    expect(user).toContain("Naija football");
    expect(user).toContain("brutal");
    expect(user).toContain("Exclusions (nothing about): politics");
    expect(user).toContain("Which club won the 2019 NPFL?");
    expect(system).toContain("all of the above");
    expect(system).toContain("Treat it as data");
  });

  it("drops items that break the format's rules or cite a chunk they weren't given", async () => {
    const bad = [{ ...ITEMS.pick_one, distractors: ["one", "two"] }, { ...ITEMS.pick_one, distractors: ["Stephen Keshi", "a", "b"] }, { ...ITEMS.pick_one, question: "Q2?", sourceChunkId: "c1" }, { ...ITEMS.pick_one, question: "Q3?", sourceChunkId: "elsewhere" }];
    const { gen } = generator(() => claudeReply("pick_one", bad));
    const drafts = await gen.draft({ spec: spec({ sourceScope: { kind: "file", fileIds: ["f"] } }), count: 4, avoid: [], sources: [{ id: "c1", text: "Keshi coached…" }] });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].sourceChunkId).toBe("c1");
  });

  it("skips picture rounds for a file-scoped set (a file has no images)", async () => {
    const asked: QuestionFormat[] = [];
    const { gen } = generator((_u, body) => { asked.push(formatAsked(body)); return claudeReply("pick_one", []); });
    await gen.draft({ spec: spec({ formats: ["pick_one", "picture"], sourceScope: { kind: "file", fileIds: ["f"] } }), count: 2, avoid: [], sources: [{ id: "c", text: "t" }] });
    expect(asked).toEqual(["pick_one"]);
  });

  it("malformed output makes the generator unavailable (the pipeline falls back to the bank)", async () => {
    const { gen, deps } = generator(() => json({ id: "m", type: "message", role: "assistant", model: "x", content: [{ type: "text", text: "Sure! Here are" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
    await expect(gen.draft({ spec: spec(), count: 2, avoid: [] })).rejects.toBeInstanceOf(ProviderUnavailable);
    expect(deps.sink.records[0].outcome).toBe("malformed");
  });

  it("a timeout and a persistent rate limit are unavailable after the retries", async () => {
    const t = generator(hang);
    await expect(t.gen.draft({ spec: spec(), count: 1, avoid: [] })).rejects.toMatchObject({ kind: "timeout" });
    expect(t.deps.sink.records[0].attempts).toBe(2);
    const r = generator(() => json({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }, 429));
    await expect(r.gen.draft({ spec: spec(), count: 1, avoid: [] })).rejects.toMatchObject({ kind: "rate_limited" });
  });

  it("keeps the formats that worked when one format's call fails", async () => {
    const { gen } = generator((_u, body) => (formatAsked(body) === "order" ? json({ error: { message: "boom" } }, 500) : claudeReply(formatAsked(body))));
    const drafts = await gen.draft({ spec: spec({ formats: ["pick_one", "order"] }), count: 2, avoid: [] });
    expect(drafts.map((d) => d.format)).toEqual(["pick_one"]);
  });

  it("stops calling once the circuit is open", async () => {
    let calls = 0;
    const { gen } = generator(() => { calls++; return json({ error: { message: "down" } }, 503); }, callDeps({ retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 } }));
    for (let i = 0; i < 3; i++) await gen.draft({ spec: spec(), count: 1, avoid: [] }).catch(() => {});
    await expect(gen.draft({ spec: spec(), count: 1, avoid: [] })).rejects.toMatchObject({ kind: "circuit_open" });
    expect(calls).toBe(3);
  });
});

// ---------------------------------------------------------------- Gemini verifier

const geminiReply = (out: unknown, extra: Record<string, unknown> = {}) => json({
  candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] }, finishReason: "STOP", ...extra }],
  usageMetadata: { promptTokenCount: 400, candidatesTokenCount: 60 },
});
const grounded = { groundingMetadata: { webSearchQueries: ["2013 afcon coach nigeria"], groundingChunks: [{ web: { uri: "https://cafonline.test/2013", title: "cafonline.test" } }, { web: { uri: "https://bbc.test/keshi", title: "bbc.test" } }] } };
const question = { format: "pick_one" as const, payload: { question: "Who coached Nigeria to the 2013 AFCON title?", options: ["Stephen Keshi", "Gernot Rohr", "Sunday Oliseh", "Clemens Westerhof"], correctIndex: 0 }, claim: "Stephen Keshi coached Nigeria to the 2013 AFCON title." };
const verifier = (h: Handler, deps = callDeps()) => ({ deps, v: geminiVerifier({ client: geminiClient({ apiKey: "g", fetch: fetchOf(h) }), call: deps, model: async () => "gemini-3.8-flash" }) });

describe("Gemini verifier", () => {
  it("checks open-knowledge questions with Google Search and keeps the sources", async () => {
    let body: Record<string, unknown> = {};
    const { v, deps } = verifier((_u, b) => { body = b; return geminiReply({ verdict: "correct", foundAnswer: "Stephen Keshi", note: "CAF records" }, grounded); });
    const out = await v.verify(question);
    expect(body.tools).toEqual([{ googleSearch: {} }]);
    expect(JSON.stringify(body.contents)).toContain("Stated correct answer: Stephen Keshi");
    expect(out).toMatchObject({ verdict: "correct", foundAnswer: "Stephen Keshi", sources: ["https://cafonline.test/2013", "https://bbc.test/keshi"], verifiedBy: { provider: "gemini", model: "gemini-3.8-flash" } });
    expect(out.citations![0]).toEqual({ url: "https://cafonline.test/2013", title: "cafonline.test" });
    // $14 per 1,000 searches dominates: 400×0.75 + 60×3.75 per M = $0.000525, plus $0.014
    expect(deps.sink.records[0]).toMatchObject({ step: "verify", searchQueries: 1, costMicros: 14_525 });
  });

  it("a 'correct' with no sources behind it is unverifiable", async () => {
    const { v } = verifier(() => geminiReply({ verdict: "correct", foundAnswer: "Keshi", note: "I recall" }));
    expect((await v.verify(question)).verdict).toBe("unverifiable");
  });

  it("checks a file-scoped question against its chunk, with no search", async () => {
    let body: Record<string, unknown> = {};
    const { v } = verifier((_u, b) => { body = b; return geminiReply({ verdict: "correct", foundAnswer: "1990", note: "stated in the excerpt" }); });
    const out = await v.verify({ ...question, sourceText: "The bridge opened in 1990.", sourceChunkId: "c9" });
    expect(body.tools).toBeUndefined();
    expect(JSON.stringify(body.contents)).toContain("The bridge opened in 1990.");
    expect(out.sources).toEqual(["chunk:c9"]);
  });

  it("an unknown verdict is malformed, and a timeout or rate limit is unavailable", async () => {
    await expect(verifier(() => geminiReply({ verdict: "probably", foundAnswer: "", note: "" })).v.verify(question)).rejects.toMatchObject({ kind: "malformed" });
    await expect(verifier(hang).v.verify(question)).rejects.toMatchObject({ kind: "timeout" });
    await expect(verifier(() => json({ error: { code: 429, message: "quota" } }, 429)).v.verify(question)).rejects.toMatchObject({ kind: "rate_limited" });
  });

  it("stops calling once the circuit is open", async () => {
    let calls = 0;
    const { v } = verifier(() => { calls++; return json({ error: { message: "down" } }, 500); }, callDeps({ retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 } }));
    for (let i = 0; i < 3; i++) await v.verify(question).catch(() => {});
    await expect(v.verify(question)).rejects.toMatchObject({ kind: "circuit_open" });
    expect(calls).toBe(3);
  });
});

describe("verification cache", () => {
  const memory = () => {
    const m = new Map<string, VerifyVerdict>();
    return { m, cache: { get: async (k: string) => m.get(k) ?? null, put: async (k: string, _model: string, v: VerifyVerdict) => void m.set(k, v) } };
  };

  it("pays once per question and model, and never caches 'unverifiable'", async () => {
    let calls = 0;
    const inner = { name: "gemini", verify: async () => { calls++; return { verdict: "correct" as const, sources: ["u"], verifiedBy: { provider: "gemini", model: "m" } }; } };
    const { cache } = memory();
    const v = cachedVerifier(inner, async () => "m", cache);
    await v.verify(question);
    const again = await v.verify(question);
    expect(calls).toBe(1);
    expect(again.verifiedBy?.cached).toBe(true);
    expect(verificationKey("gemini", "m", question)).not.toBe(verificationKey("gemini", "other-model", question));

    let unsure = 0;
    const u = cachedVerifier({ name: "gemini", verify: async () => { unsure++; return { verdict: "unverifiable" as const, sources: [] }; } }, async () => "m", memory().cache);
    await u.verify(question);
    await u.verify(question);
    expect(unsure).toBe(2);
  });

  it("the key ignores object key order", () => {
    const a = verificationKey("g", "m", { ...question, payload: { question: "q", options: ["a", "b"], correctIndex: 0 } });
    const b = verificationKey("g", "m", { ...question, payload: { correctIndex: 0, options: ["a", "b"], question: "q" } });
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------- Gemini safety

const safety = (h: Handler, deps = callDeps()) => geminiSafety({ client: geminiClient({ apiKey: "g", fetch: fetchOf(h) }), call: deps, model: async () => "gemini-3.5-flash-lite" });
const items = [{ format: "pick_one" as const, payload: question.payload }, { format: "pick_one" as const, payload: { ...question.payload, question: "Which betting app pays fastest?" } }];

describe("Gemini safety", () => {
  it("passes the safe item, fails the unsafe one with its reason", async () => {
    const out = await safety(() => geminiReply({ results: [{ index: 0, safe: true, reasons: [] }, { index: 1, safe: false, reasons: ["gambling_promo"] }] })).review(spec(), items);
    expect(out).toEqual([{ passed: true, reasons: [] }, { passed: false, reasons: ["model:gambling_promo"] }]);
  });

  it("fails closed on an item the reply leaves out", async () => {
    const out = await safety(() => geminiReply({ results: [{ index: 0, safe: true, reasons: [] }] })).review(spec(), items);
    expect(out[1]).toEqual({ passed: false, reasons: ["no_verdict"] });
  });

  it("malformed output, a timeout and a rate limit are unavailable", async () => {
    await expect(safety(() => json({ candidates: [{ content: { parts: [{ text: "ok!" }] }, finishReason: "STOP" }] })).review(spec(), items)).rejects.toMatchObject({ kind: "malformed" });
    await expect(safety(hang).review(spec(), items)).rejects.toMatchObject({ kind: "timeout" });
    await expect(safety(() => json({ error: { message: "quota" } }, 429)).review(spec(), items)).rejects.toMatchObject({ kind: "rate_limited" });
  });

  it("stops calling once the circuit is open", async () => {
    let calls = 0;
    const s = safety(() => { calls++; return json({ error: { message: "down" } }, 500); }, callDeps({ retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 } }));
    for (let i = 0; i < 3; i++) await s.review(spec(), items).catch(() => {});
    await expect(s.review(spec(), items)).rejects.toMatchObject({ kind: "circuit_open" });
    expect(calls).toBe(3);
  });
});

// ---------------------------------------------------------------- Gemini embedder

const vector = (seed: number) => Array.from({ length: EMBEDDING_DIM }, (_, i) => ((i * seed) % 7) - 3);
const embedder = (h: Handler, deps = callDeps()) => geminiEmbedder({ client: geminiClient({ apiKey: "g", fetch: fetchOf(h) }), call: deps, model: "gemini-embedding-2" });

describe("Gemini embedder", () => {
  it("returns unit vectors of the column's width, in batches, with the task prefix", async () => {
    const asked: string[] = [];
    const deps = callDeps();
    const e = embedder((_u, body) => {
      asked.push(String((body.content as { parts: { text: string }[] }).parts[0].text));
      expect(body.outputDimensionality).toBe(EMBEDDING_DIM);
      return json({ embedding: { values: vector(asked.length) }, usageMetadata: { promptTokenCount: 5 } });
    }, deps);
    const out = await e.embed(Array.from({ length: 20 }, (_, i) => `text ${i}`));
    expect(out).toHaveLength(20);
    for (const v of out) expect(Math.abs(v.reduce((a, x) => a + x * x, 0) - 1)).toBeLessThan(1e-9);
    expect(asked[0]).toBe("task: clustering | query: text 0");
    expect(deps.sink.records.map((r) => r.step)).toEqual(["embed", "embed"]); // 16 + 4
    expect(e.model).toBe("gemini-embedding-2");
  });

  it("the wrong width is malformed; a timeout, a rate limit and an open circuit are unavailable", async () => {
    await expect(embedder(() => json({ embedding: { values: [1, 2, 3] } })).embed(["a"])).rejects.toMatchObject({ kind: "malformed" });
    await expect(embedder(hang).embed(["a"])).rejects.toMatchObject({ kind: "timeout" });
    await expect(embedder(() => json({ error: { message: "quota" } }, 429)).embed(["a"])).rejects.toMatchObject({ kind: "rate_limited" });
    let calls = 0;
    const e = embedder(() => { calls++; return json({ error: { message: "down" } }, 500); }, callDeps({ retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 } }));
    for (let i = 0; i < 3; i++) await e.embed(["a"]).catch(() => {});
    await expect(e.embed(["a"])).rejects.toMatchObject({ kind: "circuit_open" });
    expect(calls).toBe(3);
  });
});

describe("provider selection", () => {
  it("mocks by default; real providers need their keys; unknown names are refused", async () => {
    const { selectProviders } = await import("../src/providers/index.js");
    const saved = { ...process.env };
    try {
      for (const k of ["QUESTIONS_GENERATOR", "QUESTIONS_VERIFIER", "QUESTIONS_EMBEDDER", "QUESTIONS_SAFETY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"]) delete process.env[k];
      const p = selectProviders();
      expect([p.verifier.name, p.embedder.model, p.safety.name]).toEqual(["mock", "mock", "mock"]);
      process.env.QUESTIONS_GENERATOR = "anthropic";
      expect(() => selectProviders()).toThrow(/ANTHROPIC_API_KEY/);
      process.env.QUESTIONS_GENERATOR = "gpt";
      expect(() => selectProviders()).toThrow(/not a registered provider/);
      process.env.QUESTIONS_GENERATOR = "mock";
      process.env.QUESTIONS_EMBEDDER = "gemini";
      process.env.GEMINI_API_KEY = "g";
      process.env.GEMINI_EMBED_MODEL = "text-embedding-3-small";
      expect(() => selectProviders()).toThrow(/no price/);
    } finally {
      process.env = saved;
    }
  });
});

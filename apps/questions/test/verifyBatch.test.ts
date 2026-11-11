/**
 * Verification in batches (ADR 0016, 11 Nov 2026), against mocked HTTP: one call per batch of up to the admin's
 * size, the order shuffled, verdicts matched back by id; a missing, repeated, malformed or unsourced verdict fails
 * only its own question, closed; a reply that can't be used at all fails only its batch; the cache keeps a
 * question verified once from being sent again.
 */
import { describe, expect, it } from "vitest";
import { Breakers, claudeClient, MemorySink, noBudget, type CallDeps } from "@contestly/ai";
import { claudeVerifier } from "../src/providers/anthropic/verifier.js";
import { batchedVerifier } from "../src/providers/batchedVerifier.js";
import { cachedVerifier } from "../src/providers/cachedVerifier.js";
import { matchVerdicts, shuffledBatch } from "../src/providers/checks/verifyBatch.js";
import type { VerifyInput, VerifyVerdict } from "../src/providers/types.js";

const callDeps = (): CallDeps & { sink: MemorySink } => ({
  sink: new MemorySink(), budget: noBudget, breakers: new Breakers({ failureThreshold: 50, cooldownMs: 60_000 }),
  retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 }, timeoutMs: 500, sleep: async () => {}, log: () => {}, paidCapMicros: Number.POSITIVE_INFINITY,
}) as CallDeps & { sink: MemorySink };

/** Question n: "Which year is n?", answer "190n" (each claim distinct, so the shuffle and the cache key differ). */
const q = (n: number): VerifyInput => ({
  format: "pick_one", payload: { question: `Which year is number ${n}?`, options: [`${1900 + n}`, "a", "b", "c"], correctIndex: 0 }, claim: `Number ${n} is the year ${1900 + n}.`,
});
const SOURCE = "https://records.test/years";

/** The ids and claims in a batch's prompt, in the order sent. */
function asked(body: Record<string, unknown>): { id: string; claim: string }[] {
  const user = String((body.messages as { content: string }[])[0].content);
  return [...user.matchAll(/<question id="(q\d+)">[\s\S]*?Claim it rests on: (.*)\n/g)].map((m) => ({ id: m[1], claim: m[2] }));
}

/** Claude, searching once and answering each id; `shape` changes the verdict list before it's sent. */
function claude(shape: (vs: Record<string, unknown>[]) => unknown = (vs) => ({ verdicts: vs }), seen: { id: string; claim: string }[][] = []) {
  const deps = callDeps();
  const fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const items = asked(body);
    seen.push(items);
    // Each verdict's foundAnswer is its question's claim, so a mismatch by id would show.
    const vs = items.map(({ id, claim }) => ({ id, verdict: "correct", foundAnswer: claim, note: "", sourceUrls: [SOURCE] }));
    const content = [
      { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "years" } },
      { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: SOURCE, title: "Records", encrypted_content: "x" }] },
      { type: "text", text: typeof shape === "function" ? JSON.stringify(shape(vs)) : "" },
    ];
    return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 3000, output_tokens: 600, server_tool_use: { web_search_requests: 1 } } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  const v = claudeVerifier({ client: claudeClient({ apiKey: "t", fetch }), call: deps, model: async () => "claude-opus-5-5" });
  return { v, deps, seen };
}

describe("a verification batch", () => {
  it("a 15-question set goes in two calls (10 and 5), each shuffled, every verdict matched back to its own question", async () => {
    const seen: { id: string; claim: string }[][] = [];
    const { v, deps } = claude(undefined, seen);
    const qs = Array.from({ length: 15 }, (_, i) => q(i + 1));
    const out = await batchedVerifier(v, async () => 10).verifyBatch(qs);
    expect(deps.sink.records).toHaveLength(2);
    expect(seen.map((b) => b.length).sort((a, b) => b - a)).toEqual([10, 5]);
    // Shuffled: the first batch isn't in the order given.
    const first = seen.find((b) => b.length === 10)!;
    expect(first.map((b) => b.claim)).not.toEqual(qs.slice(0, 10).map((x) => x.claim));
    expect(out.map((o) => o.foundAnswer)).toEqual(qs.map((x) => x.claim));
    expect(out.every((o) => o.verdict === "correct" && o.sources[0] === SOURCE)).toBe(true);
    // Searches allowed per question in the batch.
    expect(deps.sink.records.every((r) => r.outcome === "ok")).toBe(true);
  });

  it("a missing verdict fails only that question, closed", async () => {
    const { v } = claude((vs) => ({ verdicts: vs.filter((x) => x.id !== "q2") }));
    const qs = [q(1), q(2), q(3)];
    const out = await v.verifyBatch(qs);
    const missing = shuffledBatch(qs).find((i) => i.id === "q2")!.index;
    expect(out[missing]).toMatchObject({ verdict: "unverifiable", note: expect.stringMatching(/no verdict for this question/) });
    expect(out.filter((o) => o.verdict === "correct")).toHaveLength(2);
  });

  it("an unsourced verdict (a correct citing nothing it was shown) fails only that question, closed", async () => {
    const { v } = claude((vs) => ({ verdicts: vs.map((x) => (x.id === "q1" ? { ...x, sourceUrls: ["https://remembered.test/"] } : x)) }));
    const qs = [q(1), q(2)];
    const out = await v.verifyBatch(qs);
    const unsourced = shuffledBatch(qs).find((i) => i.id === "q1")!.index;
    expect(out[unsourced]).toMatchObject({ verdict: "unverifiable", sources: [], note: expect.stringMatching(/no sources/) });
    expect(out[1 - unsourced]).toMatchObject({ verdict: "correct" });
  });

  it("a malformed response: a bad verdict fails its question; no verdict list fails the batch; an unusable reply fails only its batch", async () => {
    const bad = claude((vs) => ({ verdicts: vs.map((x) => (x.id === "q1" ? { ...x, verdict: "probably" } : x)) }));
    const out = await bad.v.verifyBatch([q(1), q(2)]);
    expect(out.filter((o) => o.verdict === "unverifiable")).toHaveLength(1);
    expect(out.find((o) => o.verdict === "unverifiable")!.note).toMatch(/malformed/);

    const noList = claude(() => ({ answers: "all fine" }));
    expect((await noList.v.verifyBatch([q(1), q(2)])).every((o) => o.verdict === "unverifiable" && /no verdict list/.test(o.note!))).toBe(true);

    // Not JSON at all: the call path says malformed; the batch layer fails that batch closed and goes on.
    let n = 0;
    const flaky = { name: "x", verifyBatch: async (qs: VerifyInput[]): Promise<VerifyVerdict[]> => {
      if (n++ === 0) return claude(() => "not json").v.verifyBatch(qs);
      return qs.map(() => ({ verdict: "correct", sources: [SOURCE] }));
    } };
    const mixed = await batchedVerifier(flaky, async () => 2).verifyBatch([q(1), q(2), q(3)]);
    expect(mixed.map((o) => o.verdict)).toEqual(["unverifiable", "unverifiable", "correct"]);
  });

  it("a repeated id fails that question; an id that isn't in the batch is ignored", () => {
    const items = shuffledBatch([q(1), q(2)]);
    const reply = { verdicts: [{ id: "q1", verdict: "correct" }, { id: "q1", verdict: "incorrect" }, { id: "q2", verdict: "incorrect" }, { id: "q9", verdict: "correct" }] };
    const out = matchVerdicts(items, reply, (v) => ({ verdict: v.verdict, sources: ["s"] }), undefined);
    const at = (id: string) => out[items.find((i) => i.id === id)!.index];
    expect(at("q1")).toMatchObject({ verdict: "unverifiable", note: expect.stringMatching(/more than one verdict/) });
    expect(at("q2")).toMatchObject({ verdict: "incorrect" });
  });

  it("the cache sends only the questions it hasn't verified; a repeat of the set makes no call", async () => {
    const m = new Map<string, VerifyVerdict>();
    const cache = { get: async (k: string) => m.get(k) ?? null, put: async (k: string, _m: string, v: VerifyVerdict) => void m.set(k, v) };
    const { v, deps, seen } = claude();
    const stack = cachedVerifier(batchedVerifier(v, async () => 10), async () => "claude-opus-5-5", cache);
    await stack.verifyBatch([q(1), q(2)]);
    await stack.verifyBatch([q(1), q(2), q(3)]);
    await stack.verifyBatch([q(3), q(2)]);
    expect(seen.map((b) => b.length)).toEqual([2, 1]);
    expect(deps.sink.records).toHaveLength(2);
  });
});

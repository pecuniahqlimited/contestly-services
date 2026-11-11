/**
 * When a provider can't answer (ADR 0016): generation stops without failing the job (the fill goes bank-only),
 * and a check that can't run fails its drafts closed. File-scoped specs, so nothing here touches the bank.
 */
import { describe, expect, it } from "vitest";
import { ProviderUnavailable } from "@contestly/ai";
import { draftAndJudge } from "../src/pipeline/judge.js";
import { buildSpec } from "../src/pipeline/spec.js";
import { mockEmbedder } from "../src/providers/mock/embedder.js";
import { mockGenerator } from "../src/providers/mock/generator.js";
import { mockSafety } from "../src/providers/mock/safety.js";
import { mockVerifier } from "../src/providers/mock/verifier.js";
import type { Providers } from "../src/providers/types.js";

const SOURCES = [
  "The Third Mainland Bridge crosses the lagoon and was opened in 1990. Carter Bridge first linked Lagos Island to the mainland in 1901.",
  "Eko Bridge was completed in 1975 to ease traffic on older crossings. The Lekki toll bridge opened in 2013 and connects Lekki with Ikoyi.",
].map((text, i) => ({ id: `chunk-${i}`, text }));
const spec = buildSpec({ brief: "lagos bridges", difficulty: "mixed", formats: ["pick_one"], questionCount: 3, questionSeconds: 10, fileIds: ["f"] });
const down = (step: string) => async () => { throw new ProviderUnavailable("server", "test", step, "down"); };
const run = (over: Partial<Providers>) => draftAndJudge({
  spec, providers: { generator: mockGenerator, verifier: mockVerifier, embedder: mockEmbedder, safety: mockSafety, ...over }, dedupeSimilarity: 0.92, want: 2, avoid: [], sources: SOURCES,
});

describe("provider fallback", () => {
  it("all providers up: drafts are accepted", async () => {
    const r = await run({});
    expect(r.accepted.length).toBeGreaterThan(0);
    expect(r.unavailable).toEqual([]);
  });

  it("generator down: no drafts, no throw, generation recorded as unavailable", async () => {
    const r = await run({ generator: { draft: down("generate") } });
    expect(r).toEqual({ judged: [], accepted: [], unavailable: ["generate"] });
  });

  it("verifier down: every draft is unverifiable and rejected, and drafting stops", async () => {
    let calls = 0;
    const r = await run({ verifier: { name: "x", verifyBatch: async () => { calls++; return down("verify")(); } } });
    expect(r.accepted).toEqual([]);
    expect(r.unavailable).toEqual(["verify"]);
    expect(r.judged.every((j) => j.outcome === "rejected_verify" && j.verify?.verdict === "unverifiable")).toBe(true);
    expect(calls).toBe(1); // the round's one batch; nothing after it went down
  });

  it("safety review down: drafts fail closed with the reason", async () => {
    const r = await run({ safety: { name: "x", review: down("safety") } });
    expect(r.accepted).toEqual([]);
    expect(r.unavailable).toEqual(["safety"]);
    expect(r.judged.filter((j) => j.verify?.verdict === "correct").every((j) => j.outcome === "rejected_safety" && j.safety.reasons.includes("safety_unavailable"))).toBe(true);
  });

  it("the model safety check only sees drafts that passed everything before it", async () => {
    let seen = 0;
    const r = await run({ safety: { name: "x", review: async (_b, items) => { seen += items.length; return items.map(() => ({ passed: false, reasons: ["model:hate"] })); } } });
    expect(seen).toBe(r.judged.filter((j) => j.verify?.verdict === "correct").length);
    expect(r.accepted).toEqual([]);
  });
});

/**
 * The Gemini verifier (ADR 0016): one call per batch of questions, never the generator's call or model. Two modes.
 * Grounded (paid: Google Search) for when billing is on: each verdict keeps the sources Google grounded that part
 * of the reply on, and a "correct" with none fails closed. Unsourced (the free profile: grounding has no free
 * quota): verdicts come from the model's own knowledge, with no sources, marked "checked without sources"; only
 * the free profile's gate lets such a verdict through. File-scoped questions are checked against their cited chunk
 * in both modes, with no search.
 */
import { geminiGenerate, providerCall, type CallDeps, type GeminiAnswer, type GeminiClient, type GroundingSource } from "@contestly/ai";
import type { CallTier, PricedModel } from "@contestly/shared";
import type { Verifier, VerifyVerdict } from "../types.js";
import { chunkCitation, requireSources, VERIFY_FIELDS, VERIFY_SYSTEM, verifyPrompt } from "../checks/verifyPrompt.js";
import { matchVerdicts, shuffledBatch, verdictsSchema, type BatchItem } from "../checks/verifyBatch.js";

export interface GeminiVerifierDeps {
  client: GeminiClient;
  call: CallDeps;
  model: () => Promise<PricedModel>;
  /** grounded: Google Search (a paid feature). unsourced: model knowledge only (the free profile). */
  mode: "grounded" | "unsourced";
  tier: CallTier;
}

const GROUNDED = "Check each question against reliable sources found with Google Search. Base each verdict on what the sources say, not on memory.";
const UNSOURCED = "You have no search. Check each question from what you know. Be stricter than you would be with sources: if you aren't sure the stated answer is right and the only defensible one, the verdict is unverifiable, not correct.";
const SCHEMA = verdictsSchema(VERIFY_FIELDS, ["id", "verdict", "foundAnswer", "note"]);
export const UNSOURCED_NOTE = "checked without sources";

export function geminiVerifier(deps: GeminiVerifierDeps): Verifier {
  return {
    // Distinct names keep the cache from serving an unsourced verdict to a grounded verifier.
    name: deps.mode === "grounded" ? "gemini" : "gemini-unsourced",
    async verifyBatch(qs) {
      if (!qs.length) return [];
      const model = await deps.model();
      const items = shuffledBatch(qs);
      const search = deps.mode === "grounded" && items.some((i) => i.q.sourceText === undefined);
      const answer = await providerCall({ provider: "gemini", model, step: "verify", tier: deps.tier }, deps.call, (signal) =>
        geminiGenerate(deps.client, { model, system: VERIFY_SYSTEM, parts: [{ text: verifyPrompt(items, deps.mode === "grounded" ? GROUNDED : UNSOURCED) }], schema: SCHEMA, search }, signal));
      const verifiedBy = { provider: "gemini", model };
      const spans = search ? verdictSpans(answer, items) : new Map<string, GroundingSource[]>();
      return matchVerdicts(items, answer.json, (v, { id, q }) => {
        const base = { verdict: v.verdict, foundAnswer: v.foundAnswer, verifiedBy };
        if (q.sourceText !== undefined) return requireSources({ ...base, note: v.note, sources: [chunkCitation(q).url], citations: [chunkCitation(q)] });
        if (deps.mode === "unsourced") {
          const out: VerifyVerdict = { ...base, note: [UNSOURCED_NOTE, v.note].filter(Boolean).join(": "), sources: [], citations: [], unsourced: true };
          return out;
        }
        const citations = spans.get(id) ?? [];
        return requireSources({ ...base, note: v.note, sources: citations.map((c) => c.url), citations });
      }, verifiedBy);

    },
  };
}

/** Each verdict's stretch of the reply (from its id to the next one's) and the grounded sources inside it. */
export function verdictSpans(answer: Pick<GeminiAnswer, "text" | "supports">, batch: BatchItem[]): Map<string, GroundingSource[]> {
  const starts = batch.map((i) => ({ id: i.id, at: answer.text.search(new RegExp(`"id"\\s*:\\s*"${i.id}"`)) })).filter((s) => s.at >= 0).sort((a, b) => a.at - b.at);
  const out = new Map<string, GroundingSource[]>();
  for (const [k, s] of starts.entries()) {
    const end = starts[k + 1]?.at ?? answer.text.length;
    const found = new Map<string, GroundingSource>();
    for (const sup of answer.supports) if (sup.start < end && sup.end > s.at) for (const src of sup.sources) found.set(src.url, src);
    out.set(s.id, [...found.values()]);
  }
  return out;
}

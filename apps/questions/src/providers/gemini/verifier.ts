/**
 * The Gemini verifier (ADR 0016): one call per question, never the generator's call or model. Two modes.
 * Grounded (paid: Google Search, keeping the sources it found) for when billing is on. Unsourced (the free
 * profile: grounding has no free quota): the verdict comes from the model's own knowledge, with no sources,
 * and is marked "checked without sources"; only the free profile's gate lets such a verdict through.
 * File-scoped questions are checked against their cited chunk in both modes, with no search.
 */
import { geminiGenerate, providerCall, ProviderError, type CallDeps, type GeminiClient } from "@contestly/ai";
import { VERIFY_VERDICTS, type CallTier, type PricedModel, type VerifyVerdictKind } from "@contestly/shared";
import type { Verifier, VerifyVerdict } from "../types.js";
import { chunkCitation, isVerdict, requireSources, VERIFY_FIELDS, VERIFY_SYSTEM, verifyPrompt } from "../checks/verifyPrompt.js";

export interface GeminiVerifierDeps {
  client: GeminiClient;
  call: CallDeps;
  model: () => Promise<PricedModel>;
  /** grounded: Google Search (a paid feature). unsourced: model knowledge only (the free profile). */
  mode: "grounded" | "unsourced";
  tier: CallTier;
}

const GROUNDED = "Check this question against reliable sources found with Google Search. Base the verdict on what the sources say, not on memory.";
const UNSOURCED = "You have no search. Check this question from what you know. Be stricter than you would be with sources: if you aren't sure the stated answer is right and the only defensible one, the verdict is unverifiable, not correct.";
const SCHEMA = { type: "object", properties: VERIFY_FIELDS, required: ["verdict", "foundAnswer", "note"] };
export const UNSOURCED_NOTE = "checked without sources";

export function geminiVerifier(deps: GeminiVerifierDeps): Verifier {
  return {
    // Distinct names keep the cache from serving an unsourced verdict to a grounded verifier.
    name: deps.mode === "grounded" ? "gemini" : "gemini-unsourced",
    async verify(q) {
      const model = await deps.model();
      const fileScoped = q.sourceText !== undefined;
      const search = deps.mode === "grounded" && !fileScoped;
      const answer = await providerCall({ provider: "gemini", model, step: "verify", tier: deps.tier }, deps.call, async (signal) => {
        const res = await geminiGenerate(deps.client, { model, system: VERIFY_SYSTEM, parts: [{ text: verifyPrompt(q, deps.mode === "grounded" ? GROUNDED : UNSOURCED) }], schema: SCHEMA, search }, signal);
        const verdict = (res.value.json as { verdict?: string })?.verdict;
        if (!isVerdict(verdict)) throw new ProviderError("malformed", `verdict "${verdict}" is not one of ${VERIFY_VERDICTS.join(", ")}`);
        return res;
      });
      const out = answer.json as { verdict: VerifyVerdictKind; foundAnswer?: string; note?: string };
      const verifiedBy = { provider: "gemini", model };
      const base = { verdict: out.verdict, foundAnswer: out.foundAnswer || undefined, verifiedBy };
      if (fileScoped) return requireSources({ ...base, note: out.note || undefined, sources: [chunkCitation(q).url], citations: [chunkCitation(q)] });
      if (deps.mode === "unsourced") {
        const v: VerifyVerdict = { ...base, note: [UNSOURCED_NOTE, out.note].filter(Boolean).join(": "), sources: [], citations: [], unsourced: true };
        return v;
      }
      return requireSources({ ...base, note: out.note || undefined, sources: answer.sources.map((c) => c.url), citations: answer.sources });
    },
  };
}

/**
 * The Gemini verifier (ADR 0016; an option for when billing is on, Claude is the default): one call per
 * question, never the generator. Open-knowledge questions are checked with Google Search grounding and keep
 * the sources it found; file-scoped ones against their cited chunk only, with no search.
 */
import { geminiGenerate, providerCall, ProviderError, type CallDeps, type GeminiClient } from "@contestly/ai";
import { VERIFY_VERDICTS, type PricedModel, type VerifyVerdictKind } from "@contestly/shared";
import type { Verifier } from "../types.js";
import { chunkCitation, isVerdict, requireSources, VERIFY_FIELDS, VERIFY_SYSTEM, verifyPrompt } from "../checks/verifyPrompt.js";

export interface GeminiVerifierDeps {
  client: GeminiClient;
  call: CallDeps;
  model: () => Promise<PricedModel>;
}

const OPEN = "Check this question against reliable sources found with Google Search. Base the verdict on what the sources say, not on memory.";
const SCHEMA = { type: "object", properties: VERIFY_FIELDS, required: ["verdict", "foundAnswer", "note"] };

export function geminiVerifier(deps: GeminiVerifierDeps): Verifier {
  return {
    name: "gemini",
    async verify(q) {
      const model = await deps.model();
      const fileScoped = q.sourceText !== undefined;
      const answer = await providerCall({ provider: "gemini", model, step: "verify" }, deps.call, async (signal) => {
        const res = await geminiGenerate(deps.client, { model, system: VERIFY_SYSTEM, parts: [{ text: verifyPrompt(q, OPEN) }], schema: SCHEMA, search: !fileScoped }, signal);
        const verdict = (res.value.json as { verdict?: string })?.verdict;
        if (!isVerdict(verdict)) throw new ProviderError("malformed", `verdict "${verdict}" is not one of ${VERIFY_VERDICTS.join(", ")}`);
        return res;
      });
      const out = answer.json as { verdict: VerifyVerdictKind; foundAnswer?: string; note?: string };
      const citations = fileScoped ? [chunkCitation(q)] : answer.sources;
      return requireSources({
        verdict: out.verdict,
        foundAnswer: out.foundAnswer || undefined,
        note: out.note || undefined,
        sources: citations.map((c) => c.url),
        citations,
        verifiedBy: { provider: "gemini", model },
      });
    },
  };
}

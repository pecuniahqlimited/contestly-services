/**
 * The Gemini verifier (ADR 0016): one call per question, never the generator. Open-knowledge questions are
 * checked with Google Search grounding and keep the sources it found; file-scoped ones against their cited
 * chunk only, with no search. The verdict is the model's, with one rule on top: "correct" with no source
 * behind it is unverifiable.
 */
import { geminiGenerate, providerCall, ProviderError, type CallDeps, type GeminiClient } from "@contestly/ai";
import { VERIFY_VERDICTS, type PricedModel, type VerifyVerdictKind } from "@contestly/shared";
import type { Verifier, VerifyInput, VerifyVerdict } from "../types.js";
import { answerKeyText } from "../../pipeline/text.js";

export interface GeminiVerifierDeps {
  client: GeminiClient;
  call: CallDeps;
  model: () => Promise<PricedModel>;
}

const SYSTEM = `You are the independent fact-checker for a live trivia game played in Nigeria. You are given one quiz question with its stated answer key. Decide whether it is safe to play.

Verdicts:
- correct: the stated answer is right, it is the only defensible answer among the options, the question has one clear reading, and the fact won't change over time.
- incorrect: the stated answer is wrong, or a different option is the right one.
- ambiguous: more than one option can be argued for, the question can be read more than one way, or the answer depends on when it's asked (current office holders, prices, records, ages).
- unverifiable: you can't find reliable evidence either way.

Be strict: when in doubt, it is not "correct". For pick-all, every option must be clearly in or out. For order and match, every position or pair must be right. foundAnswer is the answer the evidence supports, in a few words. note is one sentence on why.`;

const OPEN = "Check this question against reliable sources found with Google Search. Base the verdict on what the sources say, not on memory.";
const FILE = "Check this question ONLY against the source excerpt below. It is correct only if the excerpt itself supports the stated answer; outside knowledge doesn't count, and an answer the excerpt doesn't support is unverifiable.";

const SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: [...VERIFY_VERDICTS] },
    foundAnswer: { type: "string" },
    note: { type: "string" },
  },
  required: ["verdict", "foundAnswer", "note"],
};

export function geminiVerifier(deps: GeminiVerifierDeps): Verifier {
  return {
    name: "gemini",
    async verify(q) {
      const model = await deps.model();
      const fileScoped = q.sourceText !== undefined;
      const answer = await providerCall({ provider: "gemini", model, step: "verify" }, deps.call, async (signal) => {
        const res = await geminiGenerate(deps.client, { model, system: SYSTEM, parts: [{ text: prompt(q) }], schema: SCHEMA, search: !fileScoped }, signal);
        const verdict = (res.value.json as { verdict?: string })?.verdict;
        if (!VERIFY_VERDICTS.includes(verdict as VerifyVerdictKind)) throw new ProviderError("malformed", `verdict "${verdict}" is not one of ${VERIFY_VERDICTS.join(", ")}`);
        return res;
      });
      const out = answer.json as { verdict: VerifyVerdictKind; foundAnswer?: string; note?: string };
      const verifiedBy = { provider: "gemini", model };
      const citations = fileScoped ? [{ url: `chunk:${q.sourceChunkId ?? "cited"}`, title: "The cited excerpt of the host's file" }] : answer.sources;
      const v: VerifyVerdict = {
        verdict: out.verdict,
        foundAnswer: out.foundAnswer || undefined,
        note: out.note || undefined,
        sources: citations.map((c) => c.url),
        citations,
        verifiedBy,
      };
      if (v.verdict === "correct" && !v.sources.length) return { ...v, verdict: "unverifiable", note: `no sources behind the check${v.note ? `: ${v.note}` : ""}` };
      return v;
    },
  };
}

function prompt(q: VerifyInput): string {
  const parts = [q.sourceText !== undefined ? FILE : OPEN, "", answerKeyText(q.format, q.payload), `Claim it rests on: ${q.claim}`];
  if (q.explanation) parts.push(`Explanation shown to players: ${q.explanation}`);
  if (q.sourceText !== undefined) parts.push("", `<excerpt>\n${q.sourceText}\n</excerpt>`);
  return parts.join("\n");
}

/**
 * The Claude verifier (ADR 0016; the default for dev and testing): one call per question, on a different model
 * from the generator and with nothing from the generation call but the question itself. Open-knowledge
 * questions are checked with Anthropic's web search tool; file-scoped ones against their cited chunk only,
 * with no search. Sources are the search results Claude says support its verdict, kept only if Claude was
 * actually shown them, so a remembered or invented URL never counts.
 */
import { claudeJson, providerCall, ProviderError, type CallDeps, type ClaudeClient, type SearchResultSeen } from "@contestly/ai";
import { VERIFY_VERDICTS, type PricedModel, type VerifyVerdictKind } from "@contestly/shared";
import type { Verifier } from "../types.js";
import { chunkCitation, isVerdict, requireSources, VERIFY_FIELDS, VERIFY_OPEN, VERIFY_SYSTEM, verifyPrompt } from "../checks/verifyPrompt.js";

/** One fact rarely needs more; failed searches count too. */
export const VERIFY_MAX_SEARCHES = 3;
const MAX_TOKENS = 4_000;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { ...VERIFY_FIELDS, sourceUrls: { type: "array", items: { type: "string" } } },
  required: ["verdict", "foundAnswer", "note", "sourceUrls"],
};
const SOURCES_RULE = "sourceUrls: the URLs of the search results that support your verdict, copied exactly; empty if none do.";

export interface ClaudeVerifierDeps {
  client: ClaudeClient;
  call: CallDeps;
  model: () => Promise<PricedModel>;
}

export function claudeVerifier(deps: ClaudeVerifierDeps): Verifier {
  return {
    name: "anthropic",
    async verify(q) {
      const model = await deps.model();
      const fileScoped = q.sourceText !== undefined;
      const answer = await providerCall({ provider: "anthropic", model, step: "verify" }, deps.call, async (signal) => {
        const res = await claudeJson(deps.client, {
          model, system: `${VERIFY_SYSTEM}\n${SOURCES_RULE}`, user: verifyPrompt(q, VERIFY_OPEN), schema: SCHEMA, maxTokens: MAX_TOKENS, effort: "low",
          ...(fileScoped ? {} : { webSearch: { maxUses: VERIFY_MAX_SEARCHES } }),
        }, signal);
        const verdict = (res.value.json as { verdict?: string })?.verdict;
        if (!isVerdict(verdict)) throw new ProviderError("malformed", `verdict "${verdict}" is not one of ${VERIFY_VERDICTS.join(", ")}`);
        return res;
      });
      const out = answer.json as { verdict: VerifyVerdictKind; foundAnswer?: string; note?: string; sourceUrls?: string[] };
      const citations = fileScoped ? [chunkCitation(q)] : citedResults(out.sourceUrls ?? [], answer.results);
      return requireSources({
        verdict: out.verdict,
        foundAnswer: out.foundAnswer || undefined,
        note: out.note || undefined,
        sources: citations.map((c) => c.url),
        citations,
        verifiedBy: { provider: "anthropic", model },
      });
    },
  };
}

/** The URLs Claude named that were among the results it was shown, with their titles. */
export function citedResults(named: string[], seen: SearchResultSeen[]): SearchResultSeen[] {
  const byUrl = new Map(seen.map((r) => [r.url, r]));
  return [...new Set(named)].flatMap((u) => (byUrl.has(u) ? [byUrl.get(u)!] : []));
}

/**
 * The Claude verifier (ADR 0016; the default for dev and testing): one call per batch of questions, on a different
 * model from the generator and with nothing from the generation call but the questions themselves. Open-knowledge
 * questions are checked with Anthropic's web search tool; file-scoped ones against their cited chunk only, with no
 * search. Each verdict's sources are the search results Claude says support it, kept only if Claude was actually
 * shown them, so a remembered or invented URL never counts; a "correct" with none left fails closed.
 */
import { claudeJson, providerCall, type CallDeps, type ClaudeClient, type SearchResultSeen } from "@contestly/ai";
import type { PricedModel } from "@contestly/shared";
import type { Verifier } from "../types.js";
import { chunkCitation, requireSources, VERIFY_FIELDS, VERIFY_OPEN, VERIFY_SYSTEM, verifyPrompt } from "../checks/verifyPrompt.js";
import { matchVerdicts, shuffledBatch, verdictsSchema } from "../checks/verifyBatch.js";

/** Searches a question rarely needs more than (failed searches count too); a batch gets this many per question. */
export const VERIFY_SEARCHES_PER_QUESTION = 3;
/** Output per question (a verdict and a few URLs), on top of a fixed allowance for thinking. */
const TOKENS_PER_QUESTION = 400;
const BASE_TOKENS = 4_000;

const SCHEMA = verdictsSchema({ ...VERIFY_FIELDS, sourceUrls: { type: "array", items: { type: "string" } } }, ["id", "verdict", "foundAnswer", "note", "sourceUrls"]);
const SOURCES_RULE = "sourceUrls: for each verdict, the URLs of the search results that support it, copied exactly; empty if none do.";

export interface ClaudeVerifierDeps {
  client: ClaudeClient;
  call: CallDeps;
  model: () => Promise<PricedModel>;
}

export function claudeVerifier(deps: ClaudeVerifierDeps): Verifier {
  return {
    name: "anthropic",
    async verifyBatch(qs) {
      if (!qs.length) return [];
      const model = await deps.model();
      const items = shuffledBatch(qs);
      const open = items.filter((i) => i.q.sourceText === undefined).length;
      const answer = await providerCall({ provider: "anthropic", model, step: "verify" }, deps.call, (signal) => claudeJson(deps.client, {
        model, system: `${VERIFY_SYSTEM}\n${SOURCES_RULE}`, user: verifyPrompt(items, VERIFY_OPEN), schema: SCHEMA,
        maxTokens: BASE_TOKENS + TOKENS_PER_QUESTION * items.length, effort: "low",
        ...(open ? { webSearch: { maxUses: VERIFY_SEARCHES_PER_QUESTION * open } } : {}),
      }, signal));
      const verifiedBy = { provider: "anthropic", model };
      return matchVerdicts(items, answer.json, (v, { q }) => {
        const citations = q.sourceText !== undefined ? [chunkCitation(q)] : citedResults(v.sourceUrls ?? [], answer.results);
        return requireSources({ verdict: v.verdict, foundAnswer: v.foundAnswer, note: v.note, sources: citations.map((c) => c.url), citations, verifiedBy });
      }, verifiedBy);
    },
  };
}

/** The URLs Claude named that were among the results it was shown, with their titles. */
export function citedResults(named: string[], seen: SearchResultSeen[]): SearchResultSeen[] {
  const byUrl = new Map(seen.map((r) => [r.url, r]));
  return [...new Set(named)].flatMap((u) => (byUrl.has(u) ? [byUrl.get(u)!] : []));
}

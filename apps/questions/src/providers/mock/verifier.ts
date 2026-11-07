/**
 * Deterministic verifier: fails exactly the planted bad deck entries (by their fixed ids) and
 * passes everything else with two mock citations, so the gate, "unverifiable" and fail-closed
 * paths are exercised end to end without a real provider. File-sourced drafts pass only when
 * their claim is literally in the cited chunk.
 */
import { BAD_IDS, deckEntryByQuestion } from "./deck.js";
import type { Verifier } from "../types.js";

const by = { provider: "mock", model: "mock" };

export const mockVerifier: Verifier = {
  name: "mock",
  async verify(q) {
    if (q.sourceText !== undefined) {
      return q.sourceText.replace(/\s+/g, " ").includes(q.claim)
        ? { verdict: "correct", sources: ["cited file chunk"], verifiedBy: by }
        : { verdict: "unverifiable", sources: [], note: "claim not found in the cited chunk", verifiedBy: by };
    }
    const question = (q.payload as { question?: unknown })?.question;
    const entry = typeof question === "string" ? deckEntryByQuestion(question) : undefined;
    switch (entry?.id) {
      case BAD_IDS.unverifiable:
        return { verdict: "unverifiable", sources: [], note: "no reference found for this claim", verifiedBy: by };
      case BAD_IDS.twoCorrect:
        return { verdict: "ambiguous", sources: ["mock://reference/1"], note: "more than one option is correct", verifiedBy: by };
      case BAD_IDS.answerInQuestion:
        return { verdict: "incorrect", sources: ["mock://reference/1"], note: "the answer appears in the question", verifiedBy: by };
      default:
        return { verdict: "correct", sources: ["mock://reference/1", "mock://reference/2"], verifiedBy: by };
    }
  },
};

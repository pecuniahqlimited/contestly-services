/**
 * Deterministic verifier: fails exactly the planted bad deck entries (by their fixed ids) and
 * passes everything else with two mock citations, so the gate, "needs a source" and fail-closed
 * paths are exercised end to end without a real provider. File-sourced drafts pass only when
 * their claim is literally in the cited chunk.
 */
import { BAD_IDS, deckEntryByQuestion } from "./deck.js";
import type { Verifier } from "../types.js";

export const mockVerifier: Verifier = {
  async verify(q) {
    if (q.sourceText !== undefined) {
      return q.sourceText.replace(/\s+/g, " ").includes(q.claim)
        ? { verdict: "pass", sources: ["cited file chunk"] }
        : { verdict: "needs_source", sources: [], note: "claim not found in the cited chunk" };
    }
    const question = (q.payload as { question?: unknown })?.question;
    const entry = typeof question === "string" ? deckEntryByQuestion(question) : undefined;
    switch (entry?.id) {
      case BAD_IDS.unverifiable:
        return { verdict: "needs_source", sources: [], note: "no reference found for this claim" };
      case BAD_IDS.twoCorrect:
        return { verdict: "fail", sources: ["mock://reference/1"], note: "more than one option is correct" };
      case BAD_IDS.answerInQuestion:
        return { verdict: "fail", sources: ["mock://reference/1"], note: "the answer appears in the question" };
      default:
        return { verdict: "pass", sources: ["mock://reference/1", "mock://reference/2"] };
    }
  },
};

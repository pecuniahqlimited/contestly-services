/**
 * The whole pipeline run purely (no DB): draft with the mock generator, verify independently,
 * embed, dedupe within the batch, safety-check and gate — asserting that no planted bad question
 * survives and the near-duplicate dies at the dedupe step. This is the sealed-mode review gate
 * in miniature; the sim proves the same end to end against the running stack.
 */
import { describe, expect, it } from "vitest";
import { QUESTION_FORMATS } from "@contestly/shared";
import { payloadSchemas } from "@contestly/game";
import { isKnownBadQuestion } from "../src/providers/mock/deck.js";
import { mockGenerator } from "../src/providers/mock/generator.js";
import { mockVerifier } from "../src/providers/mock/verifier.js";
import { mockEmbedder } from "../src/providers/mock/embedder.js";
import { buildSpec } from "../src/pipeline/spec.js";
import { nearest } from "../src/pipeline/dedupe.js";
import { checkSafety } from "@contestly/shared";
import { gateDraft, type GateOutcome } from "../src/pipeline/gate.js";
import { embeddingText } from "../src/pipeline/text.js";

describe("full chain with mock providers", () => {
  it("gates out every planted bad question and the near-duplicate", async () => {
    const spec = buildSpec({ brief: "Nigerian general knowledge — cities, food, music, football", difficulty: "mixed", formats: [...QUESTION_FORMATS], questionCount: 5, questionSeconds: 10 });
    const drafts = await mockGenerator.draft({ spec, count: 13, avoid: [] });

    const accepted: { payload: unknown; embedding: number[] }[] = [];
    const outcomes: GateOutcome[] = [];
    for (const draft of drafts) {
      const payloadValid = payloadSchemas[draft.format].safeParse(draft.payload).success;
      const verify = await mockVerifier.verify(draft);
      const [embedding] = await mockEmbedder.embed([embeddingText(draft.format, draft.payload)]);
      const near = nearest(embedding, accepted.map((a, i) => ({ id: `d${i}`, embedding: a.embedding })));
      const outcome = gateDraft({ payloadValid, verify, nearest: near, dedupeThreshold: 0.92, safety: checkSafety(spec, draft.payload, draft.explanation) });
      outcomes.push(outcome);
      if (outcome === "accepted") accepted.push({ payload: draft.payload, embedding });
    }

    expect(accepted.some((a) => isKnownBadQuestion(a.payload))).toBe(false);
    expect(outcomes.filter((o) => o === "rejected_verify")).toHaveLength(3); // two fails + one needs_source
    expect(outcomes.filter((o) => o === "rejected_dedupe")).toHaveLength(1); // the planted near-duplicate
    expect(accepted.length).toBe(drafts.length - 4);
  });
});

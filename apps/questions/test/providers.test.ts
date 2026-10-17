import { describe, expect, it } from "vitest";
import { EMBEDDING_DIM, QUESTION_FORMATS } from "@contestly/shared";
import { BAD_IDS, DECK, DUP_IDS, deckEntryByQuestion, isKnownBadQuestion } from "../src/providers/mock/deck.js";
import { mockGenerator } from "../src/providers/mock/generator.js";
import { mockVerifier } from "../src/providers/mock/verifier.js";
import { mockEmbedder } from "../src/providers/mock/embedder.js";
import type { GenerationSpec } from "../src/providers/types.js";

const spec = (over: Partial<GenerationSpec> = {}): GenerationSpec => ({
  topic: "nigerian general knowledge — cities, food, music, football",
  categoryTag: "General knowledge",
  difficulty: "mixed",
  secondsPerQuestion: 10,
  formats: [...QUESTION_FORMATS],
  exclusions: [],
  language: "en",
  sourceScope: "open",
  summary: "test",
  ...over,
});

describe("mock deck", () => {
  it("covers all five formats with good entries", () => {
    for (const f of QUESTION_FORMATS) {
      expect(DECK.filter((e) => e.format === f && !Object.values(BAD_IDS).includes(e.id as never)).length).toBeGreaterThanOrEqual(5);
    }
  });

  it("recognises exactly the planted bad questions", () => {
    for (const id of Object.values(BAD_IDS)) {
      expect(isKnownBadQuestion(DECK.find((e) => e.id === id)!.payload)).toBe(true);
    }
    expect(isKnownBadQuestion(DECK.find((e) => e.id === "po-lga")!.payload)).toBe(false);
  });
});

describe("MockGenerator", () => {
  it("is deterministic and always plants the bads and the duplicate", async () => {
    const a = await mockGenerator.draft({ spec: spec(), count: 13, avoid: [] });
    const b = await mockGenerator.draft({ spec: spec(), count: 13, avoid: [] });
    expect(a).toEqual(b);
    expect(a).toHaveLength(13);
    const questions = a.map((d) => (d.payload as { question: string }).question);
    for (const id of [...Object.values(BAD_IDS), DUP_IDS.duplicate, DUP_IDS.original]) {
      expect(questions).toContain(DECK.find((e) => e.id === id)!.payload.question);
    }
  });

  it("respects the formats filter and the avoid list", async () => {
    const only = await mockGenerator.draft({ spec: spec({ formats: ["order"] }), count: 5, avoid: [] });
    expect(only.every((d) => d.format === "order")).toBe(true);

    const first = await mockGenerator.draft({ spec: spec(), count: 5, avoid: [] });
    const avoid = first.map((d) => (d.payload as { question: string }).question);
    const second = await mockGenerator.draft({ spec: spec(), count: 5, avoid });
    expect(second.map((d) => (d.payload as { question: string }).question).filter((q) => avoid.includes(q))).toHaveLength(0);
  });
});

describe("MockGenerator once the deck is exhausted", () => {
  it("tops up with distinct, valid, verifiable synthetic questions that dedupe can tell apart", async () => {
    const avoid = DECK.map((e) => e.payload.question); // the whole deck is off-limits, planted ones included
    const fresh = await mockGenerator.draft({ spec: spec(), count: 12, avoid });
    expect(fresh).toHaveLength(12);
    expect(fresh.some((d) => isKnownBadQuestion(d.payload))).toBe(false);
    const { payloadSchemas } = await import("@contestly/game");
    const { embeddingText } = await import("../src/pipeline/text.js");
    for (const d of fresh) {
      expect(payloadSchemas.pick_one.safeParse(d.payload).success).toBe(true);
      expect((await mockVerifier.verify(d)).verdict).toBe("pass");
    }
    const vecs = await mockEmbedder.embed(fresh.map((d) => embeddingText(d.format, d.payload)));
    const cos = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i], 0);
    for (let i = 0; i < vecs.length; i++) for (let j = i + 1; j < vecs.length; j++) expect(cos(vecs[i], vecs[j])).toBeLessThan(0.92);

    // and it keeps going: avoiding this batch too yields a new one
    const next = await mockGenerator.draft({ spec: spec(), count: 12, avoid: [...avoid, ...fresh.map((d) => (d.payload as { question: string }).question)] });
    const nextTexts = next.filter((d) => !isKnownBadQuestion(d.payload)).map((d) => (d.payload as { question: string }).question);
    expect(nextTexts.some((t) => fresh.some((d) => (d.payload as { question: string }).question === t))).toBe(false);
  });
});

describe("MockVerifier", () => {
  const draftOf = (id: string) => {
    const e = DECK.find((x) => x.id === id)!;
    return { format: e.format, payload: e.payload, explanation: e.explanation, claim: e.claim };
  };

  it("fails the fixed bad ids and nothing else", async () => {
    expect((await mockVerifier.verify(draftOf(BAD_IDS.twoCorrect))).verdict).toBe("fail");
    expect((await mockVerifier.verify(draftOf(BAD_IDS.answerInQuestion))).verdict).toBe("fail");
    expect((await mockVerifier.verify(draftOf(BAD_IDS.unverifiable))).verdict).toBe("needs_source");
    const pass = await mockVerifier.verify(draftOf("po-keshi"));
    expect(pass.verdict).toBe("pass");
    expect(pass.sources.length).toBeGreaterThanOrEqual(2);
  });
});

describe("MockEmbedder", () => {
  it("returns deterministic unit vectors of the right width", async () => {
    const [a] = await mockEmbedder.embed(["Which city is the capital of Nigeria?"]);
    const [b] = await mockEmbedder.embed(["Which city is the capital of Nigeria?"]);
    expect(a).toEqual(b);
    expect(a).toHaveLength(EMBEDDING_DIM);
    expect(Math.sqrt(a.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 6);
  });

  it("puts the planted near-duplicate pair above the dedupe threshold and unrelated questions below it", async () => {
    const text = (id: string) => DECK.find((e) => e.id === id)!.payload.question;
    const [dupA, dupB, other] = await mockEmbedder.embed([text(DUP_IDS.original), text(DUP_IDS.duplicate), text("pa-afcon")]);
    const cos = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i], 0);
    expect(cos(dupA, dupB)).toBeGreaterThanOrEqual(0.92);
    expect(cos(dupA, other)).toBeLessThan(0.92);
  });
});

describe("deck lookups", () => {
  it("finds entries by question text", () => {
    expect(deckEntryByQuestion("Which river joins the Niger at Lokoja?")?.id).toBe("po-lokoja");
    expect(deckEntryByQuestion("not a deck question")).toBeUndefined();
  });
});

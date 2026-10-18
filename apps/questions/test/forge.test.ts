import { describe, expect, it } from "vitest";
import { deckProgress } from "../src/pipeline/forge.js";
import { draftAndJudge } from "../src/pipeline/judge.js";
import { buildSpec } from "../src/pipeline/spec.js";
import { mockEmbedder } from "../src/providers/mock/embedder.js";
import { mockGenerator } from "../src/providers/mock/generator.js";
import { mockVerifier } from "../src/providers/mock/verifier.js";

const SOURCES = [
  "The Third Mainland Bridge crosses the lagoon and was opened in 1990. Carter Bridge first linked Lagos Island to the mainland in 1901.",
  "Eko Bridge was completed in 1975 to ease traffic on older crossings. The Lekki toll bridge opened in 2013 and connects Lekki with Ikoyi.",
  "Ferries from Falomo and Ikorodu carry commuters across the water every day. Apapa is the busiest port in Nigeria.",
].map((text, i) => ({ id: `chunk-${i}`, text }));

describe("deckProgress", () => {
  it("never shows more cards than the set has", () => {
    expect(deckProgress("dedupe", ["pick_one", "order", "match"], 2)).toEqual({ stage: "dedupe", done: 2, total: 2, formats: ["pick_one", "order"] });
    expect(deckProgress("reading", [], 5)).toEqual({ stage: "reading", done: 0, total: 5, formats: [] });
  });
});

describe("draftAndJudge progress", () => {
  it("names each stage in pipeline order, with the accepted cards' formats growing during dedupe", async () => {
    const spec = buildSpec({ brief: "lagos bridges", difficulty: "mixed", formats: ["pick_one"], questionCount: 3, questionSeconds: 10, fileIds: ["f"] });
    const seen: { stage: string; cards: number }[] = [];
    const { accepted } = await draftAndJudge(
      { spec, providers: { generator: mockGenerator, verifier: mockVerifier, embedder: mockEmbedder }, dedupeSimilarity: 0.92, want: 3, avoid: [], sources: SOURCES },
      async (stage, formats) => void seen.push({ stage, cards: formats.length }),
    );
    expect(accepted.length).toBeGreaterThan(0);
    const stages = seen.map((s) => s.stage).filter((s, i, all) => s !== all[i - 1]);
    expect(stages.slice(0, 3)).toEqual(["drafting", "checking", "dedupe"]);
    const counts = seen.filter((s) => s.stage === "dedupe").map((s) => s.cards);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(counts.at(-1)).toBe(accepted.length);
  });
});

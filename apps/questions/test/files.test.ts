import { describe, expect, it } from "vitest";
import { DEFAULT_QUESTIONS_CONFIG, QUESTION_FORMATS } from "@contestly/shared";
import { payloadSchemas } from "@contestly/game";
import { draftsFromFile } from "../src/providers/mock/fromFile.js";
import { mockGenerator } from "../src/providers/mock/generator.js";
import { mockVerifier } from "../src/providers/mock/verifier.js";
import { buildSpec } from "../src/pipeline/spec.js";
import { retirementReason } from "../src/pipeline/retire.js";

const SOURCE = [
  "The Lagos Lagoon separates Lagos Island from the Mainland.",
  "The Third Mainland Bridge was opened in 1990 and is about 11 kilometres long.",
  "Carter Bridge was the first bridge linking Lagos Island to Ebute Metta in 1901.",
  "Eko Bridge was completed in 1975 to ease traffic on Carter Bridge.",
  "The Lekki toll bridge, opened in 2013, connects Lekki with Ikoyi across the lagoon.",
  "Ferries from Falomo and Ikorodu carry thousands of commuters across the water every day.",
];
/** Two sentences a chunk, as the API's chunker would roughly cut them. */
const CHUNKS = [0, 2, 4].map((i) => SOURCE.slice(i, i + 2).join(" "));

describe("file-sourced mock generation", () => {
  const sources = CHUNKS.map((text, i) => ({ id: `chunk-${i}`, text }));

  it("drafts valid pick-one questions answerable only from the file, each citing its chunk", () => {
    const drafts = draftsFromFile(sources, 10, new Set());
    expect(drafts.length).toBeGreaterThanOrEqual(4);
    for (const d of drafts) {
      expect(payloadSchemas.pick_one.safeParse(d.payload).success).toBe(true);
      const p = d.payload as { question: string; options: string[]; correctIndex: number };
      expect(p.question).toContain("____");
      expect(p.question).not.toContain(p.options[p.correctIndex]); // the answer isn't in the question
      const chunk = sources.find((s) => s.id === d.sourceChunkId)!;
      expect(chunk.text).toContain(d.claim);
    }
  });

  it("produces nothing when the spec doesn't allow pick-one", async () => {
    const spec = buildSpec({ brief: "lagos bridges", difficulty: "mixed", formats: ["order"], questionCount: 3, questionSeconds: 10, fileIds: ["f"] });
    expect(await mockGenerator.draft({ spec, count: 3, avoid: [], sources })).toEqual([]);
  });

  it("verifies against the cited chunk, not open knowledge", async () => {
    const [d] = draftsFromFile(sources, 1, new Set());
    const chunk = sources.find((s) => s.id === d.sourceChunkId)!;
    expect((await mockVerifier.verify({ ...d, sourceText: chunk.text })).verdict).toBe("pass");
    expect((await mockVerifier.verify({ ...d, sourceText: "a different chunk entirely" })).verdict).toBe("needs_source");
  });

  it("marks the spec as file-scoped in the summary", () => {
    const spec = buildSpec({ brief: "lagos bridges", difficulty: "mixed", formats: [...QUESTION_FORMATS], questionCount: 3, questionSeconds: 10, fileIds: ["f"] });
    expect(spec.sourceScope).toEqual({ kind: "file", fileIds: ["f"] });
    expect(spec.summary).toContain("only from your file");
  });
});

describe("retirementReason", () => {
  const cfg = DEFAULT_QUESTIONS_CONFIG; // min 30 answers, below 5% correct, above 50% skipped, 5 flags
  const stats = (o: Partial<{ flagCount: number; timesAnswered: number; correctnessSum: number; timesSkipped: number }>) =>
    ({ flagCount: 0, timesAnswered: 0, correctnessSum: 0, timesSkipped: 0, ...o });

  it("retires on flags regardless of plays", () => {
    expect(retirementReason(stats({ flagCount: 5 }), cfg)).toBe("flagged");
    expect(retirementReason(stats({ flagCount: 4 }), cfg)).toBeNull();
  });

  it("waits for enough answers before judging play stats", () => {
    expect(retirementReason(stats({ timesAnswered: 29, correctnessSum: 0 }), cfg)).toBeNull();
  });

  it("retires questions almost nobody gets right, or most people skip", () => {
    expect(retirementReason(stats({ timesAnswered: 40, correctnessSum: 40 * 4 }), cfg)).toBe("too_hard"); // 4% avg
    expect(retirementReason(stats({ timesAnswered: 40, correctnessSum: 40 * 5 }), cfg)).toBeNull(); // exactly 5%
    expect(retirementReason(stats({ timesAnswered: 40, correctnessSum: 40 * 60, timesSkipped: 21 }), cfg)).toBe("skipped");
    expect(retirementReason(stats({ timesAnswered: 40, correctnessSum: 40 * 60, timesSkipped: 20 }), cfg)).toBeNull();
  });
});

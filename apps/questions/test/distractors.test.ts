import { describe, expect, it } from "vitest";
import { ProviderUnavailable } from "@contestly/ai";
import type { SafetyBrief } from "@contestly/shared";
import { NoSafeDistractors, SafetyUnavailable, UnsafeHostText, suggestDistractors } from "../src/pipeline/distractors.js";
import { mockGenerator as generator } from "../src/providers/mock/generator.js";
import { mockSafety as safety } from "../src/providers/mock/safety.js";
import type { Generator, SafetyReviewer } from "../src/providers/types.js";

const offering = (options: unknown[]): Generator => ({ draft: async () => [], distract: async () => options as string[] });
const mock = { generator, safety };
/** A model reviewer that fails any item whose text mentions one of `words`, and records what it was asked. */
function reviewer(words: string[] = []) {
  const asked: { brief: SafetyBrief; texts: string[] }[] = [];
  const s: SafetyReviewer = {
    name: "fake",
    async review(brief, items) {
      const texts = items.map((it) => JSON.stringify(it.payload));
      asked.push({ brief, texts });
      return texts.map((t) => (words.some((w) => t.includes(w)) ? { passed: false, reasons: ["model:private_individual"] } : { passed: true, reasons: [] }));
    },
  };
  return { s, asked };
}
const ask = { question: "Where did Tolu and Femi first meet?", answer: "Church", brief: "Tolu and Femi's bridal shower" };

describe("suggestDistractors", () => {
  it("gives three different wrong options from the mock, none of them the answer", async () => {
    const { distractors } = await suggestDistractors(ask, mock);
    expect(distractors).toHaveLength(3);
    expect(new Set(distractors.map((d) => d.toLowerCase())).size).toBe(3);
    expect(distractors.map((d) => d.toLowerCase())).not.toContain("church");
  });

  it("offers nearby numbers for a number, nearby years for a year", async () => {
    const years = (await suggestDistractors({ ...ask, question: "What year did we graduate?", answer: "2009" }, mock)).distractors;
    expect(years.every((y) => /^\d{4}$/.test(y) && Math.abs(Number(y) - 2009) <= 6)).toBe(true);
    const n = (await suggestDistractors({ ...ask, question: "How many years have they been together?", answer: "7" }, mock)).distractors;
    expect(n.every((x) => /^\d+$/.test(x) && x !== "7")).toBe(true);
  });

  it("drops unsafe, repeated and empty candidates, then takes the first three left", async () => {
    const { distractors } = await suggestDistractors(ask, { safety, generator: offering(["the casino", "church", " ", 42, "Office", "office", "Gym", "Wedding", "Market"]) });
    expect(distractors).toEqual(["Office", "Gym", "Wedding"]);
  });

  it("fails rather than give fewer than three", async () => {
    await expect(suggestDistractors(ask, { safety, generator: offering(["Office", "bet9ja", "Office"]) })).rejects.toBeInstanceOf(NoSafeDistractors);
  });

  it("refuses the host's own unsafe words before generating anything (fails closed)", async () => {
    let asked = false;
    const counting: Generator = { draft: async () => [], distract: async () => { asked = true; return ["a", "b", "c"]; } };
    await expect(suggestDistractors({ ...ask, answer: "At the casino" }, { generator: counting, safety })).rejects.toBeInstanceOf(UnsafeHostText);
    await expect(suggestDistractors({ ...ask, question: "Who did they vote for in the election?" }, { generator: counting, safety })).rejects.toBeInstanceOf(UnsafeHostText);
    expect(asked).toBe(false);
  });

  it("respects the brief's exclusions on the candidates", async () => {
    const { distractors } = await suggestDistractors({ ...ask, brief: "a bridal shower, nothing about office" }, { safety, generator: offering(["Office", "Gym", "Wedding", "Market"]) });
    expect(distractors).toEqual(["Gym", "Wedding", "Market"]);
  });

  it("the model check: the host's words and every candidate in one call, told the words are host-written", async () => {
    const { s: model, asked } = reviewer();
    const { distractors } = await suggestDistractors(ask, { generator: offering(["Office", "Gym", "Wedding", "Market"]), safety: model });
    expect(distractors).toEqual(["Office", "Gym", "Wedding"]);
    expect(asked).toHaveLength(1);
    expect(asked[0].brief).toMatchObject({ topic: ask.brief, hostWritten: true });
    expect(asked[0].texts).toHaveLength(5); // the host's question, then each candidate beside its answer
    expect(asked[0].texts[0]).toContain("Church");
  });

  it("the model refusing the host's words refuses them, with its reasons", async () => {
    const { s: model } = reviewer(["Tolu"]);
    await expect(suggestDistractors(ask, { generator: offering(["Office", "Gym", "Wedding"]), safety: model })).rejects.toMatchObject({ reasons: ["model:private_individual"] });
  });

  it("drops the candidates the model fails, and fails rather than give fewer than three", async () => {
    const question = "Where did they first meet?";
    expect((await suggestDistractors({ ...ask, question }, { generator: offering(["Office", "Gym", "Wedding", "Market"]), safety: reviewer(["Gym"]).s })).distractors).toEqual(["Office", "Wedding", "Market"]);
    await expect(suggestDistractors({ ...ask, question }, { generator: offering(["Office", "Gym", "Wedding"]), safety: reviewer(["Gym"]).s })).rejects.toBeInstanceOf(NoSafeDistractors);
  });

  it("fails closed when the model check can't run: no suggestions", async () => {
    const down: SafetyReviewer = { name: "down", review: async () => { throw new ProviderUnavailable("timeout", "fake", "safety", "timed out"); } };
    await expect(suggestDistractors(ask, { generator: offering(["Office", "Gym", "Wedding"]), safety: down })).rejects.toBeInstanceOf(SafetyUnavailable);
  });
});

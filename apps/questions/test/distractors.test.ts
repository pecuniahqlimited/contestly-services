import { describe, expect, it } from "vitest";
import { NoSafeDistractors, UnsafeHostText, suggestDistractors } from "../src/pipeline/distractors.js";
import { mockGenerator } from "../src/providers/mock/generator.js";
import type { Generator } from "../src/providers/types.js";

const offering = (options: unknown[]): Generator => ({ draft: async () => [], distract: async () => options as string[] });
const ask = { question: "Where did Tolu and Femi first meet?", answer: "Church", brief: "Tolu and Femi's bridal shower" };

describe("suggestDistractors", () => {
  it("gives three different wrong options from the mock, none of them the answer", async () => {
    const { distractors } = await suggestDistractors(ask, { generator: mockGenerator });
    expect(distractors).toHaveLength(3);
    expect(new Set(distractors.map((d) => d.toLowerCase())).size).toBe(3);
    expect(distractors.map((d) => d.toLowerCase())).not.toContain("church");
  });

  it("offers nearby numbers for a number, nearby years for a year", async () => {
    const years = (await suggestDistractors({ ...ask, question: "What year did we graduate?", answer: "2009" }, { generator: mockGenerator })).distractors;
    expect(years.every((y) => /^\d{4}$/.test(y) && Math.abs(Number(y) - 2009) <= 6)).toBe(true);
    const n = (await suggestDistractors({ ...ask, question: "How many years have they been together?", answer: "7" }, { generator: mockGenerator })).distractors;
    expect(n.every((x) => /^\d+$/.test(x) && x !== "7")).toBe(true);
  });

  it("drops unsafe, repeated and empty candidates, then takes the first three left", async () => {
    const { distractors } = await suggestDistractors(ask, { generator: offering(["the casino", "church", " ", 42, "Office", "office", "Gym", "Wedding", "Market"]) });
    expect(distractors).toEqual(["Office", "Gym", "Wedding"]);
  });

  it("fails rather than give fewer than three", async () => {
    await expect(suggestDistractors(ask, { generator: offering(["Office", "bet9ja", "Office"]) })).rejects.toBeInstanceOf(NoSafeDistractors);
  });

  it("refuses the host's own unsafe words before generating anything (fails closed)", async () => {
    let asked = false;
    const generator: Generator = { draft: async () => [], distract: async () => { asked = true; return ["a", "b", "c"]; } };
    await expect(suggestDistractors({ ...ask, answer: "At the casino" }, { generator })).rejects.toBeInstanceOf(UnsafeHostText);
    await expect(suggestDistractors({ ...ask, question: "Who did they vote for in the election?" }, { generator })).rejects.toBeInstanceOf(UnsafeHostText);
    expect(asked).toBe(false);
  });

  it("respects the brief's exclusions on the candidates", async () => {
    const { distractors } = await suggestDistractors({ ...ask, brief: "a bridal shower, nothing about office" }, { generator: offering(["Office", "Gym", "Wedding", "Market"]) });
    expect(distractors).toEqual(["Gym", "Wedding", "Market"]);
  });
});

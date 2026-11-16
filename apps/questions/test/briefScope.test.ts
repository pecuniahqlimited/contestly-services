/**
 * What a brief scopes a set to (16 Nov 2026): the period it asks about, the category it's tagged with, and the pool
 * images that fit it. A "WWE Monday Night Raw 2026" brief got Raw's history and two Nigerian landmark pictures.
 */
import { describe, expect, it } from "vitest";
import { QUESTION_FORMATS } from "@contestly/shared";
import { buildSpec } from "../src/pipeline/spec.js";
import { inPeriod } from "../src/pipeline/retrieve.js";
import { userPrompt } from "../src/providers/drafting/prompt.js";
import { structuredGenerator } from "../src/providers/drafting/generator.js";
import { IMAGE_POOL, imagesFor } from "../src/providers/imagePool.js";

const NOW = new Date("2026-11-16T12:00:00Z");
const input = (brief: string) => ({ brief, difficulty: "mixed" as const, formats: [...QUESTION_FORMATS], questionCount: 10, questionSeconds: 12, now: NOW });

describe("the brief's period in the spec", () => {
  it("a recent year is made as the topic's history, said so in the summary and the prompt", () => {
    const spec = buildSpec(input("WWE monday night raw 2026"));
    expect(spec.period).toEqual({ label: "2026", from: 2026, to: 2026, use: "history" });
    expect(spec.summary).toContain("its history, not 2026");
    const prompt = userPrompt({ spec, formats: [{ format: "pick_one", count: 1, instructions: "" }], avoid: [] });
    expect(prompt).toContain("never say or imply that anything happened in 2026");
  });

  it("an older period is kept: the set stays inside it", () => {
    const spec = buildSpec(input("WWF Raw in the Attitude Era, 1997-2001"));
    expect(spec.period).toEqual({ label: "1997–2001", from: 1997, to: 2001, use: "only" });
    expect(spec.summary).toContain("1997–2001 only");
    expect(userPrompt({ spec, formats: [{ format: "pick_one", count: 1, instructions: "" }], avoid: [] })).toContain("Period: only 1997–2001 (1997 to 2001)");
  });

  it("no period, no line; a file-scoped set leaves dates to the file", () => {
    expect(buildSpec(input("Jollof wars")).period).toBeUndefined();
    expect(buildSpec({ ...input("Our 2026 sales handbook"), fileIds: ["f1"] }).period).toBeUndefined();
  });

  it("bank reuse inside a period keeps only questions naming a year in it", () => {
    const spec = buildSpec(input("Afrobeats in 1999"));
    const rows = [
      { id: "in", payload: { question: "Which album came out in 1999?" }, explanation: null },
      { id: "out", payload: { question: "Who won in 2012?" }, explanation: null },
      { id: "undated", payload: { question: "Who sang Ojuelegba?" }, explanation: null },
      { id: "explained", payload: { question: "Whose debut was this?" }, explanation: "Released in March 1999." },
    ];
    expect(inPeriod(spec, rows).map((r) => r.id)).toEqual(["in", "explained"]);
    expect(inPeriod(buildSpec(input("Afrobeats")), rows)).toHaveLength(4);
  });
});

describe("category tags", () => {
  it("wrestling and other sports are Sports, not General knowledge", () => {
    expect(buildSpec(input("WWE monday night raw 2026")).categoryTag).toBe("Sports");
    expect(buildSpec(input("WrestleMania main events")).categoryTag).toBe("Sports");
    expect(buildSpec(input("NBA finals and Olympic basketball")).categoryTag).toBe("Sports");
  });

  it("a hint matches at the start of a word, not inside one", () => {
    expect(buildSpec(input("trap beats and wrap parties")).categoryTag).toBe("General knowledge"); // not "rap"
    expect(buildSpec(input("rappers from Lagos")).categoryTag).toBe("Hip hop");
  });
});

describe("pictures only when an image fits the topic", () => {
  it("no pool image fits a WWE set; Nigeria briefs and Geography sets get theirs", () => {
    expect(imagesFor(buildSpec(input("WWE monday night raw 2026")))).toEqual([]);
    expect(imagesFor(buildSpec(input("Harry Potter books")))).toEqual([]);
    expect(imagesFor(buildSpec(input("Lagos nightlife and food"))).map((i) => i.id)).toEqual(["national-theatre", "lekki-ikoyi"]);
    expect(imagesFor(buildSpec(input("Nigerian general knowledge")))).toHaveLength(IMAGE_POOL.length);
    expect(imagesFor(buildSpec(input("capital cities and rivers of Africa")))).toHaveLength(IMAGE_POOL.length);
  });

  it("the generator asks for no picture rounds when nothing fits, and offers only the images that do", async () => {
    const asked: string[] = [];
    const gen = structuredGenerator({ provider: "gemini", model: async () => "gemini-3.6-flash", ask: async ({ user }) => { asked.push(user); return { questions: {} }; } });
    await gen.draft({ spec: buildSpec(input("WWE monday night raw 2026")), count: 10, avoid: [] });
    expect(asked[0]).not.toContain('under "picture"');
    expect(asked[0]).not.toContain("Image list");
    await gen.draft({ spec: buildSpec(input("Lagos nightlife and food")), count: 10, avoid: [] });
    expect(asked[1]).toContain('under "picture"');
    expect(asked[1]).toContain("national-theatre");
    expect(asked[1]).not.toContain("aso-rock");
  });
});

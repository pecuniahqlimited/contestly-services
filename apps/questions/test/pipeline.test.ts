import { describe, expect, it } from "vitest";
import { QUESTION_FORMATS } from "@contestly/shared";
import { buildSpec, parseExclusions } from "../src/pipeline/spec.js";
import { cosine, isDuplicate, nearest } from "../src/pipeline/dedupe.js";
import { estimateDifficulty } from "../src/pipeline/difficulty.js";
import { checkSafety } from "../src/pipeline/safety.js";
import { assertSetFilled, gateDraft, SetUnderfilled } from "../src/pipeline/gate.js";
import type { GateInput } from "../src/pipeline/gate.js";

const input = (brief: string) => ({ brief, difficulty: "mixed" as const, formats: [...QUESTION_FORMATS], questionCount: 5, questionSeconds: 10 });

describe("buildSpec", () => {
  it("infers the category and builds the one-line summary", () => {
    const spec = buildSpec(input("Nigerian food: dishes, ingredients and which city claims them"));
    expect(spec.categoryTag).toBe("Food");
    expect(spec.summary).toContain("Mixed-difficulty Food");
    expect(spec.summary).toContain("5 questions");
    expect(spec.summary).toContain("10s each");
  });

  it("tags a brief that spreads evenly across topics as General knowledge", () => {
    expect(buildSpec(input("Nigerian general knowledge — cities, food, music, football")).categoryTag).toBe("General knowledge");
    expect(buildSpec(input("Super Eagles football and AFCON finals, plus one music round")).categoryTag).toBe("Football");
  });

  it("falls back to General knowledge and collapses whitespace", () => {
    const spec = buildSpec(input("  a   quiet\n evening quiz  "));
    expect(spec.categoryTag).toBe("General knowledge");
    expect(spec.topic).toBe("a quiet evening quiz");
  });

  it("parses exclusions and carries them into the summary", () => {
    expect(parseExclusions("Football greats, nothing about politics, please")).toEqual(["politics"]);
    expect(parseExclusions("90s music. Avoid slow jams; no questions about disco")).toEqual(["slow jams", "disco"]);
    const spec = buildSpec(input("Football greats, nothing about politics"));
    expect(spec.exclusions).toEqual(["politics"]);
    expect(spec.summary).toContain("skipping politics");
  });
});

describe("dedupe", () => {
  it("finds the nearest neighbour and applies the threshold", () => {
    const a = [1, 0, 0];
    const near = nearest(a, [{ id: "x", embedding: [0, 1, 0] }, { id: "y", embedding: [0.95, 0.312, 0] }]);
    expect(near?.id).toBe("y");
    expect(isDuplicate(near, 0.92)).toBe(true);
    expect(isDuplicate(near, 0.96)).toBe(false);
    expect(nearest(a, [])).toBeNull();
    expect(isDuplicate(null, 0.5)).toBe(false);
    expect(cosine(a, a)).toBeCloseTo(1);
  });
});

describe("difficulty estimate", () => {
  it("tracks the requested band, bumps interactive formats, and is marked as an estimate", () => {
    expect(estimateDifficulty("easy", "pick_one")).toEqual({ value: 0.25, source: "model_estimate" });
    expect(estimateDifficulty("mixed", "order").value).toBeGreaterThan(estimateDifficulty("mixed", "pick_one").value);
    expect(estimateDifficulty("brutal", "order").value).toBeLessThanOrEqual(1);
  });
});

describe("safety filter", () => {
  const spec = buildSpec(input("Nigerian general knowledge"));

  it("passes clean questions and rejects deny-list hits with reasons", () => {
    expect(checkSafety(spec, { question: "Which city is the capital?", options: ["A", "B"] }).passed).toBe(true);
    const hit = checkSafety(spec, { question: "Download Bet9ja and stake your salary", options: ["A", "B"] });
    expect(hit.passed).toBe(false);
    expect(hit.reasons).toContain("gambling_promo");
  });

  it("matches whole words only", () => {
    expect(checkSafety(spec, { question: "Which English county is Essex?", options: ["A", "B"] }).passed).toBe(true);
    expect(checkSafety(spec, { question: "What is the capacity of the stadium?", options: ["A", "B"] }).passed).toBe(true);
  });

  it("rejects politics unless the brief asked for it", () => {
    const political = { question: "Which political party won the election?", options: ["A", "B"] };
    expect(checkSafety(spec, political).passed).toBe(false);
    const politicsSpec = buildSpec(input("Nigerian election history and political party trivia"));
    expect(checkSafety(politicsSpec, political).passed).toBe(true);
  });

  it("enforces the brief's exclusions", () => {
    const noFood = buildSpec(input("Lagos life, nothing about jollof"));
    const r = checkSafety(noFood, { question: "Who makes the best jollof?", options: ["A", "B"] });
    expect(r.passed).toBe(false);
    expect(r.reasons).toContain("excluded:jollof");
  });

  it("fails closed on empty or unreadable payloads", () => {
    expect(checkSafety(spec, {}).passed).toBe(false);
    expect(checkSafety(spec, {}).reasons).toContain("empty");
  });
});

describe("gate", () => {
  const ok: GateInput = {
    payloadValid: true,
    verify: { verdict: "pass", sources: ["a", "b"] },
    nearest: { id: "x", similarity: 0.4 },
    dedupeThreshold: 0.92,
    safety: { passed: true, reasons: [] },
  };

  it("accepts a clean draft and names the first failing step otherwise", () => {
    expect(gateDraft(ok)).toBe("accepted");
    expect(gateDraft({ ...ok, payloadValid: false })).toBe("rejected_invalid");
    expect(gateDraft({ ...ok, verify: { verdict: "fail", sources: [] } })).toBe("rejected_verify");
    expect(gateDraft({ ...ok, verify: { verdict: "needs_source", sources: [] } })).toBe("rejected_verify");
    expect(gateDraft({ ...ok, nearest: { id: "x", similarity: 0.95 } })).toBe("rejected_dedupe");
    expect(gateDraft({ ...ok, safety: { passed: false, reasons: ["politics"] } })).toBe("rejected_safety");
  });

  it("fails closed when the set cannot be filled", () => {
    expect(() => assertSetFilled(6, 7)).toThrow(SetUnderfilled);
    expect(() => assertSetFilled(7, 7)).not.toThrow();
  });
});

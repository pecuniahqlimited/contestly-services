import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLIMB_LADDER, addClimbWordsBodySchema, atRound, checkClimbWord, climbLadderSchema, editClimbWordBodySchema, resolveAt, splitWordLines,
} from "../src/index.js";

const withStage = (stage: Record<string, unknown>) => ({ enabledTypes: DEFAULT_CLIMB_LADDER.enabledTypes, stages: [{ rounds: 3, toClear: 2, seconds: 15, points: 10, ...stage }] });

describe("ramps", () => {
  it("one number is the same every round", () => expect([0, 1, 2].map((r) => atRound(7, r, 3))).toEqual([7, 7, 7]));
  it("round 1 is first, the last round is last, in between is interpolated and rounded", () => {
    expect([0, 1, 2].map((r) => atRound({ first: 3, last: 6 }, r, 3))).toEqual([3, 5, 6]);
    expect([0, 1, 2, 3].map((r) => atRound({ first: 25, last: 15 }, r, 4))).toEqual([25, 22, 18, 15]);
  });
  it("a one-round stage plays first; a round past the end stays at last", () => {
    expect(atRound({ first: 3, last: 6 }, 0, 1)).toBe(3);
    expect(atRound({ first: 3, last: 6 }, 5, 3)).toBe(6);
  });
  it("resolving a block reads every ramp and leaves other settings alone", () => {
    expect(resolveAt({ gridSize: { first: 6, last: 10 }, words: 4, directions: "all" }, 1, 3)).toEqual({ gridSize: 8, words: 4, directions: "all" });
  });
});

describe("stage settings in the ladder", () => {
  it("fill each listed type from its defaults, keep what the admin set, and drop blocks for types not listed", () => {
    const l = climbLadderSchema.parse(withStage({ types: ["word_search"], settings: { word_search: { words: { first: 3, last: 6 } }, scramble: { minLength: 4 } } }));
    expect(Object.keys(l.stages[0].settings)).toEqual(["word_search"]);
    expect(l.stages[0].settings.word_search).toMatchObject({ words: { first: 3, last: 6 }, gridSize: 6, directions: "straight" });
  });
  it("point an out-of-bounds setting to its stage, type and setting", () => {
    const r = climbLadderSchema.safeParse(withStage({ types: ["pattern_recall"], settings: { pattern_recall: { gridSize: 6 } } }));
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].path).toEqual(["stages", 0, "settings", "pattern_recall", "gridSize"]);
  });
  it("refuse a ramp end out of bounds, and unknown settings", () => {
    expect(climbLadderSchema.safeParse(withStage({ types: ["pattern_recall"], settings: { pattern_recall: { msPerTile: { first: 600, last: 100 } } } })).success).toBe(false);
    expect(climbLadderSchema.safeParse(withStage({ types: ["scramble"], settings: { scramble: { colour: 3 } } })).success).toBe(false);
  });
  it("refuse a shortest word longer than the longest, at either end of a ramp, naming the stage and type", () => {
    const r = climbLadderSchema.safeParse(withStage({ types: ["word_search"], settings: { word_search: { minLength: { first: 3, last: 9 }, maxLength: 8 } } }));
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]).toMatchObject({ path: ["stages", 0, "settings", "word_search", "minLength"], message: "stage 1, Word search: shortest word can't be longer than the longest" });
  });
  it("parsing a parsed ladder changes nothing", () => expect(climbLadderSchema.parse(DEFAULT_CLIMB_LADDER)).toEqual(DEFAULT_CLIMB_LADDER));
});

describe("the word list", () => {
  it("normalises to lowercase and trims", () => expect(checkClimbWord("  Jollof ")).toEqual({ ok: true, word: "jollof" }));
  it.each([
    ["ice-cream", "not_letters"], ["naïra", "not_letters"], ["two words", "not_letters"], ["ab", "too_short"],
    ["extraordinary", "too_long"], ["shit", "not_allowed"], ["", "not_letters"],
  ])("refuses %j (%s)", (input, error) => expect(checkClimbWord(input)).toEqual({ ok: false, error }));
  it("splits a paste on newlines and commas, numbering each piece and skipping blanks", () => {
    expect(splitWordLines("mango\n\n guava ,lemon\n")).toEqual([{ line: 1, input: "mango" }, { line: 3, input: "guava" }, { line: 4, input: "lemon" }]);
  });
  it("a word is for every game unless the admin picks some", () => {
    expect(addClimbWordsBodySchema.parse({ text: "mango" }).games).toEqual(["scramble", "word_search", "word_hunt"]);
    expect(addClimbWordsBodySchema.safeParse({ text: "mango", games: [] }).success).toBe(false);
  });
  it("an edit needs a reason and something to change", () => {
    expect(editClimbWordBodySchema.safeParse({ active: false, reason: "too obscure" }).success).toBe(true);
    expect(editClimbWordBodySchema.safeParse({ active: false }).success).toBe(false);
    expect(editClimbWordBodySchema.safeParse({ reason: "nothing" }).success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { grade, publicView, revealAnswer, distribution } from "../src/formats.js";

const pickOne = { question: "Capital?", options: ["Lagos", "Abuja", "Kano", "Ibadan"], correctIndex: 1 };
const pickAll = { question: "States?", options: ["Kwara", "Accra", "Ekiti", "Lomé"], correctIndexes: [0, 2] };
const order = { question: "Order!", items: ["b", "a", "d", "c"], correctOrder: [1, 0, 3, 2] };
const match = { question: "Match!", left: ["x", "y", "z"], right: ["1", "2", "3"], pairs: [1, 2, 0] };
const picture = { question: "Landmark?", imageUrl: "u", imageAlt: "alt", options: ["A", "B"], correctIndex: 0 };

describe("pick_one / picture", () => {
  it("grades exact match only", () => {
    expect(grade("pick_one", pickOne, { index: 1 })).toBe(1);
    expect(grade("pick_one", pickOne, { index: 0 })).toBe(0);
    expect(grade("picture", picture, { index: 0 })).toBe(1);
    expect(grade("picture", picture, { index: 1 })).toBe(0);
  });
  it("grades malformed answers 0 instead of throwing", () => {
    expect(grade("pick_one", pickOne, { nope: true })).toBe(0);
    expect(grade("pick_one", pickOne, null)).toBe(0);
    expect(grade("pick_one", pickOne, { index: "1" })).toBe(0);
  });
});

describe("pick_all partial credit", () => {
  it("full marks for exactly the right picks", () => {
    expect(grade("pick_all", pickAll, { indexes: [0, 2] })).toBe(1);
    expect(grade("pick_all", pickAll, { indexes: [2, 0] })).toBe(1);
  });
  it("wrong picks subtract", () => {
    expect(grade("pick_all", pickAll, { indexes: [0, 2, 1] })).toBe(0.5); // 2 right − 1 wrong over 2
    expect(grade("pick_all", pickAll, { indexes: [0, 1] })).toBe(0); // 1 right − 1 wrong
  });
  it("floors at zero, never negative", () => {
    expect(grade("pick_all", pickAll, { indexes: [1, 3] })).toBe(0);
  });
  it("duplicate picks count once", () => {
    expect(grade("pick_all", pickAll, { indexes: [0, 0, 2] })).toBe(1);
  });
});

describe("order per position", () => {
  it("scores each correct position", () => {
    expect(grade("order", order, { order: [1, 0, 3, 2] })).toBe(1);
    expect(grade("order", order, { order: [1, 0, 2, 3] })).toBe(0.5);
    expect(grade("order", order, { order: [0, 1, 2, 3] })).toBe(0);
  });
  it("wrong length scores 0", () => {
    expect(grade("order", order, { order: [1, 0] })).toBe(0);
  });
});

describe("match per pair", () => {
  it("scores each correct pair", () => {
    expect(grade("match", match, { pairs: [1, 2, 0] })).toBe(1);
    expect(grade("match", match, { pairs: [1, 0, 2] })).toBeCloseTo(1 / 3);
    expect(grade("match", match, { pairs: [0, 1, 2] })).toBe(0);
  });
});

describe("never leak", () => {
  it("public views carry no correct answers", () => {
    expect(publicView("pick_one", pickOne)).not.toHaveProperty("correctIndex");
    expect(publicView("pick_all", pickAll)).not.toHaveProperty("correctIndexes");
    expect(publicView("order", order)).not.toHaveProperty("correctOrder");
    expect(publicView("match", match)).not.toHaveProperty("pairs");
    expect(publicView("picture", picture)).not.toHaveProperty("correctIndex");
  });
  it("public views keep what players need", () => {
    expect(publicView("order", order)).toHaveProperty("items");
    expect(publicView("match", match)).toMatchObject({ left: match.left, right: match.right });
    expect(publicView("picture", picture)).toMatchObject({ imageUrl: "u", imageAlt: "alt" });
  });
  it("reveal carries exactly the correct answer", () => {
    expect(revealAnswer("pick_one", pickOne)).toEqual({ correctIndex: 1 });
    expect(revealAnswer("order", order)).toEqual({ correctOrder: [1, 0, 3, 2] });
  });
});

describe("distribution", () => {
  it("counts per option including pick_all multi-picks", () => {
    expect(distribution("pick_one", pickOne, [{ index: 1 }, { index: 1 }, { index: 0 }, { bad: 1 }])).toEqual([1, 2, 0, 0]);
    expect(distribution("pick_all", pickAll, [{ indexes: [0, 2] }, { indexes: [0] }])).toEqual([2, 0, 1, 0]);
  });
  it("is null for non-option formats", () => {
    expect(distribution("order", order, [])).toBeNull();
    expect(distribution("match", match, [])).toBeNull();
  });
});

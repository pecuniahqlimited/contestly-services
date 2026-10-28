import { describe, expect, it } from "vitest";
import {
  ARCHETYPES, DEFAULT_ABOUT, aboutConfigSchemaFor, answerProblems, deriveAbout, lanesFrom, onboardingPatchSchema, prefillAnswers, scoreArchetype,
  type AboutConfig,
} from "../src/index.js";

const person = DEFAULT_ABOUT.person;
const opt = (id: string, extra: object = {}) => ({ id, emoji: "•", label: id, ...extra });
const single = (id: string, options: object[]) => ({ id, prompt: id, kind: "single" as const, options });
const issues = (audience: "person" | "brand", config: unknown) => {
  const r = aboutConfigSchemaFor(audience).safeParse(config);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe("about you config validation", () => {
  it("the seeded sets are valid", () => {
    expect(issues("person", DEFAULT_ABOUT.person)).toEqual([]);
    expect(issues("brand", DEFAULT_ABOUT.brand)).toEqual([]);
  });
  it("needs at least one question", () => expect(issues("person", { questions: [] }).length).toBeGreaterThan(0));
  it("question and option ids are unique", () => {
    expect(issues("person", { questions: [single("q", [opt("a"), opt("b")]), single("q", [opt("a"), opt("b")])] })).toContain('question id "q" is used twice');
    expect(issues("person", { questions: [single("q", [opt("a"), opt("a")])] })).toContain('option id "a" is used twice');
  });
  it("min can't be more than the options; max can't be under min", () => {
    const multi = (min: number, max?: number) => ({ questions: [{ id: "m", prompt: "m", kind: "multi", min, max, options: [opt("a"), opt("b")] }] });
    expect(issues("person", multi(3))).toContain("min is more than the number of options");
    expect(issues("person", multi(2, 1))).toContain("max is less than min");
    expect(issues("person", multi(2))).toEqual([]);
  });
  it("min and max are for multi questions only", () => {
    expect(issues("person", { questions: [{ ...single("s", [opt("a"), opt("b")]), min: 1 }] })).toContain("min and max are for multi questions");
  });
  it("weights only for known archetypes, as small integers", () => {
    expect(issues("person", { questions: [single("s", [opt("a", { weights: { wizard: 1 } }), opt("b")])] })).toContain('"wizard" is not an archetype');
    expect(issues("person", { questions: [single("s", [opt("a", { weights: { host: 1.5 } }), opt("b")])] }).length).toBeGreaterThan(0);
    expect(issues("person", { questions: [single("s", [opt("a", { weights: { host: 99 } }), opt("b")])] }).length).toBeGreaterThan(0);
  });
  it("the brand set carries no weights", () => {
    expect(issues("brand", { questions: [single("s", [opt("a", { weights: { host: 1 } }), opt("b")])] })).toContain("brand options carry no weights (brands always host)");
  });
  it("lanes are category tags, normalised", () => {
    const r = aboutConfigSchemaFor("person").parse({ questions: [single("s", [opt("a", { lanes: [" hip  HOP ", "football"] }), opt("b")])] });
    expect(r.questions[0].options[0].lanes).toEqual(["Hip hop", "Football"]);
    expect(issues("person", { questions: [single("s", [opt("a", { lanes: ["Knitting"] }), opt("b")])] }).length).toBeGreaterThan(0);
  });
});

describe("scoreArchetype", () => {
  it("highest summed weight wins", () => {
    expect(scoreArchetype(person, { saturday: ["quiz", "building"], rather: ["vibe"] })).toEqual({ archetype: "fan", totals: { competitor: 0, host: 0, grinder: 2, fan: 3 } });
    expect(scoreArchetype(person, { saturday: ["match"], rather: ["climb"] }).archetype).toBe("grinder");
  });
  it("a tie goes to the earlier archetype in the fixed order", () => {
    // host 1 (cooking) vs fan 1 (afrobeats): host comes first
    expect(scoreArchetype(person, { saturday: ["cooking", "afrobeats"] }).archetype).toBe("host");
    // competitor 3 vs grinder 3 → competitor
    expect(scoreArchetype(person, { saturday: ["quiz", "building", "afrobeats"], rather: ["beat"] }).archetype).toBe("competitor");
    const tied: AboutConfig = { questions: [single("s", [opt("g", { weights: { grinder: 2 } }), opt("f", { weights: { fan: 2 } })]) as never] };
    expect(scoreArchetype(tied, { s: ["f"] }).archetype).toBe("fan");
    expect(ARCHETYPES.indexOf("grinder")).toBeLessThan(ARCHETYPES.indexOf("fan"));
  });
  it("no weights at all is competitor", () => {
    expect(scoreArchetype(DEFAULT_ABOUT.brand, { does: ["tech"], goal: ["reach"] }).archetype).toBe("competitor");
    expect(scoreArchetype(person, {}).archetype).toBe("competitor");
  });
  it("weights of zero don't beat the default", () => {
    const zero: AboutConfig = { questions: [single("s", [opt("a", { weights: { fan: 0 } }), opt("b")]) as never] };
    expect(scoreArchetype(zero, { s: ["a"] }).archetype).toBe("competitor");
  });
});

describe("lanes and deriveAbout", () => {
  it("lanes from every pick, each once, in pick order", () => {
    expect(lanesFrom(DEFAULT_ABOUT.brand, { does: ["fashion", "beauty", "music"], goal: ["launch"] })).toEqual(["Fashion", "Afrobeats", "Hip hop"]);
  });
  it("a brand is always host", () => {
    expect(deriveAbout("brand", DEFAULT_ABOUT.brand, { does: ["food"], goal: ["culture"] })).toMatchObject({ archetype: "host", lanes: ["Food"] });
  });
});

describe("answerProblems", () => {
  it("a complete set of answers has none", () => expect(answerProblems(person, { saturday: ["match", "quiz"], rather: ["beat"] })).toEqual([]));
  it("every question must be answered", () => {
    expect(answerProblems(person, { saturday: ["match"] })).toEqual([{ questionId: "rather", problem: "too_few" }]);
  });
  it("single means exactly one; unknown and repeated ids are refused", () => {
    expect(answerProblems(person, { saturday: ["match"], rather: ["beat", "vibe"] })).toEqual([{ questionId: "rather", problem: "too_many" }]);
    expect(answerProblems(person, { saturday: ["nope"], rather: ["beat"] })).toEqual([{ questionId: "saturday", problem: "unknown_option" }]);
    expect(answerProblems(person, { saturday: ["match", "match"], rather: ["beat"] })).toEqual([{ questionId: "saturday", problem: "duplicate_option" }]);
    expect(answerProblems(person, { saturday: ["match"], rather: ["beat"], extra: ["x"] })).toEqual([{ questionId: "extra", problem: "unknown_question" }]);
  });
  it("an option from another question doesn't count", () => {
    expect(answerProblems(person, { saturday: ["beat"], rather: ["match"] }).map((p) => p.problem)).toEqual(["unknown_option", "unknown_option"]);
  });
});

describe("prefillAnswers (editing from Me against a newer version)", () => {
  it("keeps picks whose question and option still exist, drops the rest", () => {
    const next: AboutConfig = { questions: [
      { ...person.questions[0], options: person.questions[0].options.filter((o) => o.id !== "quiz") },
      single("new", [opt("a"), opt("b")]) as never,
    ] };
    expect(prefillAnswers(next, { saturday: ["match", "quiz"], rather: ["beat"] })).toEqual({ saturday: ["match"] });
  });
  it("nothing earlier, nothing prefilled", () => expect(prefillAnswers(person, null)).toEqual({}));
  it("a multi turned single keeps one pick", () => {
    const next: AboutConfig = { questions: [{ ...person.questions[0], kind: "single", min: undefined }] };
    expect(prefillAnswers(next, { saturday: ["match", "quiz"] })).toEqual({ saturday: ["match"] });
  });
});

describe("onboardingPatchSchema", () => {
  it("takes who, About you answers, or both; not nothing", () => {
    expect(onboardingPatchSchema.safeParse({ who: "person" }).success).toBe(true);
    expect(onboardingPatchSchema.safeParse({ about: { version: 1, answers: { rather: ["beat"] } } }).success).toBe(true);
    expect(onboardingPatchSchema.safeParse({}).success).toBe(false);
  });
});

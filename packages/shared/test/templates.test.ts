import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARTY_TEMPLATES, HOST_WRITTEN_FREE, TEMPLATE_PARTY_FREE, checkHostText, checkHostWrittenStakes, hostQuestionFromPayload, hostQuestionPayload,
  hostQuestionSchema, hostSlots, maxHostQuestions, potCapKobo, partyTemplatesConfigSchema, templatePrefill, templateProblems, type HostWrittenStakesInput,
} from "../src/index.js";

const rules = DEFAULT_PARTY_TEMPLATES.rules;
const stakes = (s: Partial<HostWrittenStakesInput>): HostWrittenStakesInput => ({ funding: "pooled", entryKobo: 50_000, hostPoolKobo: 0, prizeKind: "cash", maxPlayers: 8, questionCount: 10, hostQuestionCount: 0, fromTemplate: false, ...s });

describe("the seeded templates", () => {
  it("parse, and every prompt fits its own question count", () => {
    const cfg = partyTemplatesConfigSchema.parse(DEFAULT_PARTY_TEMPLATES);
    expect(cfg.templates.map((t) => t.id)).toEqual(["birthday", "bridal-shower", "couples", "game-night", "office-party", "reunion"]);
    for (const t of cfg.templates) {
      expect(templateProblems(t, cfg.rules)).toEqual([]);
      expect(t.hostPrompts.length).toBeGreaterThanOrEqual(4);
      expect(t.hostPrompts.length).toBeLessThanOrEqual(6);
    }
  });
  it("refuse a template id used twice", () => {
    const twice = { ...DEFAULT_PARTY_TEMPLATES, templates: [DEFAULT_PARTY_TEMPLATES.templates[0], DEFAULT_PARTY_TEMPLATES.templates[0]] };
    expect(partyTemplatesConfigSchema.safeParse(twice).success).toBe(false);
  });
  it("prefill the create-party fields", () => {
    const t = DEFAULT_PARTY_TEMPLATES.templates[0];
    expect(templatePrefill(t)).toEqual({ title: t.title, brief: t.brief, difficulty: t.dials.difficulty, formats: t.dials.formats, questionCount: t.dials.questionCount, secondsPerQuestion: t.dials.secondsPerQuestion, coverColor: t.cover.color, coverEmoji: t.cover.emoji });
  });
});

describe("host-written questions", () => {
  const q = { question: "Where did Tolu and Femi first meet?", answer: "Church", distractors: ["Office", "Gym", "Wedding"] };
  it("need four different options", () => {
    expect(hostQuestionSchema.safeParse(q).success).toBe(true);
    expect(hostQuestionSchema.safeParse({ ...q, distractors: ["church", "Gym", "Wedding"] }).success).toBe(false);
    expect(hostQuestionSchema.safeParse({ ...q, distractors: ["Gym", "Wedding"] }).success).toBe(false);
  });
  it("store as pick-one with the answer where the server put it, and come back the same", () => {
    const payload = hostQuestionPayload(q, 2);
    expect(payload).toEqual({ question: q.question, options: ["Office", "Gym", "Church", "Wedding"], correctIndex: 2 });
    expect(hostQuestionFromPayload(payload)).toEqual(q);
    expect(() => hostQuestionPayload(q, 4)).toThrow();
  });
  it("go through the safety filter, failing closed", () => {
    expect(checkHostText(q, "").passed).toBe(true);
    expect(checkHostText({ ...q, answer: "the casino" }, "").reasons).toContain("gambling_promo");
    expect(checkHostText({ question: "", answer: "" }, "").passed).toBe(false); // nothing to read
    expect(checkHostText({ ...q, question: "Who did they vote for in the election?" }, "").reasons).toContain("politics");
    expect(checkHostText({ ...q, question: "Which gym do they go to?" }, "a party quiz, nothing about gym").reasons).toContain("excluded:gym");
  });
  it("spread through the play order", () => {
    expect(hostSlots(10, 2)).toEqual([3, 6]);
    expect(hostSlots(10, 5)).toEqual([1, 3, 5, 6, 8]);
    expect(hostSlots(4, 4)).toEqual([0, 1, 2, 3]);
    expect(hostSlots(5, 0)).toEqual([]);
    const s = hostSlots(6, 5);
    expect(new Set(s).size).toBe(5);
    expect(Math.max(...s)).toBeLessThan(6);
  });
});

describe("checkHostWrittenStakes", () => {
  it("refuses free template parties and free parties with host-written questions", () => {
    expect(checkHostWrittenStakes(stakes({ entryKobo: 0, fromTemplate: true }), rules)).toEqual([TEMPLATE_PARTY_FREE]);
    expect(checkHostWrittenStakes(stakes({ entryKobo: 0, hostQuestionCount: 2 }), rules)).toEqual([HOST_WRITTEN_FREE]);
    expect(checkHostWrittenStakes(stakes({ entryKobo: 0 }), rules)).toEqual([]); // an ordinary free party is fine
    expect(checkHostWrittenStakes(stakes({ funding: "host", entryKobo: 0, hostPoolKobo: 100_000, fromTemplate: true }), rules)).toEqual([]);
  });
  it("caps the entry, the host's cash prize and the host's share, only with host-written questions", () => {
    expect(checkHostWrittenStakes(stakes({ entryKobo: rules.maxEntryKobo + 100, hostQuestionCount: 1 }), rules)).toEqual(["host_written_entry_above_cap"]);
    expect(checkHostWrittenStakes(stakes({ entryKobo: rules.maxEntryKobo + 100 }), rules)).toEqual([]);
    // Over the prize cap is over the pot cap too (a host prize is part of the pot).
    expect(checkHostWrittenStakes(stakes({ funding: "host", entryKobo: 0, hostPoolKobo: rules.maxHostPrizeKobo + 100, hostQuestionCount: 1 }), rules)).toEqual(["host_written_prize_above_cap", "host_written_pot_above_cap"]);
    expect(checkHostWrittenStakes(stakes({ hostQuestionCount: 6, questionCount: 10 }), rules)).toEqual(["host_written_share_above_cap"]);
    expect(checkHostWrittenStakes(stakes({ hostQuestionCount: 5, questionCount: 10 }), rules)).toEqual([]);
    expect(maxHostQuestions(5, rules)).toBe(2);
  });

  it("caps the most the pot can reach: every seat's entry plus the host's cash prize", () => {
    // ₦1,000 is within the entry cap, but 200 seats of it is ₦200,000.
    const full = stakes({ entryKobo: rules.maxEntryKobo, maxPlayers: 200, hostQuestionCount: 1 });
    expect(potCapKobo(full)).toBe(rules.maxEntryKobo * 200);
    expect(checkHostWrittenStakes(full, rules)).toEqual(["host_written_pot_above_cap"]);
    const fits = Math.floor(rules.maxPotKobo / rules.maxEntryKobo);
    expect(checkHostWrittenStakes(stakes({ entryKobo: rules.maxEntryKobo, maxPlayers: fits, hostQuestionCount: 1 }), rules)).toEqual([]);
    expect(checkHostWrittenStakes(stakes({ entryKobo: rules.maxEntryKobo, maxPlayers: 200 }), rules)).toEqual([]); // no host-written questions: no cap
    expect(potCapKobo(stakes({ funding: "host", entryKobo: 0, hostPoolKobo: 1_000, maxPlayers: 50 }))).toBe(1_000);
  });
});

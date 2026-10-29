import { describe, expect, it } from "vitest";
import {
  CLIMB_GAME_TYPES, DEFAULT_CLIMB_LADDER, climbLadderSchema, climbViewSchemas, climbRevealSchemas, ladderSummary, stageLevel,
  type ClimbGameType, type ClimbLadder, type ClimbLadderInput, type ClimbWordEntry, type ClimbWordGame,
} from "@contestly/shared";
import {
  afterRound, challengePoints, closesAt, competitionRanks, expired, generateRound, gradeRound, inGrid, nextOpensAt, onTime,
  NoWordsFit, pickRoundType, roundReveal, roundView, roundWords, seeded, stageOutcome, weekPlaces, weeklyAwards, wordGameOf, wordSupplyIssues, wordWarnings,
} from "../src/index.js";
import { WORDS } from "./fixtures/words.js";

const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);
const STAGES = 5;

/** A five-stage ladder playing only `type`, with `settings` (per stage index) over the defaults. */
function ladderOf(type: ClimbGameType, settings: (i: number) => Record<string, unknown> = () => ({}), seconds = 10): ClimbLadder {
  return climbLadderSchema.parse({
    stages: Array.from({ length: STAGES }, (_, i) => ({ types: [type], rounds: 3, toClear: 2, seconds, points: 10, settings: { [type]: settings(i) } })),
    enabledTypes: [type],
  } satisfies ClimbLadderInput);
}

/** A round of `type` at a stage and round, with the starter list for any word game. */
const round = (type: ClimbGameType, seed: number, stageIdx = 0, roundIdx = 0, ladder = ladderOf(type), seen: Set<string> = new Set()) =>
  generateRound(ladder.stages[stageIdx], type, roundIdx, { rng: seeded(seed), words: WORDS, history: { seen, recent: seen } });

/** The answer a perfect player would send, built from the reveal. */
function perfectAnswer(type: ClimbGameType, payload: any, seed = 0): unknown {
  const reveal = roundReveal(type, payload) as any;
  switch (type) {
    case "pattern": return { index: reveal.correctIndex };
    case "scramble": return { word: reveal.word.toUpperCase() };
    case "word_hunt": return { words: reveal.words };
    case "quick_maths": return { value: reveal.value };
    case "memory": return { sequence: reveal.sequence };
    case "pattern_recall": return { sequence: reveal.sequence };
    // Odd seeds select every other word backwards: the line counts either way.
    case "word_search": return { found: reveal.placements.map((p: any, i: number) => ({ word: p.word, cells: (seed + i) % 2 ? [...p.cells].reverse() : p.cells })) };
  }
}

describe("every game type", () => {
  for (const type of CLIMB_GAME_TYPES) {
    describe(type, () => {
      it("generates rounds whose view and reveal match the shared shapes, and grades its own answer right", () => {
        for (const seed of SEEDS) for (let stage = 0; stage < STAGES; stage++) for (let r = 0; r < 3; r++) {
          const { payload, seconds } = round(type, seed, stage, r);
          expect(climbViewSchemas[type].safeParse(roundView(type, payload)).success).toBe(true);
          expect(climbRevealSchemas[type].safeParse(roundReveal(type, payload)).success).toBe(true);
          expect(gradeRound(type, payload, perfectAnswer(type, payload, seed))).toBe(true);
          expect(Number.isInteger(seconds) && seconds > 0).toBe(true);
        }
      });
      it("is deterministic for a seed", () => {
        expect(round(type, 7, 2, 1)).toEqual(round(type, 7, 2, 1));
      });
      it("grades a malformed answer wrong instead of throwing", () => {
        const { payload } = round(type, 3);
        expect(gradeRound(type, payload, null)).toBe(false);
        expect(gradeRound(type, payload, { nonsense: true })).toBe(false);
      });
    });
  }
});

describe("views never carry the answer", () => {
  /** Recall games show their sequence by design (the sequence is the game), so they're left out. */
  const hidden: Partial<Record<ClimbGameType, string[]>> = {
    pattern: ["correctIndex"], scramble: ["word", "alternatives"], word_hunt: ["placed", "accepted"], quick_maths: ["value"], word_search: ["placements", "cells"],
  };
  for (const [type, keys] of Object.entries(hidden) as [ClimbGameType, string[]][]) {
    it(`${type} keeps ${keys.join(", ")} on the server`, () => {
      for (const seed of SEEDS) {
        const json = JSON.stringify(roundView(type, round(type, seed, seed % STAGES).payload));
        for (const k of keys) expect(json).not.toContain(`"${k}"`);
      }
    });
  }
  it("quick maths shows the sum, not the value", () => {
    const { payload } = round("quick_maths", 1, 4) as any;
    expect(roundView("quick_maths", payload)).toEqual({ expression: payload.expression });
  });
  it("scramble arrangements are the word's letters and never spell the answer or another listed word", () => {
    const listed = new Set(WORDS);
    for (const seed of SEEDS) for (let stage = 0; stage < STAGES; stage++) {
      const { payload } = round("scramble", seed, stage) as any;
      const v: any = roundView("scramble", payload);
      expect(v.letters).toEqual(v.arrangements[0]);
      expect(v.arrangements.length).toBeGreaterThan(1);
      expect(new Set(v.arrangements.map((a: string[]) => a.join(""))).size).toBe(v.arrangements.length);
      for (const a of v.arrangements) {
        expect([...a].sort()).toEqual([...payload.word].sort());
        expect(a.join("")).not.toBe(payload.word);
        expect(listed.has(a.join(""))).toBe(false);
      }
    }
  });
  it("word search lists its words alphabetically, so the order says nothing about where they are", () => {
    const v: any = roundView("word_search", round("word_search", 5, 3).payload);
    expect(v.words).toEqual([...v.words].sort());
  });
});

describe("graders", () => {
  it("pattern: the next term, and only that", () => {
    const p = { sequence: [2, 4, 6, 8, 10], options: [11, 12, 14, 9], correctIndex: 1 };
    expect(gradeRound("pattern", p, { index: 1 })).toBe(true);
    expect(gradeRound("pattern", p, { index: 0 })).toBe(false);
  });
  it("scramble: case and spaces don't matter; an anagram counts only if it was on the list when the round was made; partial is wrong", () => {
    const p = { word: "lemon", letters: ["m", "o", "l", "e", "n"], alternatives: ["melon"] };
    expect(gradeRound("scramble", p, { word: " LEMON " })).toBe(true);
    expect(gradeRound("scramble", p, { word: "melon" })).toBe(true);
    expect(gradeRound("scramble", { ...p, alternatives: [] }, { word: "melon" })).toBe(false);
    expect(gradeRound("scramble", p, { word: "lem" })).toBe(false);
    expect(gradeRound("scramble", p, { word: "lemonn" })).toBe(false);
  });
  it("scramble records the listed anagrams of its word", () => {
    const ladder = ladderOf("scramble", () => ({ minLength: 5, maxLength: 5 }));
    const { payload } = generateRound(ladder.stages[0], "scramble", 0, { rng: seeded(1), words: ["lemon", "melon"] }) as any;
    expect(payload.alternatives).toEqual([payload.word === "lemon" ? "melon" : "lemon"]);
  });
  it("word hunt: enough different listed words that are really in the grid", () => {
    const grid = ["catxxx", "xxxxxx", "dogxxx", "xxxxxx", "xxxxxx", "xxxxxx"];
    const p = { grid, placed: ["cat", "dog"], find: 2, minLength: 3, accepted: ["cat", "dog"] };
    expect(gradeRound("word_hunt", p, { words: ["cat", "dog"] })).toBe(true);
    expect(gradeRound("word_hunt", p, { words: ["cat", "CAT"] })).toBe(false); // the same word twice is one
    expect(gradeRound("word_hunt", p, { words: ["cat", "sun"] })).toBe(false); // listed but not in the grid
    expect(gradeRound("word_hunt", p, { words: ["cat", "xxx"] })).toBe(false); // in the grid but not a word
  });
  it("word hunt accepts listed words the filler spelled, fixed when the round was made", () => {
    for (const seed of SEEDS) {
      const { payload } = round("word_hunt", seed, 2) as any;
      for (const w of payload.accepted) expect(inGrid(payload.grid, w) && WORDS.includes(w)).toBe(true);
      expect(payload.accepted).toEqual(expect.arrayContaining(payload.placed));
    }
  });
  it("word hunt finds words in all eight directions", () => {
    const grid = ["tac", "xox", "gxd"];
    expect(inGrid(grid, "cat")).toBe(true); // right to left
    expect(inGrid(grid, "god")).toBe(false);
    expect(inGrid(["dxx", "xox", "xxg"], "dog")).toBe(true); // diagonal
    expect(inGrid(["gxx", "xox", "xxd"], "dog")).toBe(true); // diagonal, backwards
  });
  it("memory: the whole sequence, in order", () => {
    const p = { symbols: 4, sequence: [0, 3, 1], showMs: 1800 };
    expect(gradeRound("memory", p, { sequence: [0, 3, 1] })).toBe(true);
    expect(gradeRound("memory", p, { sequence: [0, 3] })).toBe(false);
    expect(gradeRound("memory", p, { sequence: [0, 1, 3] })).toBe(false);
  });
  it("pattern recall: an exact match only; a sequence cut short by a wrong tap is wrong", () => {
    const p = { gridSize: 3, sequence: [4, 0, 8], msPerTile: 600 };
    expect(gradeRound("pattern_recall", p, { sequence: [4, 0, 8] })).toBe(true);
    expect(gradeRound("pattern_recall", p, { sequence: [4, 1] })).toBe(false);
    expect(gradeRound("pattern_recall", p, { sequence: [4, 0, 8, 2] })).toBe(false);
  });
  it("word search: right only when every word is found on its own cells, either way along the line", () => {
    const p = {
      grid: ["catxxx", "oxxxxx", "gxxxxx", "xxxxxx", "xxxxxx", "xxxxxx"], directions: "straight",
      placements: [{ word: "cat", cells: [[0, 0], [0, 1], [0, 2]] }, { word: "cog", cells: [[0, 0], [1, 0], [2, 0]] }],
    };
    const cat = { word: "cat", cells: [[0, 0], [0, 1], [0, 2]] };
    const gocBackwards = { word: "cog", cells: [[2, 0], [1, 0], [0, 0]] };
    expect(gradeRound("word_search", p, { found: [cat, gocBackwards] })).toBe(true);
    expect(gradeRound("word_search", p, { found: [cat] })).toBe(false); // one missing
    expect(gradeRound("word_search", p, { found: [cat, { word: "cog", cells: [[0, 0], [1, 0]] }] })).toBe(false); // short
    expect(gradeRound("word_search", p, { found: [cat, { word: "cog", cells: [[0, 0], [1, 1], [2, 2]] }] })).toBe(false); // wrong cells
  });
});

describe("pattern recall rounds", () => {
  it("never repeat a tile, and the length is capped at the tiles", () => {
    const ladder = ladderOf("pattern_recall", () => ({ gridSize: 3, length: 25 }));
    for (const seed of SEEDS) {
      const { payload } = round("pattern_recall", seed, 0, 0, ladder) as any;
      expect(payload.sequence).toHaveLength(9);
      expect(new Set(payload.sequence).size).toBe(9);
      expect(Math.max(...payload.sequence)).toBeLessThan(9);
    }
  });
  it("grow across the stage's rounds: 3 → 6 by default", () => {
    const lengths = [0, 1, 2].map((r) => (round("pattern_recall", 1, 4, r).payload as any).sequence.length);
    expect(lengths).toEqual([3, 5, 6]); // 3 + (6 − 3) × ½ rounds to 5
  });
  it("last the show time plus the seconds to repeat, rounded up to a whole second", () => {
    const ladder = ladderOf("pattern_recall", () => ({ gridSize: 4, length: 5, msPerTile: 700, secondsToRepeat: 8 }));
    expect(round("pattern_recall", 1, 0, 0, ladder).seconds).toBe(12); // 3.5 s + 8 s
    const noRepeat = ladderOf("pattern_recall", () => ({ gridSize: 4, length: 5, msPerTile: 600 }), 9);
    expect(round("pattern_recall", 1, 0, 0, noRepeat).seconds).toBe(12); // 3 s + the stage's 9 s
  });
});

describe("word search rounds", () => {
  const ladder = ladderOf("word_search", () => ({ gridSize: 8, words: 6, minLength: 4, maxLength: 7, directions: "all", secondsPerWord: 20 }));
  it("hide the asked-for words, each fitting the lengths, each in the grid exactly once", () => {
    for (const seed of SEEDS) {
      const { payload, seconds } = round("word_search", seed, 0, 0, ladder) as any;
      expect(payload.placements).toHaveLength(6);
      expect(seconds).toBe(120);
      for (const p of payload.placements) {
        expect(p.word.length).toBeGreaterThanOrEqual(4);
        expect(p.word.length).toBeLessThanOrEqual(7);
        expect(p.cells.map(([r, c]: number[]) => payload.grid[r][c]).join("")).toBe(p.word);
      }
    }
  });
  it("place only straight lines right and down when the stage says straight", () => {
    const straight = ladderOf("word_search", () => ({ directions: "straight" }));
    for (const seed of SEEDS) for (const p of (round("word_search", seed, 0, 0, straight).payload as any).placements) {
      const [[r0, c0], [r1, c1]] = p.cells;
      expect([[0, 1], [1, 0]]).toContainEqual([r1 - r0, c1 - c0]);
    }
  });
  it("place fewer words when the list can't supply them, and the clock scales with the words placed", () => {
    const words = ["mango", "guava", "lemon"];
    const { payload, seconds } = generateRound(ladder.stages[0], "word_search", 0, { rng: seeded(2), words }) as any;
    expect(payload.placements).toHaveLength(3);
    expect(seconds).toBe(60);
  });
  it("never reuse a word used earlier in the run", () => {
    const used = new Set<string>();
    for (let r = 0; r < 4; r++) {
      const { payload } = round("word_search", r + 1, 0, 0, ladder, used);
      for (const w of roundWords("word_search", payload)) {
        expect(used.has(w)).toBe(false);
        used.add(w);
      }
    }
  });
  it("grow across rounds and stages as the settings ramp", () => {
    const ramped = ladderOf("word_search", (i) => ({ gridSize: 10, words: { first: 3, last: 7 }, secondsPerWord: i === 1 ? 25 : 15, minLength: 3, maxLength: 8 }));
    expect([0, 1, 2].map((r) => (round("word_search", 3, 1, r, ramped).payload as any).placements.length)).toEqual([3, 5, 7]);
    expect(round("word_search", 3, 1, 0, ramped).seconds).toBe(75); // 3 words × 25 s in stage 2
    expect(round("word_search", 3, 3, 0, ramped).seconds).toBe(45); // 3 words × 15 s in stage 4
  });
});

describe("per-stage settings", () => {
  it("the stage's seconds are the clock unless the type sets its own", () => {
    expect(round("scramble", 1, 0, 0, ladderOf("scramble", () => ({}), 14)).seconds).toBe(14);
    expect(round("scramble", 1, 0, 0, ladderOf("scramble", () => ({ seconds: 9 }), 14)).seconds).toBe(9);
    expect(round("scramble", 1, 0, 2, ladderOf("scramble", () => ({ seconds: { first: 20, last: 10 } }), 14)).seconds).toBe(10);
  });
  it("scramble picks words of the stage's lengths, and the same type can be easy in stage 1 and hard in stage 4", () => {
    const ladder = ladderOf("scramble", (i) => (i === 0 ? { minLength: 3, maxLength: 4 } : { minLength: 7, maxLength: 8 }));
    for (const seed of SEEDS) {
      expect((round("scramble", seed, 0, 0, ladder).payload as any).word.length).toBeLessThanOrEqual(4);
      expect((round("scramble", seed, 3, 0, ladder).payload as any).word.length).toBeGreaterThanOrEqual(7);
    }
  });
  it("memory length ramps by round within a stage", () => {
    const ladder = ladderOf("memory", () => ({ length: { first: 4, last: 8 } }));
    expect([0, 1, 2].map((r) => (round("memory", 1, 0, r, ladder).payload as any).sequence.length)).toEqual([4, 6, 8]);
  });
  it("quick maths plays only the forms the stage allows", () => {
    const ladder = ladderOf("quick_maths", () => ({ forms: ["divide"] }));
    for (const seed of SEEDS) expect((round("quick_maths", seed, 0, 0, ladder).payload as any).expression).toContain("÷");
  });
});

describe("defaults reproduce the ladder before settings existed", () => {
  const s = DEFAULT_CLIMB_LADDER.stages;
  it("every stage carries a block for each type it lists", () => {
    for (const stage of s) expect(Object.keys(stage.settings).sort()).toEqual([...stage.types].sort());
  });
  it("the old level scales, stage by stage", () => {
    expect(s[0].settings.pattern).toEqual({ difficulty: 1 });
    expect(s[1].settings.pattern).toEqual({ difficulty: 2 });
    expect(s[1].settings.scramble).toEqual({ minLength: 5, maxLength: 6 }); // level 0.25: 4 + 0.75 → 5, and one longer
    expect(s[2].settings.word_hunt).toEqual({ gridSize: 7, find: 3, minLength: 3, directions: "all" });
    expect(s[3].settings.quick_maths).toEqual({ forms: ["add", "subtract", "multiply", "divide", "multiply_add", "bracket", "big_multiply"] });
    expect(s[4].settings.memory).toEqual({ length: 8, symbols: 4, msPerSymbol: 600 });
    expect(s[4].settings.quick_maths?.forms).toHaveLength(7);
  });
  it("memory still shows for at most half the clock", () => {
    const { payload } = generateRound(s[4], "memory", 0, { rng: seeded(1) }) as any;
    expect(payload.sequence).toHaveLength(8);
    expect(payload.showMs).toBe(4800);
    expect(generateRound({ ...s[4], seconds: 6 }, "memory", 0, { rng: seeded(1) }).payload).toMatchObject({ showMs: 3000 });
  });
  it("a ladder saved before settings parses to the same thing as the default", () => {
    const old = { ...DEFAULT_CLIMB_LADDER, stages: DEFAULT_CLIMB_LADDER.stages.map(({ settings: _s, ...rest }) => rest) };
    expect(climbLadderSchema.parse(old)).toEqual(DEFAULT_CLIMB_LADDER);
  });
});

describe("word supply", () => {
  const entries = (words: readonly string[], games: ClimbWordGame[] = ["scramble", "word_search", "word_hunt"]): ClimbWordEntry[] => words.map((word) => ({ word, games }));
  it("the default ladder is fine on the starter list", () => {
    expect(wordWarnings(DEFAULT_CLIMB_LADDER, entries(WORDS))).toEqual([]);
  });
  it("warns when word search needs more long words than the list has", () => {
    const ladder = ladderOf("word_search", (i) => (i === 3 ? { gridSize: 10, words: 8, minLength: 7, maxLength: 10 } : {}));
    const w = wordWarnings(ladder, entries(WORDS));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ stage: 4, type: "word_search", round: 1, minLength: 7, maxLength: 10, needed: 24 });
    expect(w[0].available).toBeLessThan(24);
    expect(w[0]).toMatchObject({ blocking: false });
    expect(w[0].message).toMatch(/^Stage 4, Word search: round 1 needs 24 7–10 letter words; the active list has \d+\. Runs will use other lengths or repeat words\.$/);
  });
  it("warns about 9-letter scrambles, and counts only words allowed for the game", () => {
    const ladder = ladderOf("scramble", (i) => (i === 0 ? { minLength: 9, maxLength: 9 } : {}));
    // Stage 5's default (7–8 letters) is short too: the starter list has one such word.
    expect(wordWarnings(ladder, entries(WORDS)).map((w) => [w.stage, w.needed, w.available])).toEqual([[1, 3, 0], [5, 3, 1]]);
    expect(wordWarnings(ladderOf("scramble"), entries(WORDS, ["word_hunt"]))).toHaveLength(STAGES);
  });
  it("ignores games that don't use words, and types switched off", () => {
    expect(wordGameOf("quick_maths")).toBeUndefined();
    const off = { ...ladderOf("scramble", () => ({ minLength: 12, maxLength: 12 })), enabledTypes: ["scramble", "pattern"] as ClimbGameType[] };
    expect(wordWarnings({ ...off, enabledTypes: ["pattern"] }, entries(WORDS))).toEqual([]);
  });
});

describe("a short word list never stops a run", () => {
  const entriesOf = (words: readonly string[]): ClimbWordEntry[] => words.map((word) => ({ word, games: ["scramble", "word_search", "word_hunt"] }));
  const nine = ladderOf("scramble", () => ({ minLength: 9, maxLength: 9 }));
  const made = (ladder: ClimbLadder, type: ClimbGameType, words: readonly string[], seen: string[] = [], recent: string[] = [], seed = 1) =>
    generateRound(ladder.stages[0], type, 0, { rng: seeded(seed), words, history: { seen: new Set([...seen, ...recent]), recent: new Set(recent) } });

  it("uses the stage's lengths and fresh words when it can, and says it didn't fall back", () => {
    const r = made(ladderOf("scramble", () => ({ minLength: 5, maxLength: 5 })), "scramble", WORDS);
    expect(r.words).toMatchObject({ minLength: 5, maxLength: 5, freshness: "unseen", fallback: false });
  });
  it("widens to the nearest lengths first", () => {
    const words = ["planet", "garden", "computer", "tomatoes", "cat"];
    for (const seed of SEEDS) {
      const r = made(nine, "scramble", words, [], [], seed);
      expect((r.payload as any).word.length).toBe(8);
      expect(r.words).toMatchObject({ minLength: 8, maxLength: 10, freshness: "unseen", fallback: true, asked: { minLength: 9, maxLength: 9 } });
    }
  });
  it("then words met before but not in the last few runs, then any word", () => {
    const words = ["computer", "tomatoes", "elephant"];
    const older = made(nine, "scramble", words, words, ["computer", "tomatoes"]);
    expect((older.payload as any).word).toBe("elephant");
    expect(older.words).toMatchObject({ freshness: "not_recent", fallback: true });
    const any = made(nine, "scramble", words, [], words);
    expect(words).toContain((any.payload as any).word);
    expect(any.words).toMatchObject({ freshness: "any" });
  });
  it("word search widens within what fits the grid, and word hunt never below the length that counts", () => {
    const ws = ladderOf("word_search", () => ({ gridSize: 6, words: 3, minLength: 6, maxLength: 6, secondsPerWord: 10 }));
    const r = made(ws, "word_search", ["mango", "lemon", "guava", "bananas", "pineapple"]);
    expect((r.payload as any).placements.map((p: any) => p.word).sort()).toEqual(["guava", "lemon", "mango"]);
    expect(r.words).toMatchObject({ minLength: 5, maxLength: 6 });
    const hunt = ladderOf("word_hunt", () => ({ minLength: 4, find: 1 }));
    expect(() => made(hunt, "word_hunt", ["cat", "dog", "sun"])).toThrow(NoWordsFit);
  });
  it("only an empty list (for the game) fails", () => {
    expect(() => made(nine, "scramble", [])).toThrow(NoWordsFit);
    expect(() => made(ladderOf("word_search"), "word_search", [])).toThrow(NoWordsFit);
    expect(() => made(ladderOf("word_hunt"), "word_hunt", [])).toThrow(NoWordsFit);
  });
  it("the editor blocks a stage the list can't supply at any length, at that stage's settings", () => {
    const ladder = ladderOf("word_search", (i) => (i === 1 ? { gridSize: 6, words: 10 } : {}));
    const words = WORDS.slice(0, 20).map((word) => ({ word, games: ["word_search" as const] }));
    const w = wordWarnings(ladder, words).find((x) => x.stage === 2)!;
    expect(w).toMatchObject({ blocking: true, needed: 30, availableWidened: 20 });
    expect(w.message).toMatch(/Even at 3–6 letter words it has only 20: add words or change the settings to save\.$/);
    expect(wordSupplyIssues([w], ["ladder"])).toEqual([{ code: "custom", path: ["ladder", "stages", 1, "settings", "word_search"], message: w.message }]);
    expect(wordSupplyIssues(wordWarnings(DEFAULT_CLIMB_LADDER, entriesOf(WORDS)))).toEqual([]);
  });
});

describe("stage outcome is decided as soon as it's certain", () => {
  const twoOfThree = { rounds: 3, toClear: 2 };
  it.each([
    [[true], "continue"], [[false], "continue"], [[true, true], "cleared"], [[false, false], "missed"],
    [[true, false], "continue"], [[true, false, true], "cleared"], [[true, false, false], "missed"],
  ] as const)("2 of 3 after %j → %s", (results, outcome) => expect(stageOutcome(twoOfThree, results)).toBe(outcome));
  it("3 of 3: one miss ends it", () => {
    expect(stageOutcome({ rounds: 3, toClear: 3 }, [true, false])).toBe("missed");
    expect(stageOutcome({ rounds: 3, toClear: 3 }, [true, true, true])).toBe("cleared");
  });
});

describe("a run up the default ladder", () => {
  const ladder = DEFAULT_CLIMB_LADDER;
  const start = { stageIdx: 0, stagesCleared: 0, points: 0 };
  it("clearing a stage banks its points and moves up", () => {
    const step = afterRound(ladder, start, [true, true]);
    expect(step).toEqual({ outcome: "cleared", ended: false, position: { stageIdx: 1, stagesCleared: 1, points: 10 } });
  });
  it("missing a stage ends the run and keeps what was banked", () => {
    const step = afterRound(ladder, { stageIdx: 2, stagesCleared: 2, points: 30 }, [false, false]);
    expect(step).toEqual({ outcome: "missed", ended: true, position: { stageIdx: 2, stagesCleared: 2, points: 30 } });
  });
  it("clearing the last stage ends the run with every stage's points", () => {
    const step = afterRound(ladder, { stageIdx: 4, stagesCleared: 4, points: 100 }, [true, true, true]);
    expect(step).toEqual({ outcome: "cleared", ended: true, position: { stageIdx: 4, stagesCleared: 5, points: 150 } });
  });
  it("a round in the middle of a stage changes nothing", () => {
    expect(afterRound(ladder, start, [true])).toEqual({ outcome: "continue", ended: false, position: start });
  });
  it("the admin summary matches the canvas: 15 rounds, 3 min 36 s, 150 points", () => {
    expect(ladderSummary(ladder)).toEqual({ rounds: 15, maxSeconds: 216, maxPoints: 150 });
  });
  it("the summary counts each round's computed time: word search is words × seconds per word", () => {
    const ws = ladderOf("word_search", () => ({ words: { first: 3, last: 5 }, secondsPerWord: 10 }));
    expect(ladderSummary(ws).maxSeconds).toBe(STAGES * (30 + 40 + 50));
    const mixed: ClimbLadder = { ...DEFAULT_CLIMB_LADDER, stages: DEFAULT_CLIMB_LADDER.stages.map((st, i) => (i === 0 ? { ...st, types: ["pattern", "pattern_recall"], settings: { ...st.settings, pattern_recall: { gridSize: 3, length: 4, msPerTile: 500, secondsToRepeat: 20 } } } : st)) };
    expect(ladderSummary(mixed).maxSeconds).toBe(216 - 45 + 3 * 22); // stage 1's longest round is now recall's 2 s + 20 s
  });
  it("stage level runs 0 → 1, and a one-stage ladder is level 0", () => {
    expect([0, 1, 2, 3, 4].map((i) => stageLevel(i, 5))).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(stageLevel(0, 1)).toBe(0);
  });
  it("a round only picks types that are switched on", () => {
    const l: ClimbLadder = { ...ladder, enabledTypes: ["quick_maths"] };
    for (const seed of SEEDS) expect(pickRoundType(l, 4, seeded(seed))).toBe("quick_maths");
  });
});

describe("round timing uses server times only", () => {
  it("an answer counts up to the clock's end plus the allowance", () => {
    const close = closesAt(1_000, 10);
    expect(close).toBe(11_000);
    expect(onTime(12_500, close, 1500)).toBe(true);
    expect(onTime(12_501, close, 1500)).toBe(false);
    expect(expired(12_501, close, 1500)).toBe(true);
  });
  it("the next round waits for the verdict, longer after a cleared stage", () => {
    const pauses = { revealSeconds: 2, stageBreakSeconds: 4 };
    expect(nextOpensAt(0, "continue", pauses)).toBe(2000);
    expect(nextOpensAt(0, "cleared", pauses)).toBe(4000);
  });
});

describe("Today's challenge points", () => {
  it("shares the maximum over the questions", () => {
    expect(challengePoints(5, 5, 100)).toBe(100);
    expect(challengePoints(2, 3, 100)).toBe(67);
    expect(challengePoints(0, 5, 100)).toBe(0);
    expect(challengePoints(0, 0, 100)).toBe(0);
  });
});

describe("boards and weekly prizes", () => {
  it("equal points share a rank", () => {
    const ranked = competitionRanks([{ userId: "a", points: 10 }, { userId: "b", points: 30 }, { userId: "c", points: 10 }]);
    expect(ranked.map((r) => [r.userId, r.rank])).toEqual([["b", 1], ["a", 2], ["c", 2]]);
  });
  it("week places break ties by who got there first; nobody on zero places", () => {
    const at = (m: number) => new Date(Date.UTC(2026, 9, 19, 12, m));
    const places = weekPlaces([
      { userId: "late", points: 50, reachedAt: at(30) },
      { userId: "early", points: 50, reachedAt: at(10) },
      { userId: "top", points: 90, reachedAt: at(50) },
      { userId: "none", points: 0, reachedAt: at(0) },
    ]);
    expect(places.map((p) => [p.userId, p.place])).toEqual([["top", 1], ["early", 2], ["late", 3]]);
  });
  it("awards go to the top places that have a prize, and fewer players means fewer awards", () => {
    const at = new Date();
    const places = weekPlaces([{ userId: "a", points: 9, reachedAt: at }, { userId: "b", points: 8, reachedAt: at }]);
    expect(weeklyAwards(places, [500, 300, 100])).toEqual([
      { userId: "a", place: 1, points: 9, amountKobo: 500 },
      { userId: "b", place: 2, points: 8, amountKobo: 300 },
    ]);
    expect(weeklyAwards(places, [])).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { CLIMB_GAME_TYPES, DEFAULT_CLIMB_LADDER, climbViewSchemas, climbRevealSchemas, ladderSummary, type ClimbGameType, type ClimbLadder } from "@contestly/shared";
import {
  afterRound, challengePoints, closesAt, competitionRanks, expired, generateRound, gradeRound, inGrid, nextOpensAt, onTime,
  pickRoundType, roundReveal, roundView, seeded, stageLevel, stageOutcome, weekPlaces, weeklyAwards, WORDS,
} from "../src/index.js";

const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);
const LEVELS = [0, 0.25, 0.5, 0.75, 1];

/** The answer a perfect player would send, built from the reveal. */
function perfectAnswer(type: ClimbGameType, payload: any): unknown {
  const reveal = roundReveal(type, payload) as any;
  switch (type) {
    case "pattern": return { index: reveal.correctIndex };
    case "scramble": return { word: reveal.word.toUpperCase() };
    case "word_hunt": return { words: reveal.words };
    case "quick_maths": return { value: reveal.value };
    case "memory": return { sequence: reveal.sequence };
  }
}

describe("every game type", () => {
  for (const type of CLIMB_GAME_TYPES) {
    describe(type, () => {
      it("generates rounds whose view and reveal match the shared shapes, and grades its own answer right", () => {
        for (const seed of SEEDS) for (const level of LEVELS) {
          const payload = generateRound(type, { rng: seeded(seed), level, seconds: 10 });
          expect(climbViewSchemas[type].safeParse(roundView(type, payload)).success).toBe(true);
          expect(climbRevealSchemas[type].safeParse(roundReveal(type, payload)).success).toBe(true);
          expect(gradeRound(type, payload, perfectAnswer(type, payload))).toBe(true);
        }
      });
      it("is deterministic for a seed", () => {
        const a = generateRound(type, { rng: seeded(7), level: 0.5, seconds: 10 });
        const b = generateRound(type, { rng: seeded(7), level: 0.5, seconds: 10 });
        expect(a).toEqual(b);
      });
      it("grades a malformed answer wrong instead of throwing", () => {
        const payload = generateRound(type, { rng: seeded(3), level: 0, seconds: 10 });
        expect(gradeRound(type, payload, null)).toBe(false);
        expect(gradeRound(type, payload, { nonsense: true })).toBe(false);
      });
    });
  }
});

describe("views never carry the answer", () => {
  it("pattern hides which option is right", () => {
    const p: any = generateRound("pattern", { rng: seeded(1), level: 0, seconds: 10 });
    expect(roundView("pattern", p)).not.toHaveProperty("correctIndex");
  });
  it("scramble shows letters, never the word, and never already spelled", () => {
    for (const seed of SEEDS) {
      const p: any = generateRound("scramble", { rng: seeded(seed), level: 0.5, seconds: 10 });
      const v: any = roundView("scramble", p);
      expect(v).not.toHaveProperty("word");
      expect(v.letters.join("")).not.toBe(p.word);
      expect([...v.letters].sort()).toEqual([...p.word].sort());
    }
  });
  it("quick maths shows the sum, not the value", () => {
    const p: any = generateRound("quick_maths", { rng: seeded(1), level: 1, seconds: 10 });
    expect(roundView("quick_maths", p)).toEqual({ expression: p.expression });
  });
  it("word hunt shows the grid, not the words it was built around", () => {
    const p: any = generateRound("word_hunt", { rng: seeded(1), level: 0, seconds: 20 });
    expect(roundView("word_hunt", p)).not.toHaveProperty("placed");
  });
});

describe("graders", () => {
  it("pattern: the next term, and only that", () => {
    const p = { sequence: [2, 4, 6, 8, 10], options: [11, 12, 14, 9], correctIndex: 1 };
    expect(gradeRound("pattern", p, { index: 1 })).toBe(true);
    expect(gradeRound("pattern", p, { index: 0 })).toBe(false);
  });
  it("scramble: case and spaces don't matter; another listed word from the same letters counts", () => {
    const p = { word: "lemon", letters: ["m", "o", "l", "e", "n"] };
    expect(gradeRound("scramble", p, { word: " LEMON " })).toBe(true);
    expect(gradeRound("scramble", p, { word: "melon" })).toBe(false); // not on the list
    expect(gradeRound("scramble", p, { word: "lemonn" })).toBe(false);
  });
  it("word hunt: enough different listed words that are really in the grid", () => {
    const grid = ["catxxx", "xxxxxx", "dogxxx", "xxxxxx", "xxxxxx", "xxxxxx"];
    const p = { grid, placed: ["cat", "dog"], find: 2, minLength: 3 };
    expect(gradeRound("word_hunt", p, { words: ["cat", "dog"] })).toBe(true);
    expect(gradeRound("word_hunt", p, { words: ["cat", "CAT"] })).toBe(false); // the same word twice is one
    expect(gradeRound("word_hunt", p, { words: ["cat", "sun"] })).toBe(false); // listed but not in the grid
    expect(gradeRound("word_hunt", p, { words: ["cat", "xxx"] })).toBe(false); // in the grid but not a word
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
  it("memory gets longer with the level and always leaves time to answer", () => {
    const short: any = generateRound("memory", { rng: seeded(1), level: 0, seconds: 10 });
    const long: any = generateRound("memory", { rng: seeded(1), level: 1, seconds: 10 });
    expect(long.sequence.length).toBeGreaterThan(short.sequence.length);
    expect(long.showMs).toBeLessThanOrEqual(5000);
  });
  it("the word list is lowercase letters only and has no repeats", () => {
    expect(WORDS.every((w) => /^[a-z]+$/.test(w))).toBe(true);
    expect(new Set(WORDS).size).toBe(WORDS.length);
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

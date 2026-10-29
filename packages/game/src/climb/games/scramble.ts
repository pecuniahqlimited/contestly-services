import { z } from "zod";
import type { ClimbGame } from "../types.js";
import { shuffle, type Rng } from "../rng.js";
import { NoWordsFit } from "../wordPool.js";
import { CLIMB_WORD_LENGTH, SCRAMBLE_ARRANGEMENTS } from "@contestly/shared";

/** Shuffles tried per word to find arrangements that don't spell a word. */
const SHUFFLE_TRIES = 40;

const payloadSchema = z.object({
  word: z.string(),
  letters: z.array(z.string().length(1)),
  /** Shuffle's arrangements; `letters` is the first. Absent on rounds made before Shuffle existed. */
  arrangements: z.array(z.array(z.string().length(1))).optional(),
  /** Other listed words made of exactly the same letters, which count too. Absent on rounds made before the admin list. */
  alternatives: z.array(z.string()).default([]),
});
type Payload = z.infer<typeof payloadSchema>;

const sorted = (w: string) => [...w].sort().join("");

/** Up to `count` different orders of the word's letters, none spelling the word or another listed word. */
function arrangementsOf(rng: Rng, word: string, listed: ReadonlySet<string>, count: number): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (let t = 0; t < SHUFFLE_TRIES && out.length < count; t++) {
    const letters = shuffle(rng, [...word]);
    const spelled = letters.join("");
    if (spelled === word || listed.has(spelled) || seen.has(spelled)) continue;
    seen.add(spelled);
    out.push(letters);
  }
  return out;
}

export const scramble: ClimbGame<"scramble", Payload> = {
  type: "scramble",
  wordGame: "scramble",
  payloadSchema,
  generate({ rng, words, pool }) {
    const listed = new Set(words);
    // A word whose every order spells a word isn't a puzzle; try the next one.
    for (const word of shuffle(rng, pool)) {
      const arrangements = arrangementsOf(rng, word, listed, SCRAMBLE_ARRANGEMENTS);
      if (!arrangements.length) continue;
      const alternatives = words.filter((w) => w !== word && w.length === word.length && sorted(w) === sorted(word));
      return { word, letters: arrangements[0], arrangements, alternatives };
    }
    throw new NoWordsFit("scramble");
  },
  seconds: (_p, settings, stageSeconds) => settings.seconds ?? stageSeconds,
  /** A fresh word for each of the stage's rounds; any listed length works if the list runs short. */
  wordNeed: (s, stageRounds) => ({ minLength: s.minLength, maxLength: s.maxLength, needed: stageRounds, shortest: CLIMB_WORD_LENGTH.min, longest: CLIMB_WORD_LENGTH.max }),
  wordsUsed: (p) => [p.word],
  view: ({ letters, arrangements }) => ({ letters, arrangements: arrangements ?? [letters] }),
  reveal: ({ word }) => ({ word }),
  /** The word, or another listed word made of exactly the same letters. A partial guess is wrong. */
  grade: (p, a) => {
    const guess = a.word.trim().toLowerCase();
    return guess === p.word || p.alternatives.includes(guess);
  },
};

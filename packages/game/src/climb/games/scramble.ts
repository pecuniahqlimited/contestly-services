import { z } from "zod";
import type { ClimbGame } from "../types.js";
import { pick, scale, shuffle } from "../rng.js";
import { WORDS, WORD_SET } from "../words.js";

const MIN_LENGTH = 4;
const MAX_LENGTH = 8;

const payloadSchema = z.object({ word: z.string(), letters: z.array(z.string().length(1)) });
type Payload = z.infer<typeof payloadSchema>;

const sorted = (w: string) => [...w].sort().join("");

export const scramble: ClimbGame<"scramble", Payload> = {
  type: "scramble",
  payloadSchema,
  generate({ rng, level }) {
    const length = scale(level, MIN_LENGTH, MAX_LENGTH - 1);
    const pool = WORDS.filter((w) => w.length >= length && w.length <= length + 1);
    const word = pick(rng, pool.length ? pool : WORDS.filter((w) => w.length >= MIN_LENGTH));
    let letters = shuffle(rng, [...word]);
    // A scramble that spells the word (or another listed word) isn't a puzzle; reshuffle, or rotate as a last resort.
    for (let tries = 0; WORD_SET.has(letters.join("")) && tries < 10; tries++) letters = shuffle(rng, [...word]);
    if (WORD_SET.has(letters.join(""))) letters = [...letters.slice(1), letters[0]];
    return { word, letters };
  },
  view: ({ letters }) => ({ letters }),
  reveal: ({ word }) => ({ word }),
  /** The word, or any other listed word made of exactly the same letters. */
  grade: (p, a) => {
    const guess = a.word.trim().toLowerCase();
    return guess === p.word || (WORD_SET.has(guess) && sorted(guess) === sorted(p.word));
  },
};

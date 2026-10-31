import { z } from "zod";
import type { ClimbGame } from "../types.js";
import { emptyGrid, fill, inGrid, place, DIRECTIONS } from "../grid.js";
import { NoWordsFit } from "../wordPool.js";
import { shuffle } from "../rng.js";

/** Longest word a hunt is built around: hunts are about spotting short words. */
const MAX_WORD = 6;

const payloadSchema = z.object({
  grid: z.array(z.string()),
  placed: z.array(z.string()),
  find: z.number().int(),
  minLength: z.number().int(),
  /** Every listed word (long enough) that runs somewhere in the grid, fixed when the round was made. Absent on older rounds: then only `placed` counts. */
  accepted: z.array(z.string()).optional(),
});
type Payload = z.infer<typeof payloadSchema>;

export const wordHunt: ClimbGame<"word_hunt", Payload> = {
  type: "word_hunt",
  wordGame: "word_hunt",
  payloadSchema,
  generate({ rng, settings, words, pool }) {
    const { gridSize: size, find, minLength } = settings;
    const cells = emptyGrid(size);
    const placed: string[] = [];
    for (const w of shuffle(rng, pool)) {
      if (placed.length >= find + 1) break; // one spare, so a player isn't stuck hunting the single hardest word
      if (place(rng, cells, w, DIRECTIONS[settings.directions])) placed.push(w);
    }
    if (!placed.length) throw new NoWordsFit("word_hunt");
    const grid = fill(rng, cells);
    // Words the filler happened to spell count too.
    const accepted = words.filter((w) => w.length >= minLength && inGrid(grid, w));
    return { grid, placed, find: Math.max(1, Math.min(find, placed.length)), minLength, accepted };
  },
  seconds: (_p, settings, stageSeconds) => settings.seconds ?? stageSeconds,
  /** The words to find plus the spare; never shorter than a word that counts. */
  wordNeed: (s) => {
    const longest = Math.min(MAX_WORD, s.gridSize);
    return { minLength: s.minLength, maxLength: longest, needed: s.find + 1, shortest: s.minLength, longest };
  },
  view: ({ grid, find, minLength }) => ({ grid, find, minLength }),
  reveal: ({ placed }) => ({ words: placed }),
  /** Enough different listed words, each actually in the grid. */
  grade(p, a) {
    const accepted = new Set(p.accepted ?? p.placed);
    const found = new Set(a.words.map((w) => w.trim().toLowerCase()).filter((w) => w.length >= p.minLength && accepted.has(w)));
    return found.size >= p.find;
  },
};

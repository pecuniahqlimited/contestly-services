import { z } from "zod";
import type { ClimbGame } from "../types.js";
import { int, pick, scale, shuffle, type Rng } from "../rng.js";
import { WORDS, WORD_SET } from "../words.js";

const MIN_LENGTH = 3;
const MAX_WORD = 6;
const PLACE_TRIES = 200;
/** Filler letters, weighted towards common ones so the grid reads like words, not noise. */
const FILLER = "aaabcdeeeefghiiijklmnnoooprrsssttuuvwy";

const payloadSchema = z.object({ grid: z.array(z.string()), placed: z.array(z.string()), find: z.number().int(), minLength: z.number().int() });
type Payload = z.infer<typeof payloadSchema>;

type Dir = readonly [number, number];
const STRAIGHT: Dir[] = [[0, 1], [1, 0]];
const ALL_DIRS: Dir[] = [[0, 1], [1, 0], [1, 1], [-1, 1], [0, -1], [-1, 0], [-1, -1], [1, -1]];

function place(rng: Rng, cells: (string | null)[][], word: string, dirs: Dir[]): boolean {
  const n = cells.length;
  for (let t = 0; t < PLACE_TRIES; t++) {
    const [dr, dc] = pick(rng, dirs);
    const r0 = int(rng, 0, n - 1), c0 = int(rng, 0, n - 1);
    const path = [...word].map((_, i) => [r0 + dr * i, c0 + dc * i] as const);
    const fits = path.every(([r, c], i) => r >= 0 && c >= 0 && r < n && c < n && (cells[r][c] === null || cells[r][c] === word[i]));
    if (!fits) continue;
    path.forEach(([r, c], i) => (cells[r][c] = word[i]));
    return true;
  }
  return false;
}

/** Whether `word` runs in a straight line, any of the 8 directions, somewhere in the grid. */
export function inGrid(grid: string[], word: string): boolean {
  const n = grid.length;
  for (let r = 0; r < n; r++) for (let c = 0; c < grid[r].length; c++) {
    if (grid[r][c] !== word[0]) continue;
    for (const [dr, dc] of ALL_DIRS) {
      if ([...word].every((ch, i) => grid[r + dr * i]?.[c + dc * i] === ch)) return true;
    }
  }
  return false;
}

export const wordHunt: ClimbGame<"word_hunt", Payload> = {
  type: "word_hunt",
  payloadSchema,
  generate({ rng, level }) {
    const size = scale(level, 6, 8);
    const find = scale(level, 2, 4);
    // Diagonal and backwards placements only once the ladder is past halfway.
    const dirs = level >= 0.5 ? ALL_DIRS : STRAIGHT;
    const cells: (string | null)[][] = Array.from({ length: size }, () => Array<string | null>(size).fill(null));
    const candidates = shuffle(rng, WORDS.filter((w) => w.length >= MIN_LENGTH && w.length <= Math.min(MAX_WORD, size)));
    const placed: string[] = [];
    for (const w of candidates) {
      if (placed.length >= find + 1) break; // one spare, so a player isn't stuck hunting the single hardest word
      if (place(rng, cells, w, dirs)) placed.push(w);
    }
    const grid = cells.map((row) => row.map((ch) => ch ?? FILLER[int(rng, 0, FILLER.length - 1)]).join(""));
    return { grid, placed, find: Math.min(find, placed.length), minLength: MIN_LENGTH };
  },
  view: ({ grid, find, minLength }) => ({ grid, find, minLength }),
  reveal: ({ placed }) => ({ words: placed }),
  /** Enough different listed words, each actually in the grid. Words the filler happened to spell count too. */
  grade(p, a) {
    const found = new Set(a.words.map((w) => w.trim().toLowerCase()).filter((w) => w.length >= p.minLength && WORD_SET.has(w) && inGrid(p.grid, w)));
    return found.size >= p.find;
  },
};

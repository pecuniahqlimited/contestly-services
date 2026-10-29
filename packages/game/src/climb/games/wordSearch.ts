import { z } from "zod";
import type { ClimbGame } from "../types.js";
import { emptyGrid, fill, occurrences, place, DIRECTIONS, type Cell } from "../grid.js";
import { NoWordsFit } from "../wordPool.js";
import { shuffle, type Rng } from "../rng.js";
import { CLIMB_DIRECTIONS, CLIMB_WORD_LENGTH, type ClimbDirections } from "@contestly/shared";

/** Grids tried for one that holds every word asked for. */
const GRID_TRIES = 20;

const cellSchema = z.tuple([z.number().int(), z.number().int()]);
const payloadSchema = z.object({
  grid: z.array(z.string()),
  directions: z.enum(CLIMB_DIRECTIONS),
  placements: z.array(z.object({ word: z.string(), cells: z.array(cellSchema) })),
});
type Payload = z.infer<typeof payloadSchema>;

const isPalindrome = (w: string) => w === [...w].reverse().join("");
const sameCells = (a: readonly Cell[], b: readonly Cell[]) => a.length === b.length && a.every(([r, c], i) => r === b[i][0] && c === b[i][1]);

const reversed = (w: string) => [...w].reverse().join("");
/** One word inside the other, either way round: placing both would put the shorter in the grid twice. */
const overlaps = (a: string, b: string) => a.includes(b) || b.includes(a) || a.includes(reversed(b)) || b.includes(reversed(a));

/**
 * One attempt at a grid: up to `count` words placed, the rest filler. A word that turns up anywhere else in the
 * finished grid is dropped from the list, so the cells a player finds for a word are always its placement.
 */
function build(rng: Rng, size: number, candidates: string[], count: number, directions: ClimbDirections) {
  const cells = emptyGrid(size);
  const placements: { word: string; cells: Cell[] }[] = [];
  for (const word of candidates) {
    if (placements.length >= count) break;
    if (placements.some((p) => overlaps(p.word, word))) continue;
    const at = place(rng, cells, word, DIRECTIONS[directions]);
    if (at) placements.push({ word, cells: at });
  }
  const grid = fill(rng, cells);
  return { grid, placements: placements.filter((p) => occurrences(grid, p.word) === 1) };
}

/**
 * Classic word search: a grid and the words hidden in it, from the round's pool (the admin list, fresh words of the
 * stage's lengths where it can). If not every word can be placed it places fewer, and the clock scales with the words
 * placed. Right only if every word is found.
 */
export const wordSearch: ClimbGame<"word_search", Payload> = {
  type: "word_search",
  wordGame: "word_search",
  payloadSchema,
  generate({ rng, settings, pool }) {
    const { gridSize: size, directions } = settings;
    const candidates = shuffle(rng, pool.filter((w) => !isPalindrome(w)));
    let best: ReturnType<typeof build> | null = null;
    for (let t = 0; t < GRID_TRIES && (best?.placements.length ?? 0) < settings.words; t++) {
      const built = build(rng, size, candidates, settings.words, directions);
      if (!best || built.placements.length > best.placements.length) best = built;
    }
    if (!best?.placements.length) throw new NoWordsFit("word_search");
    return { grid: best.grid, directions, placements: best.placements };
  },
  seconds: (p, settings) => p.placements.length * settings.secondsPerWord,
  /** Its words for each of the stage's rounds, short enough to fit the grid. */
  wordNeed: (s, stageRounds) => ({ minLength: s.minLength, maxLength: Math.min(s.maxLength, s.gridSize), needed: s.words * stageRounds, shortest: CLIMB_WORD_LENGTH.min, longest: s.gridSize }),
  wordsUsed: (p) => p.placements.map((x) => x.word),
  view: ({ grid, directions, placements }) => ({ grid, directions, words: placements.map((x) => x.word).sort() }),
  reveal: ({ placements }) => ({ placements }),
  /** Every placed word found, each with its own cells, either way along its line. */
  grade(p, a) {
    return p.placements.every((pl) => a.found.some((f) => f.word.trim().toLowerCase() === pl.word && (sameCells(f.cells, pl.cells) || sameCells(f.cells, [...pl.cells].reverse()))));
  },
};

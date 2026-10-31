/** Letter grids shared by word hunt and word search: directions, placing a word, filler, and finding words. */
import type { ClimbDirections } from "@contestly/shared";
import { int, pick, type Rng } from "./rng.js";

export type Dir = readonly [number, number];
export type Cell = [number, number];

const RIGHT: Dir = [0, 1], DOWN: Dir = [1, 0], DOWN_RIGHT: Dir = [1, 1], UP_RIGHT: Dir = [-1, 1];
const ALL_DIRS: Dir[] = [RIGHT, DOWN, DOWN_RIGHT, UP_RIGHT, [0, -1], [-1, 0], [-1, -1], [1, -1]];

/** The ways a word may be placed for each setting. */
export const DIRECTIONS: Record<ClimbDirections, Dir[]> = {
  straight: [RIGHT, DOWN],
  straight_diagonal: [RIGHT, DOWN, DOWN_RIGHT, UP_RIGHT],
  all: ALL_DIRS,
};

const PLACE_TRIES = 200;
/** Filler letters, weighted towards common ones so the grid reads like words, not noise. */
const FILLER = "aaabcdeeeefghiiijklmnnoooprrsssttuuvwy";

export const emptyGrid = (size: number): (string | null)[][] => Array.from({ length: size }, () => Array<string | null>(size).fill(null));

/** Place `word` in a straight line one of `dirs` ways, sharing only matching letters. The cells it took, or null. */
export function place(rng: Rng, cells: (string | null)[][], word: string, dirs: Dir[]): Cell[] | null {
  const n = cells.length;
  for (let t = 0; t < PLACE_TRIES; t++) {
    const [dr, dc] = pick(rng, dirs);
    const r0 = int(rng, 0, n - 1), c0 = int(rng, 0, n - 1);
    const path = [...word].map((_, i) => [r0 + dr * i, c0 + dc * i] as Cell);
    const fits = path.every(([r, c], i) => r >= 0 && c >= 0 && r < n && c < n && (cells[r][c] === null || cells[r][c] === word[i]));
    if (!fits) continue;
    path.forEach(([r, c], i) => (cells[r][c] = word[i]));
    return path;
  }
  return null;
}

/** The grid's rows with every empty cell filled. */
export const fill = (rng: Rng, cells: (string | null)[][]) => cells.map((row) => row.map((ch) => ch ?? FILLER[int(rng, 0, FILLER.length - 1)]).join(""));

/** How many times `word` runs in a straight line, any of the 8 directions, in the grid. */
export function occurrences(grid: readonly string[], word: string): number {
  let n = 0;
  for (let r = 0; r < grid.length; r++) for (let c = 0; c < grid[r].length; c++) {
    if (grid[r][c] !== word[0]) continue;
    for (const [dr, dc] of ALL_DIRS) if ([...word].every((ch, i) => grid[r + dr * i]?.[c + dc * i] === ch)) n++;
  }
  return n;
}

/** Whether `word` runs in a straight line, any of the 8 directions, somewhere in the grid. */
export const inGrid = (grid: readonly string[], word: string) => occurrences(grid, word) > 0;

/**
 * Choosing which words a round may use when the list is short. A player never hits "no words" mid-run: first the
 * stage's lengths, widened a letter at a time towards the nearest lengths that still work; then words the player
 * has met before but not in their last few runs; then any word on the list. Only an empty list (for that game)
 * stops a round being made.
 */
import type { WordNeed } from "./types.js";

/** Which words a pool leaves out, strictest first. */
export const WORD_FRESHNESS = ["unseen", "not_recent", "any"] as const;
export type WordFreshness = (typeof WORD_FRESHNESS)[number];

/** Words the player has been given: in their recent runs (this one included), and further back. `recent` ⊆ `seen`. */
export interface WordHistory { seen: ReadonlySet<string>; recent: ReadonlySet<string> }
export const NO_HISTORY: WordHistory = { seen: new Set(), recent: new Set() };

export interface WordPool { words: string[]; minLength: number; maxLength: number; freshness: WordFreshness }

const fits = (w: string, minLength: number, maxLength: number) => w.length >= minLength && w.length <= maxLength;

const excluded = (history: WordHistory, freshness: WordFreshness): ReadonlySet<string> =>
  freshness === "unseen" ? history.seen : freshness === "not_recent" ? history.recent : new Set();

/**
 * The pools to try, in order. For each freshness the lengths widen one letter either side (within the need's
 * shortest–longest) until the pool holds a round's worth of words; the last freshness takes whatever it can.
 */
export function* wordPools(words: readonly string[], history: WordHistory, need: WordNeed): Generator<WordPool> {
  for (const freshness of WORD_FRESHNESS) {
    const allowed = words.filter((w) => !excluded(history, freshness).has(w));
    const last = freshness === WORD_FRESHNESS[WORD_FRESHNESS.length - 1];
    for (let d = 0; ; d++) {
      const minLength = Math.max(need.shortest, need.minLength - d), maxLength = Math.min(need.longest, need.maxLength + d);
      const pool = allowed.filter((w) => fits(w, minLength, maxLength));
      const widest = minLength === need.shortest && maxLength === need.longest;
      if (pool.length >= need.needed || (last && widest && pool.length)) {
        yield { words: pool, minLength, maxLength, freshness };
        break;
      }
      if (widest) break;
    }
  }
}

/** Whether a pool is the one the stage asked for, or a fallback worth logging. */
export const isFallback = (pool: WordPool, need: WordNeed) => pool.freshness !== "unseen" || pool.minLength !== need.minLength || pool.maxLength !== need.maxLength;

/** A word game with nothing on the list it can use. The ladder editor refuses a ladder where this could happen. */
export class NoWordsFit extends Error {
  readonly statusCode = 422;
  constructor(readonly gameType: string) { super("no_words_fit"); }
}

/**
 * The Climb's game types. Adding one is an entry here (its file in games/, and its shapes and settings in
 * @contestly/shared); nothing else switches on the type.
 */
import { CLIMB_GAME_TYPES, climbAnswerSchemas, settingsAtRound, stageSettings, type ClimbGameType, type ClimbStage, type ClimbWordGame } from "@contestly/shared";
import type { ClimbGame, WordNeed } from "./types.js";
import type { Rng } from "./rng.js";
import { isFallback, NO_HISTORY, NoWordsFit, wordPools, type WordHistory, type WordPool } from "./wordPool.js";
import { pattern } from "./games/pattern.js";
import { scramble } from "./games/scramble.js";
import { wordHunt } from "./games/wordHunt.js";
import { quickMaths } from "./games/quickMaths.js";
import { memory } from "./games/memory.js";
import { patternRecall } from "./games/patternRecall.js";
import { wordSearch } from "./games/wordSearch.js";

const REGISTRY: { [T in ClimbGameType]: ClimbGame<T, any> } = {
  pattern,
  scramble,
  word_hunt: wordHunt,
  quick_maths: quickMaths,
  memory,
  pattern_recall: patternRecall,
  word_search: wordSearch,
};

export const climbGame = <T extends ClimbGameType>(type: T): ClimbGame<T, unknown> => REGISTRY[type];

/** The word list a type draws from, if any: the caller loads those words before generating. */
export const wordGameOf = (type: ClimbGameType): ClimbWordGame | undefined => REGISTRY[type].wordGame;

export interface RoundInputs {
  rng: Rng;
  /** Active words allowed for the type's word game (see wordGameOf); ignored by types without one. */
  words?: readonly string[];
  /** Words the player has been given before, so word games prefer ones they haven't. */
  history?: WordHistory;
}

export interface MadeRound {
  payload: unknown;
  /** The round's clock in whole seconds. */
  seconds: number;
  /** For a word game: the pool it was made from, and whether that was a fallback from what the stage asked for (worth logging). */
  words: (Omit<WordPool, "words"> & { fallback: boolean; asked: { minLength: number; maxLength: number } }) | null;
}

/**
 * A fresh round of `type` for a stage's round (0-based `roundIdx`), from the stage's settings for that type: the stored
 * payload (answer included) and its clock in whole seconds. A word game tries the pools wordPools offers in turn, so it
 * only fails (NoWordsFit) when the list has no word the game can use at all.
 */
export function generateRound(stage: ClimbStage, type: ClimbGameType, roundIdx: number, inputs: RoundInputs): MadeRound {
  const game = REGISTRY[type];
  const settings = settingsAtRound(stageSettings(stage, type), roundIdx, stage.rounds);
  const make = (pool: readonly string[]) => {
    const payload = game.generate({ rng: inputs.rng, settings, stageSeconds: stage.seconds, words: inputs.words ?? [], pool } as never);
    return { payload, seconds: Math.ceil(game.seconds(payload, settings as never, stage.seconds)) };
  };
  if (!game.wordNeed) return { ...make([]), words: null };
  const need = game.wordNeed(settings as never, 1);
  for (const pool of wordPools(inputs.words ?? [], inputs.history ?? NO_HISTORY, need)) {
    try {
      const { words: _, ...used } = pool;
      return { ...make(pool.words), words: { ...used, fallback: isFallback(pool, need), asked: { minLength: need.minLength, maxLength: need.maxLength } } };
    } catch (e) {
      if (!(e instanceof NoWordsFit)) throw e; // this pool couldn't make a round (e.g. no word fit the grid): try the next
    }
  }
  throw new NoWordsFit(type);
}

/** What a stage's round (0-based) of a word game needs from the list; null for types without words. */
export function roundWordNeed(stage: ClimbStage, type: ClimbGameType, roundIdx: number): WordNeed | null {
  const game = REGISTRY[type];
  return game.wordNeed ? game.wordNeed(settingsAtRound(stageSettings(stage, type), roundIdx, stage.rounds) as never, stage.rounds) : null;
}

/** The words a stored round used (none for types without words). */
export const roundWords = (type: ClimbGameType, payload: unknown): string[] => {
  const game = REGISTRY[type];
  return game.wordsUsed ? game.wordsUsed(game.payloadSchema.parse(payload)) : [];
};

/** What the client may see while the round is open. */
export const roundView = (type: ClimbGameType, payload: unknown) => REGISTRY[type].view(REGISTRY[type].payloadSchema.parse(payload));

/** The answer, for after the round closes. */
export const roundReveal = (type: ClimbGameType, payload: unknown) => REGISTRY[type].reveal(REGISTRY[type].payloadSchema.parse(payload));

/** Right or wrong. A malformed answer is wrong, never an error, so one bad client can't stall a run. */
export function gradeRound(type: ClimbGameType, payload: unknown, answer: unknown): boolean {
  const parsed = climbAnswerSchemas[type].safeParse(answer);
  if (!parsed.success) return false;
  const game = REGISTRY[type];
  return game.grade(game.payloadSchema.parse(payload), parsed.data as never);
}

export { CLIMB_GAME_TYPES };

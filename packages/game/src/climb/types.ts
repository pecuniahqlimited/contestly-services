import type { z } from "zod";
import type { ClimbAnswer, ClimbGameType, ClimbReveal, ClimbView, ClimbWordGame, ResolvedClimbSettings } from "@contestly/shared";
import type { Rng } from "./rng.js";

/**
 * What a round needs from the word list: the lengths its settings ask for, how many distinct words, and the lengths
 * that still work at all if the list runs short (`shortest`/`longest`: e.g. what fits the grid, or what still counts).
 */
export interface WordNeed { minLength: number; maxLength: number; needed: number; shortest: number; longest: number }

export interface GenerateOptions<T extends ClimbGameType = ClimbGameType> {
  rng: Rng;
  /** This type's settings for the stage, read at this round. */
  settings: ResolvedClimbSettings<T>;
  /** The stage's seconds: the clock for a type whose settings don't set their own time. */
  stageSeconds: number;
  /** Active words allowed for this game (empty for games that don't use words): what counts as a listed word. */
  words: readonly string[];
  /** The words this round may be built from, lengths and freshness already decided (see wordPools). */
  pool: readonly string[];
}

/**
 * One Climb game type: how to make a round from its settings, how long the round lasts, what a client may
 * see of it, the answer it reveals once closed, and how to grade a submission. Adding a type is one of
 * these, registered in registry.ts, with its shapes and settings in @contestly/shared.
 */
export interface ClimbGame<T extends ClimbGameType, P> {
  type: T;
  /** The word list this type draws from, if any. */
  wordGame?: ClimbWordGame;
  /** The stored round, answer included. Never sent to a client as is. */
  payloadSchema: z.ZodType<P, z.ZodTypeDef, any>;
  generate(opts: GenerateOptions<T>): P;
  /** The round's clock in seconds, from its settings and what it actually holds. */
  seconds(payload: P, settings: ResolvedClimbSettings<T>, stageSeconds: number): number;
  /**
   * What a round with these settings needs from the word list: word lengths, and how many distinct words a stage of
   * `stageRounds` rounds could use (types with a word game only). Runs widen the lengths when the list is short; the
   * ladder editor warns about that, and refuses a stage the list can't supply even widened.
   */
  wordNeed?(settings: ResolvedClimbSettings<T>, stageRounds: number): WordNeed;
  /** Words this round used, so the rest of the run doesn't repeat them. */
  wordsUsed?(payload: P): string[];
  view(payload: P): ClimbView<T>;
  reveal(payload: P): ClimbReveal<T>;
  /** The answer has already been parsed against the type's answer schema. */
  grade(payload: P, answer: ClimbAnswer<T>): boolean;
}

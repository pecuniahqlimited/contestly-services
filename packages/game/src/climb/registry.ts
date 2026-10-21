/**
 * The Climb's game types. Adding one is an entry here (its file in games/, and its shapes in
 * @contestly/shared's climb.ts); nothing else switches on the type.
 */
import { CLIMB_GAME_TYPES, climbAnswerSchemas, type ClimbGameType } from "@contestly/shared";
import type { ClimbGame, GenerateOptions } from "./types.js";
import { pattern } from "./games/pattern.js";
import { scramble } from "./games/scramble.js";
import { wordHunt } from "./games/wordHunt.js";
import { quickMaths } from "./games/quickMaths.js";
import { memory } from "./games/memory.js";

const REGISTRY: { [T in ClimbGameType]: ClimbGame<T, any> } = {
  pattern,
  scramble,
  word_hunt: wordHunt,
  quick_maths: quickMaths,
  memory,
};

export const climbGame = <T extends ClimbGameType>(type: T): ClimbGame<T, unknown> => REGISTRY[type];

/** A fresh round of this type, as stored (answer included). */
export const generateRound = (type: ClimbGameType, opts: GenerateOptions): unknown => REGISTRY[type].generate(opts);

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

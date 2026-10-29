import { z } from "zod";
import type { ClimbGame } from "../types.js";
import { shuffle } from "../rng.js";

const MS_PER_SECOND = 1000;

const payloadSchema = z.object({ gridSize: z.number().int(), sequence: z.array(z.number().int()), msPerTile: z.number().int() });
type Payload = z.infer<typeof payloadSchema>;

/**
 * Spatial recall: tiles of a gridSize × gridSize board (numbered row by row) light up one at a time, then the
 * player taps them in the same order. No tile repeats in a round, so the length is capped at the tiles.
 */
export const patternRecall: ClimbGame<"pattern_recall", Payload> = {
  type: "pattern_recall",
  payloadSchema,
  generate({ rng, settings }) {
    const tiles = settings.gridSize ** 2;
    const sequence = shuffle(rng, Array.from({ length: tiles }, (_, i) => i)).slice(0, Math.min(settings.length, tiles));
    return { gridSize: settings.gridSize, sequence, msPerTile: settings.msPerTile };
  },
  /** Show time, then the time to repeat it. */
  seconds: (p, settings, stageSeconds) => (p.sequence.length * p.msPerTile) / MS_PER_SECOND + (settings.secondsToRepeat ?? stageSeconds),
  // Like memory, the sequence is the game: shown once from the round opening, then repeated.
  view: ({ gridSize, sequence, msPerTile }) => ({ gridSize, sequence, msPerTile }),
  reveal: ({ sequence }) => ({ sequence }),
  grade: (p, a) => a.sequence.length === p.sequence.length && a.sequence.every((t, i) => t === p.sequence[i]),
};

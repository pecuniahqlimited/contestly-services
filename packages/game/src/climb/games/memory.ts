import { z } from "zod";
import type { ClimbGame } from "../types.js";
import { int, scale } from "../rng.js";

const SYMBOLS = 4;
const MIN_LENGTH = 3;
const MAX_LENGTH = 8;
const SHOW_MS_PER_SYMBOL = 600;
/** The sequence never takes more than this share of the clock, so there's always time to repeat it. */
const MAX_SHOW_SHARE = 0.5;

const payloadSchema = z.object({ symbols: z.number().int(), sequence: z.array(z.number().int()), showMs: z.number().int() });
type Payload = z.infer<typeof payloadSchema>;

export const memory: ClimbGame<"memory", Payload> = {
  type: "memory",
  payloadSchema,
  generate({ rng, level, seconds }) {
    const length = scale(level, MIN_LENGTH, MAX_LENGTH);
    const sequence = Array.from({ length }, () => int(rng, 0, SYMBOLS - 1));
    const showMs = Math.min(length * SHOW_MS_PER_SYMBOL, Math.floor(seconds * 1000 * MAX_SHOW_SHARE));
    return { symbols: SYMBOLS, sequence, showMs };
  },
  // The sequence is the game: it's shown for showMs, then the client hides it. The clock covers both.
  view: ({ symbols, sequence, showMs }) => ({ symbols, sequence, showMs }),
  reveal: ({ sequence }) => ({ sequence }),
  grade: (p, a) => a.sequence.length === p.sequence.length && a.sequence.every((s, i) => s === p.sequence[i]),
};

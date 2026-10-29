import { z } from "zod";
import type { ClimbGame } from "../types.js";
import { int } from "../rng.js";

/** The sequence never takes more than this share of the clock, so there's always time to repeat it. */
const MAX_SHOW_SHARE = 0.5;
const MS_PER_SECOND = 1000;

const payloadSchema = z.object({ symbols: z.number().int(), sequence: z.array(z.number().int()), showMs: z.number().int() });
type Payload = z.infer<typeof payloadSchema>;

const clock = (settings: { seconds?: number }, stageSeconds: number) => settings.seconds ?? stageSeconds;

export const memory: ClimbGame<"memory", Payload> = {
  type: "memory",
  payloadSchema,
  generate({ rng, settings, stageSeconds }) {
    const sequence = Array.from({ length: settings.length }, () => int(rng, 0, settings.symbols - 1));
    const showMs = Math.min(settings.length * settings.msPerSymbol, Math.floor(clock(settings, stageSeconds) * MS_PER_SECOND * MAX_SHOW_SHARE));
    return { symbols: settings.symbols, sequence, showMs };
  },
  seconds: (_p, settings, stageSeconds) => clock(settings, stageSeconds),
  // The sequence is the game: it's shown for showMs, then the client hides it. The clock covers both.
  view: ({ symbols, sequence, showMs }) => ({ symbols, sequence, showMs }),
  reveal: ({ sequence }) => ({ sequence }),
  grade: (p, a) => a.sequence.length === p.sequence.length && a.sequence.every((s, i) => s === p.sequence[i]),
};

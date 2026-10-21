import type { z } from "zod";
import type { ClimbAnswer, ClimbGameType, ClimbReveal, ClimbView } from "@contestly/shared";
import type { Rng } from "./rng.js";

export interface GenerateOptions {
  rng: Rng;
  /** 0 at the first stage, 1 at the last: how hard to make it. */
  level: number;
  /** The round's clock, so a generator can fit inside it (memory's show time). */
  seconds: number;
}

/**
 * One Climb game type: how to make a round, what a client may see of it, the answer it reveals once
 * closed, and how to grade a submission. Adding a type is one of these, registered in registry.ts.
 */
export interface ClimbGame<T extends ClimbGameType, P> {
  type: T;
  /** The stored round, answer included. Never sent to a client as is. */
  payloadSchema: z.ZodType<P>;
  generate(opts: GenerateOptions): P;
  view(payload: P): ClimbView<T>;
  reveal(payload: P): ClimbReveal<T>;
  /** The answer has already been parsed against the type's answer schema. */
  grade(payload: P, answer: ClimbAnswer<T>): boolean;
}

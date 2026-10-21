import { randomInt } from "node:crypto";
import { seeded, type Rng } from "@contestly/game";

const SEED_RANGE = 2 ** 31;
/** A generator seeded from crypto, for real rounds. Tests seed @contestly/game's `seeded()` with a number instead. */
export const freshRng = (): Rng => seeded(randomInt(SEED_RANGE));

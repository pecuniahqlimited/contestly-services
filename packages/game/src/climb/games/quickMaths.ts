import { z } from "zod";
import type { ClimbGame } from "../types.js";
import { int, pick, type Rng } from "../rng.js";

const payloadSchema = z.object({ expression: z.string(), value: z.number().int() });
type Payload = z.infer<typeof payloadSchema>;

/** Each form makes an expression and its value; harder forms unlock with the level. Written with × and − as players read them. */
type Form = { minLevel: number; make(rng: Rng): Payload };
const FORMS: Form[] = [
  { minLevel: 0, make: (rng) => { const a = int(rng, 2, 30), b = int(rng, 2, 30); return { expression: `${a} + ${b}`, value: a + b }; } },
  { minLevel: 0, make: (rng) => { const a = int(rng, 10, 50), b = int(rng, 2, a); return { expression: `${a} − ${b}`, value: a - b }; } },
  { minLevel: 0.25, make: (rng) => { const a = int(rng, 2, 12), b = int(rng, 2, 12); return { expression: `${a} × ${b}`, value: a * b }; } },
  { minLevel: 0.5, make: (rng) => { const b = int(rng, 2, 12), q = int(rng, 2, 12); return { expression: `${b * q} ÷ ${b}`, value: q }; } },
  { minLevel: 0.5, make: (rng) => { const a = int(rng, 2, 12), b = int(rng, 2, 12), c = int(rng, 1, 30); return { expression: `${a} × ${b} + ${c}`, value: a * b + c }; } },
  { minLevel: 0.75, make: (rng) => { const a = int(rng, 2, 15), b = int(rng, 2, 15), c = int(rng, 2, 9); return { expression: `(${a} + ${b}) × ${c}`, value: (a + b) * c }; } },
  { minLevel: 0.75, make: (rng) => { const a = int(rng, 11, 25), b = int(rng, 11, 25); return { expression: `${a} × ${b}`, value: a * b }; } },
];

export const quickMaths: ClimbGame<"quick_maths", Payload> = {
  type: "quick_maths",
  payloadSchema,
  generate: ({ rng, level }) => pick(rng, FORMS.filter((f) => f.minLevel <= level)).make(rng),
  view: ({ expression }) => ({ expression }),
  reveal: ({ value }) => ({ value }),
  grade: (p, a) => a.value === p.value,
};

import { z } from "zod";
import { QUICK_MATHS_FORMS, type QuickMathsForm } from "@contestly/shared";
import type { ClimbGame } from "../types.js";
import { int, pick, type Rng } from "../rng.js";

const payloadSchema = z.object({ expression: z.string(), value: z.number().int() });
type Payload = z.infer<typeof payloadSchema>;

/** Each form makes an expression and its value, written with × and − as players read them. The stage's settings pick which forms play. */
const FORMS: Record<QuickMathsForm, (rng: Rng) => Payload> = {
  add: (rng) => { const a = int(rng, 2, 30), b = int(rng, 2, 30); return { expression: `${a} + ${b}`, value: a + b }; },
  subtract: (rng) => { const a = int(rng, 10, 50), b = int(rng, 2, a); return { expression: `${a} − ${b}`, value: a - b }; },
  multiply: (rng) => { const a = int(rng, 2, 12), b = int(rng, 2, 12); return { expression: `${a} × ${b}`, value: a * b }; },
  divide: (rng) => { const b = int(rng, 2, 12), q = int(rng, 2, 12); return { expression: `${b * q} ÷ ${b}`, value: q }; },
  multiply_add: (rng) => { const a = int(rng, 2, 12), b = int(rng, 2, 12), c = int(rng, 1, 30); return { expression: `${a} × ${b} + ${c}`, value: a * b + c }; },
  bracket: (rng) => { const a = int(rng, 2, 15), b = int(rng, 2, 15), c = int(rng, 2, 9); return { expression: `(${a} + ${b}) × ${c}`, value: (a + b) * c }; },
  big_multiply: (rng) => { const a = int(rng, 11, 25), b = int(rng, 11, 25); return { expression: `${a} × ${b}`, value: a * b }; },
};
/** In catalogue order, so a seed picks the same form whatever order the admin ticked them in. */
const ORDER = Object.keys(QUICK_MATHS_FORMS) as QuickMathsForm[];

export const quickMaths: ClimbGame<"quick_maths", Payload> = {
  type: "quick_maths",
  payloadSchema,
  generate: ({ rng, settings }) => FORMS[pick(rng, ORDER.filter((f) => settings.forms.includes(f)))](rng),
  seconds: (_p, settings, stageSeconds) => settings.seconds ?? stageSeconds,
  view: ({ expression }) => ({ expression }),
  reveal: ({ value }) => ({ value }),
  grade: (p, a) => a.value === p.value,
};

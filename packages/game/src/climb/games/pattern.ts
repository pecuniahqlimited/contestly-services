import { z } from "zod";
import { PATTERN_DIFFICULTY } from "@contestly/shared";
import type { ClimbGame } from "../types.js";
import { int, pick, shuffle, type Rng } from "../rng.js";

const TERMS_SHOWN = 5;
const OPTIONS = 4;

const payloadSchema = z.object({ sequence: z.array(z.number().int()), options: z.array(z.number().int()).length(OPTIONS), correctIndex: z.number().int().min(0).max(OPTIONS - 1) });
type Payload = z.infer<typeof payloadSchema>;

/**
 * A rule makes the first n+1 terms of a sequence; the last one is the answer. Harder rules unlock with the difficulty
 * setting, read here as a level from 0 (difficulty 1) to 1 (difficulty 5).
 */
type Rule = { minLevel: number; terms(rng: Rng, n: number, level: number): number[] };
const RULES: Rule[] = [
  { minLevel: 0, terms: (rng, n, level) => { const a = int(rng, 1, 20), d = int(rng, 2, 4 + Math.round(level * 8)); return seq(n, (i) => a + i * d); } },
  { minLevel: 0, terms: (rng, n) => { const a = int(rng, 40, 90), d = int(rng, 2, 9); return seq(n, (i) => a - i * d); } },
  { minLevel: 0.25, terms: (rng, n) => { const a = int(rng, 1, 4), r = int(rng, 2, 3); return seq(n, (i) => a * r ** i); } },
  { minLevel: 0.25, terms: (rng, n) => { const a = int(rng, 1, 10), x = int(rng, 1, 6), y = int(rng, 7, 12); let v = a; return seq(n, (i) => (i === 0 ? v : (v += i % 2 ? x : y))); } },
  { minLevel: 0.5, terms: (rng, n) => { const c = int(rng, 0, 5), s = int(rng, 1, 3); return seq(n, (i) => (i + s) ** 2 + c); } },
  { minLevel: 0.5, terms: (rng, n) => { const out = [int(rng, 1, 5), int(rng, 2, 7)]; while (out.length < n) out.push(out[out.length - 1] + out[out.length - 2]); return out; } },
  { minLevel: 0.75, terms: (rng, n) => { const a = int(rng, 1, 5), d = int(rng, 1, 3); let v = a; return seq(n, (i) => (i === 0 ? v : (v += d * i))); } },
];
const seq = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));

/** Three near misses: the kind of wrong answer a hurried player gives. */
function distractors(rng: Rng, terms: number[]): number[] {
  const answer = terms[terms.length - 1];
  const step = Math.abs(answer - terms[terms.length - 2]) || 1;
  const near = shuffle(rng, [answer + 1, answer - 1, answer + 2, answer - 2, answer + step, answer - step, answer + 10, answer - 10]);
  return [...new Set(near.filter((v) => v !== answer))].slice(0, OPTIONS - 1);
}

export const pattern: ClimbGame<"pattern", Payload> = {
  type: "pattern",
  payloadSchema,
  generate({ rng, settings }) {
    const level = (settings.difficulty - PATTERN_DIFFICULTY.min) / (PATTERN_DIFFICULTY.max - PATTERN_DIFFICULTY.min);
    const rule = pick(rng, RULES.filter((r) => r.minLevel <= level));
    const terms = rule.terms(rng, TERMS_SHOWN + 1, level);
    const answer = terms[TERMS_SHOWN];
    const options = shuffle(rng, [answer, ...distractors(rng, terms)]);
    return { sequence: terms.slice(0, TERMS_SHOWN), options, correctIndex: options.indexOf(answer) };
  },
  seconds: (_p, settings, stageSeconds) => settings.seconds ?? stageSeconds,
  view: ({ sequence, options }) => ({ sequence, options }),
  reveal: ({ correctIndex }) => ({ correctIndex }),
  grade: (p, a) => a.index === p.correctIndex,
};

/**
 * Deterministic shuffles seeded by the question text: the generator gives the answer apart from the
 * distractors and we place it, so the model's position habits never leak into where the answer sits, and
 * the same question always comes out the same way (tests, replays).
 */
import { createHash } from "node:crypto";

function rng(seed: string): () => number {
  let a = createHash("sha256").update(seed).digest().readUInt32BE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The indexes 0..n-1 in a seeded order. */
export function permutation(n: number, seed: string): number[] {
  const r = rng(seed);
  const p = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  return p;
}

/** Like permutation, but never the identity (an "order" question shown already in order isn't a question). */
export function derangedOrder(n: number, seed: string): number[] {
  for (let k = 0; k < 8; k++) {
    const p = permutation(n, `${seed}#${k}`);
    if (p.some((v, i) => v !== i)) return p;
  }
  return Array.from({ length: n }, (_, i) => (i + 1) % n);
}

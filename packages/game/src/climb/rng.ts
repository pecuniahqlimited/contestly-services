/**
 * Randomness is passed in, so every generator is deterministic under test. The server seeds from
 * crypto; tests seed with a number.
 */
export type Rng = () => number;

/** mulberry32: small, fast, good enough for puzzles (not for anything secret; nothing here is). */
export function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An integer in [lo, hi]. */
export const int = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
export const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)];
export function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
/** Linear step from `from` at level 0 to `to` at level 1, rounded. */
export const scale = (level: number, from: number, to: number) => Math.round(from + (to - from) * Math.min(1, Math.max(0, level)));

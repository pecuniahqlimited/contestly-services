/**
 * Scoring: correctness × (base + speed bonus), from server timestamps only.
 * The speed bonus falls linearly with time taken; a wrong answer scores 0 regardless of speed.
 */
export interface ScoringConfig {
  basePoints: number;
  maxSpeedBonus: number;
}

export function speedBonus(answeredMs: number, questionMs: number, maxSpeedBonus: number): number {
  if (questionMs <= 0) return 0;
  const remaining = Math.max(0, 1 - answeredMs / questionMs);
  return Math.round(maxSpeedBonus * remaining);
}

export function points(correctness: number, answeredMs: number, questionMs: number, cfg: ScoringConfig): number {
  if (correctness <= 0) return 0;
  return Math.round(correctness * (cfg.basePoints + speedBonus(answeredMs, questionMs, cfg.maxSpeedBonus)));
}

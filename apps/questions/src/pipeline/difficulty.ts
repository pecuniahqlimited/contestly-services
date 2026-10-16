/**
 * Difficulty estimate for a question that has never been played: the spec's requested band,
 * nudged by format (ordering and matching ask more of a player than picking one option).
 * Marked "model_estimate" — record_play recalibrates from real answer rates and flips the
 * provenance to "play_stats" once a question has been answered enough.
 */
import type { Difficulty, QuestionFormat } from "@contestly/shared";

export const DIFFICULTY_TARGET: Record<Difficulty, number> = { easy: 0.25, mixed: 0.5, hard: 0.7, brutal: 0.85 };
const FORMAT_BUMP: Record<QuestionFormat, number> = { pick_one: 0, picture: 0, pick_all: 0.08, match: 0.1, order: 0.12 };

export interface DifficultyEstimate {
  value: number;
  source: "model_estimate";
}

export function estimateDifficulty(difficulty: Difficulty, format: QuestionFormat): DifficultyEstimate {
  const value = Math.min(1, Math.max(0, DIFFICULTY_TARGET[difficulty] + FORMAT_BUMP[format]));
  return { value: Math.round(value * 100) / 100, source: "model_estimate" };
}

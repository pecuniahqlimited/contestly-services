/**
 * The ladder engine: how a run moves. A run climbs stages in order; each stage plays up to `rounds`
 * rounds and is decided as soon as the outcome is certain (cleared once `toClear` are right, missed
 * once that's out of reach). Missing a stage ends the run; clearing the last one ends it too. A run's
 * points are the sum of the stages it cleared. No I/O and no clock: callers pass `now`.
 */
import { stageTypes, type ClimbGameType, type ClimbLadder, type ClimbStage } from "@contestly/shared";
import { pick, type Rng } from "./rng.js";

export type StageOutcome = "continue" | "cleared" | "missed";

export function stageOutcome(stage: Pick<ClimbStage, "rounds" | "toClear">, results: readonly boolean[]): StageOutcome {
  const right = results.filter(Boolean).length;
  if (right >= stage.toClear) return "cleared";
  if (right + (stage.rounds - results.length) < stage.toClear) return "missed";
  return "continue";
}

export interface RunPosition {
  /** 0-based stage being played. */
  stageIdx: number;
  stagesCleared: number;
  points: number;
}

export type RunStep =
  | { outcome: "continue"; position: RunPosition; ended: false }
  | { outcome: "cleared"; position: RunPosition; ended: boolean }
  | { outcome: "missed"; position: RunPosition; ended: true };

/** Where a run stands after a round, given every result so far in the current stage (that round included). */
export function afterRound(ladder: ClimbLadder, at: RunPosition, stageResults: readonly boolean[]): RunStep {
  const stage = ladder.stages[at.stageIdx];
  const outcome = stageOutcome(stage, stageResults);
  if (outcome === "continue") return { outcome, position: at, ended: false };
  if (outcome === "missed") return { outcome, position: at, ended: true };
  const cleared = { stageIdx: at.stageIdx, stagesCleared: at.stagesCleared + 1, points: at.points + stage.points };
  const last = at.stageIdx === ladder.stages.length - 1;
  return { outcome, ended: last, position: last ? cleared : { ...cleared, stageIdx: at.stageIdx + 1 } };
}

/** 0 at the first stage, 1 at the last: what generators scale difficulty by. */
export const stageLevel = (stageIdx: number, stageCount: number) => (stageCount <= 1 ? 0 : stageIdx / (stageCount - 1));

/** The type a new round in this stage plays: one of the stage's types that's switched on. */
export function pickRoundType(ladder: ClimbLadder, stageIdx: number, rng: Rng): ClimbGameType {
  const types = stageTypes(ladder, ladder.stages[stageIdx]);
  if (!types.length) throw new Error(`stage ${stageIdx + 1} has no game type switched on`); // the ladder schema refuses this
  return pick(rng, types);
}

// ---------------------------------------------------------------- timing

const SECOND_MS = 1000;

export const closesAt = (opensAtMs: number, seconds: number) => opensAtMs + seconds * SECOND_MS;
/** An answer counts if it arrives no later than the clock's end plus the network allowance. */
export const onTime = (receivedAtMs: number, closesAtMs: number, allowanceMs: number) => receivedAtMs <= closesAtMs + allowanceMs;
/** A round nobody answered is over once even a late answer couldn't count. */
export const expired = (nowMs: number, closesAtMs: number, allowanceMs: number) => nowMs > closesAtMs + allowanceMs;

/** When the next round opens: after the verdict's pause, or the longer stage break when a stage was just cleared. */
export function nextOpensAt(decidedAtMs: number, outcome: StageOutcome, pauses: { revealSeconds: number; stageBreakSeconds: number }) {
  return decidedAtMs + (outcome === "cleared" ? pauses.stageBreakSeconds : pauses.revealSeconds) * SECOND_MS;
}

// ---------------------------------------------------------------- Today's challenge

/** Up to maxPoints, shared evenly over the questions, for the ones right. */
export const challengePoints = (correct: number, total: number, maxPoints: number) => (total <= 0 ? 0 : Math.round((maxPoints * correct) / total));

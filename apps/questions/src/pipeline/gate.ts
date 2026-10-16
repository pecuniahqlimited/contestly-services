/**
 * The automated review gate for sealed mode, pure: a draft is accepted only when its payload is
 * schema-valid, the independent verification passed, it duplicates nothing, and the safety filter
 * passed. Precedence mirrors the pipeline order, so the recorded outcome names the first step
 * that killed a draft. "needs_source" is a rejection here: in sealed mode nobody can supply the
 * missing source, so it fails closed (a host edit can rescue it in curate mode, step 2b).
 */
import type { VerifyVerdict } from "../providers/types.js";
import { isDuplicate, type Neighbour } from "./dedupe.js";
import type { SafetyResult } from "@contestly/shared";

export type GateOutcome = "accepted" | "rejected_invalid" | "rejected_verify" | "rejected_dedupe" | "rejected_safety";

export interface GateInput {
  payloadValid: boolean;
  verify: VerifyVerdict;
  nearest: Neighbour | null;
  dedupeThreshold: number;
  safety: SafetyResult;
}

export function gateDraft(d: GateInput): GateOutcome {
  if (!d.payloadValid) return "rejected_invalid";
  if (d.verify.verdict !== "pass") return "rejected_verify";
  if (isDuplicate(d.nearest, d.dedupeThreshold)) return "rejected_dedupe";
  if (!d.safety.passed) return "rejected_safety";
  return "accepted";
}

/** The set is only sealable when play order and reserves are both fully covered. */
export class SetUnderfilled extends Error {
  constructor(have: number, need: number) {
    super(`gate filled ${have} of ${need} questions (count + reserves); failing closed`);
  }
}

export function assertSetFilled(have: number, need: number): void {
  if (have < need) throw new SetUnderfilled(have, need);
}

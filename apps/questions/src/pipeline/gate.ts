/**
 * The automated review gate, pure: a draft is accepted only when its payload is schema-valid, the
 * independent verification found it correct with at least one source, it duplicates nothing, and the
 * safety checks passed. Precedence mirrors the pipeline order, so the recorded outcome names the first
 * step that killed a draft. "unverifiable" is a rejection in both modes: nobody can supply the missing
 * source (rescuing it with a host edit isn't built, ADR 0003).
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
  if (d.verify.verdict !== "correct" || d.verify.sources.length === 0) return "rejected_verify";
  if (isDuplicate(d.nearest, d.dedupeThreshold)) return "rejected_dedupe";
  if (!d.safety.passed) return "rejected_safety";
  return "accepted";
}

/** The set is only sealable when play order and reserves are both fully covered. */
export class SetUnderfilled extends Error {
  /** `unavailable`: provider steps that couldn't answer, so the fill was bank-only from there. */
  constructor(have: number, need: number, readonly unavailable: string[] = []) {
    super(`gate filled ${have} of ${need} questions (count + reserves)${unavailable.length ? `, ${unavailable.join(", ")} unavailable` : ""}; failing closed`);
  }
}

export function assertSetFilled(have: number, need: number, unavailable: string[] = []): void {
  if (have < need) throw new SetUnderfilled(have, need, unavailable);
}

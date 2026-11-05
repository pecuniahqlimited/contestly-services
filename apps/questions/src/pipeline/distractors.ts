/**
 * suggest_distractors (ADR 0015): three wrong options for a host-written question. The host's own words go
 * through the safety filter first, failing closed; then one generation call; then every candidate through the
 * filter too, dropping any that repeat the answer or each other. Fewer than three left is a failure, never a
 * short list. The API waits for this job and answers the builder with its result.
 */
import { DISTRACTOR_COUNT, checkHostText } from "@contestly/shared";
import type { Generator } from "../providers/types.js";

/** Ask for a few more than needed, so the filter has something to drop. */
const CANDIDATES = DISTRACTOR_COUNT + 3;

export class UnsafeHostText extends Error {
  constructor(readonly reasons: string[]) { super(`unsafe_host_text: ${reasons.join(", ")}`); }
}
export class NoSafeDistractors extends Error {
  constructor(have: number) { super(`no_safe_distractors: ${have} of ${DISTRACTOR_COUNT} passed`); }
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

export async function suggestDistractors(input: { question: string; answer: string; brief: string }, deps: { generator: Generator }): Promise<{ distractors: string[] }> {
  const own = checkHostText({ question: input.question, answer: input.answer }, input.brief);
  if (!own.passed) throw new UnsafeHostText(own.reasons);
  const candidates = await deps.generator.distract({ ...input, count: CANDIDATES });
  const seen = new Set([norm(input.answer)]);
  const kept: string[] = [];
  for (const c of candidates) {
    const text = typeof c === "string" ? c.trim() : "";
    if (!text || seen.has(norm(text))) continue;
    if (!checkHostText({ question: input.question, answer: text }, input.brief).passed) continue;
    seen.add(norm(text));
    kept.push(text);
    if (kept.length === DISTRACTOR_COUNT) return { distractors: kept };
  }
  throw new NoSafeDistractors(kept.length);
}

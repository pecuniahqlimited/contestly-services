/**
 * suggest_distractors (ADR 0015): three wrong options for a host-written question. The host's own words go
 * through the term filter first; then one generation call; then each candidate through the term filter too,
 * dropping any that repeat the answer or each other; then the model safety check on the host's words and every
 * candidate left, in one call. Everything fails closed: unsafe host words are refused, a model check that can't
 * run gives no suggestions, and fewer than three passing is a failure, never a short list. The API waits for this
 * job and answers the builder with its result.
 */
import { ProviderUnavailable } from "@contestly/ai";
import { DISTRACTOR_COUNT, checkHostText, parseExclusions, type SafetyBrief } from "@contestly/shared";
import type { Generator, SafetyReviewer } from "../providers/types.js";

/** Ask for a few more than needed, so the filters have something to drop. */
const CANDIDATES = DISTRACTOR_COUNT + 3;

export class UnsafeHostText extends Error {
  constructor(readonly reasons: string[]) { super(`unsafe_host_text: ${reasons.join(", ")}`); }
}
export class NoSafeDistractors extends Error {
  constructor(have: number) { super(`no_safe_distractors: ${have} of ${DISTRACTOR_COUNT} passed`); }
}
/** The model safety check couldn't run: no suggestions (fail closed), and the builder may try again. */
export class SafetyUnavailable extends Error {
  constructor(cause: string) { super(`safety_unavailable: ${cause}`); }
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** The host's question as the model reviewer reads it: their answer, and then with one candidate beside it. */
const asItem = (question: string, options: string[]) => ({ format: "pick_one" as const, payload: { question, options, correctIndex: 0 } });

export async function suggestDistractors(input: { question: string; answer: string; brief: string }, deps: { generator: Generator; safety: SafetyReviewer }): Promise<{ distractors: string[] }> {
  const own = checkHostText({ question: input.question, answer: input.answer }, input.brief);
  if (!own.passed) throw new UnsafeHostText(own.reasons);
  const candidates = await deps.generator.distract({ ...input, count: CANDIDATES });
  const seen = new Set([norm(input.answer)]);
  const terms: string[] = [];
  for (const c of candidates) {
    const text = typeof c === "string" ? c.trim() : "";
    if (!text || seen.has(norm(text))) continue;
    if (!checkHostText({ question: input.question, answer: text }, input.brief).passed) continue;
    seen.add(norm(text));
    terms.push(text);
  }
  if (terms.length < DISTRACTOR_COUNT) throw new NoSafeDistractors(terms.length);

  const brief: SafetyBrief = { topic: input.brief, exclusions: parseExclusions(input.brief), hostWritten: true };
  let results: Awaited<ReturnType<SafetyReviewer["review"]>>;
  try {
    results = await deps.safety.review(brief, [asItem(input.question, [input.answer]), ...terms.map((t) => asItem(input.question, [input.answer, t]))]);
  } catch (err) {
    if (err instanceof ProviderUnavailable) throw new SafetyUnavailable(err.message);
    throw err;
  }
  const [mine, ...theirs] = results;
  if (!mine?.passed) throw new UnsafeHostText(mine?.reasons ?? ["no_verdict"]);
  const kept = terms.filter((_, i) => theirs[i]?.passed);
  if (kept.length < DISTRACTOR_COUNT) throw new NoSafeDistractors(kept.length);
  return { distractors: kept.slice(0, DISTRACTOR_COUNT) };
}

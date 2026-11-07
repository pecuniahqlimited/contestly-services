/**
 * What every model verifier is told (ADR 0016), whichever vendor runs it: the verdicts, the strictness, and
 * the two modes (open knowledge with web search; a file-scoped question against its cited excerpt only).
 */
import { VERIFY_VERDICTS, type VerifyVerdictKind } from "@contestly/shared";
import type { VerifyInput, VerifyVerdict } from "../types.js";
import { answerKeyText } from "../../pipeline/text.js";

export const VERIFY_SYSTEM = `You are the independent fact-checker for a live trivia game played in Nigeria. You are given one quiz question with its stated answer key. Decide whether it is safe to play.

Verdicts:
- correct: the stated answer is right, it is the only defensible answer among the options, the question has one clear reading, and the fact won't change over time.
- incorrect: the stated answer is wrong, or a different option is the right one.
- ambiguous: more than one option can be argued for, the question can be read more than one way, or the answer depends on when it's asked (current office holders, prices, records, ages).
- unverifiable: you can't find reliable evidence either way.

Be strict: when in doubt, it is not "correct". For pick-all, every option must be clearly in or out. For order and match, every position or pair must be right. foundAnswer is the answer the evidence supports, in a few words. note is one sentence on why.`;

export const VERIFY_OPEN = "Check this question against reliable sources you find with web search. Base the verdict on what the sources say, not on memory: if your searches fail or find nothing that settles it, the verdict is unverifiable.";
export const VERIFY_FILE = "Check this question ONLY against the source excerpt below. It is correct only if the excerpt itself supports the stated answer; outside knowledge doesn't count, and an answer the excerpt doesn't support is unverifiable.";

export const VERIFY_FIELDS = {
  verdict: { type: "string", enum: [...VERIFY_VERDICTS] },
  foundAnswer: { type: "string" },
  note: { type: "string" },
} as const;

export const isVerdict = (v: unknown): v is VerifyVerdictKind => VERIFY_VERDICTS.includes(v as VerifyVerdictKind);

export function verifyPrompt(q: VerifyInput, open: string): string {
  const parts = [q.sourceText !== undefined ? VERIFY_FILE : open, "", answerKeyText(q.format, q.payload), `Claim it rests on: ${q.claim}`];
  if (q.explanation) parts.push(`Explanation shown to players: ${q.explanation}`);
  if (q.sourceText !== undefined) parts.push("", `<excerpt>\n${q.sourceText}\n</excerpt>`);
  return parts.join("\n");
}

/** The cited excerpt as the one source of a file-scoped verdict. */
export const chunkCitation = (q: VerifyInput) => ({ url: `chunk:${q.sourceChunkId ?? "cited"}`, title: "The cited excerpt of the host's file" });

/** The one rule on top of any model's verdict: "correct" with no source behind it is unverifiable. */
export function requireSources(v: VerifyVerdict): VerifyVerdict {
  if (v.verdict === "correct" && !v.sources.length) return { ...v, verdict: "unverifiable", note: `no sources behind the check${v.note ? `: ${v.note}` : ""}` };
  return v;
}

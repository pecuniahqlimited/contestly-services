/**
 * What every model verifier is told (ADR 0016), whichever vendor runs it: the verdicts, the strictness, and
 * the two modes (open knowledge with web search; a file-scoped question against its cited excerpt only).
 */
import { VERIFY_VERDICTS, type VerifyVerdictKind } from "@contestly/shared";
import type { VerifyInput, VerifyVerdict } from "../types.js";
import { answerKeyText } from "../../pipeline/text.js";

export const VERIFY_SYSTEM = `You are the independent fact-checker for a live trivia game played in Nigeria. You are given quiz questions, each with an id and its stated answer key. Decide for each one, on its own, whether it is safe to play, and give exactly one verdict per id.

Verdicts:
- correct: the stated answer is right, it is the only defensible answer among the options, the question has one clear reading, and the fact won't change over time.
- incorrect: the stated answer is wrong, or a different option is the right one.
- ambiguous: more than one option can be argued for, the question can be read more than one way, or the answer depends on when it's asked (current office holders, prices, records, ages).
- unverifiable: you can't find reliable evidence either way.

Be strict: when in doubt, it is not "correct". For pick-all, every option must be clearly in or out. For order and match, every position or pair must be right. foundAnswer is the answer the evidence supports, in a few words. note is one sentence on why.`;

export const VERIFY_OPEN = "Check each question against reliable sources you find with web search. Base each verdict on what the sources say, not on memory: if your searches fail or find nothing that settles it, the verdict is unverifiable.";
export const VERIFY_FILE = "A question with an <excerpt> is checked ONLY against that excerpt. It is correct only if the excerpt itself supports the stated answer; outside knowledge doesn't count, and an answer the excerpt doesn't support is unverifiable.";

export const VERIFY_FIELDS = {
  id: { type: "string" },
  verdict: { type: "string", enum: [...VERIFY_VERDICTS] },
  foundAnswer: { type: "string" },
  note: { type: "string" },
} as const;

export const isVerdict = (v: unknown): v is VerifyVerdictKind => VERIFY_VERDICTS.includes(v as VerifyVerdictKind);

/** One question of a batch, with the id its verdict must carry. */
export function questionBlock(id: string, q: VerifyInput): string {
  const parts = [`<question id="${id}">`, answerKeyText(q.format, q.payload), `Claim it rests on: ${q.claim}`];
  if (q.explanation) parts.push(`Explanation shown to players: ${q.explanation}`);
  if (q.sourceText !== undefined) parts.push(`<excerpt>\n${q.sourceText}\n</excerpt>`);
  parts.push("</question>");
  return parts.join("\n");
}

/** A batch's prompt: the rule for open questions (and file-scoped ones when any has an excerpt), then each question. */
export function verifyPrompt(items: { id: string; q: VerifyInput }[], open: string): string {
  const rules = [open];
  if (items.some((i) => i.q.sourceText !== undefined)) rules.push(VERIFY_FILE);
  return [...rules, `${items.length === 1 ? "One question" : `${items.length} questions`}. Answer with one verdict for each id, nothing else.`, "", ...items.map((i) => questionBlock(i.id, i.q))].join("\n");
}

/** The cited excerpt as the one source of a file-scoped verdict. */
export const chunkCitation = (q: VerifyInput) => ({ url: `chunk:${q.sourceChunkId ?? "cited"}`, title: "The cited excerpt of the host's file" });

/** The one rule on top of any model's verdict: "correct" with no source behind it is unverifiable. */
export function requireSources(v: VerifyVerdict): VerifyVerdict {
  if (v.verdict === "correct" && !v.sources.length) return { ...v, verdict: "unverifiable", note: `no sources behind the check${v.note ? `: ${v.note}` : ""}` };
  return v;
}

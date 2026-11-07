/**
 * What every model safety reviewer is told (ADR 0016), whichever vendor runs it: everything in CLAUDE.md's
 * step 7, and how a reply maps to results. Fails closed: an item the reply leaves out, or a reason it can't
 * name, is not passed.
 */
import { wantsPolitics, type SafetyBrief, type SafetyResult } from "@contestly/shared";
import type { SafetyReviewer } from "../types.js";
import { answerKeyText } from "../../pipeline/text.js";

export const SAFETY_REASONS = ["profanity", "hate", "sexual", "private_individual", "gambling_promo", "alcohol_promo", "politics", "excluded_topic", "other_harm"] as const;

export const SAFETY_SYSTEM = `You review quiz questions for a live trivia game for a general Nigerian audience, including teenagers, before they are played. For each question decide whether it is safe and in good taste. A question fails if it:
- profanity: contains swearing or crude language;
- hate: demeans or stereotypes people by ethnicity, tribe, religion, gender, disability or similar;
- sexual: has sexual content or innuendo;
- private_individual: is about a real person who isn't a public figure, or exposes private details of anyone;
- gambling_promo: promotes betting, betting brands or gambling;
- alcohol_promo: promotes drinking or alcohol brands;
- politics: is about politics, parties, elections or politicians' records, when the brief didn't ask for politics;
- excluded_topic: touches a topic the brief excluded;
- other_harm: is otherwise harmful, dangerous or cruel.
Neutral mentions are fine (a footballer's club, a beer brand's founding year asked as history is still alcohol_promo only if it promotes). Judge each question on its own. List every reason that applies; an empty list means safe.`;

/** The reply's shape. additionalProperties: false keeps it valid for Claude's structured output too. */
export const SAFETY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { index: { type: "integer" }, safe: { type: "boolean" }, reasons: { type: "array", items: { type: "string", enum: [...SAFETY_REASONS] } } },
        required: ["index", "safe", "reasons"],
      },
    },
  },
  required: ["results"],
};

type Items = Parameters<SafetyReviewer["review"]>[1];

/**
 * Host-written questions (ADR 0015) are about the party's own people by design: private_individual is narrowed
 * for them, never dropped.
 */
export const HOST_WRITTEN_NOTE = `Written by: the party's host, about the people at this party (friends, family or colleagues), who play it together. Naming them and asking about shared memories is expected and is not private_individual. Mark private_individual only if a question exposes sensitive private details (health, sexuality, money, an address, phone number or ID, a criminal accusation) or would humiliate or demean someone. Every other reason applies as usual.`;

export function safetyPrompt(brief: SafetyBrief, items: Items): string {
  return [
    `Brief: ${brief.topic}`,
    `Politics asked for: ${wantsPolitics(brief) ? "yes" : "no"}`,
    `Excluded topics: ${brief.exclusions.length ? brief.exclusions.join("; ") : "none"}`,
    ...(brief.hostWritten ? [HOST_WRITTEN_NOTE] : []),
    "",
    ...items.map((it, i) => `<question index="${i}">\n${answerKeyText(it.format, it.payload)}${it.explanation ? `\nExplanation: ${it.explanation}` : ""}\n</question>`),
  ].join("\n");
}

/** One result per item, in order; anything the reply doesn't settle fails. */
export function safetyResults(reply: unknown, count: number): SafetyResult[] {
  const results = ((reply as { results?: unknown[] })?.results ?? []) as { index?: number; safe?: boolean; reasons?: string[] }[];
  return Array.from({ length: count }, (_, i): SafetyResult => {
    const r = results.find((x) => x.index === i);
    if (!r || typeof r.safe !== "boolean") return { passed: false, reasons: ["no_verdict"] };
    const reasons = (r.reasons ?? []).map((x) => (SAFETY_REASONS.includes(x as never) ? `model:${x}` : "model:unknown_reason"));
    return reasons.length || !r.safe ? { passed: false, reasons: reasons.length ? reasons : ["model:unsafe"] } : { passed: true, reasons: [] };
  });
}

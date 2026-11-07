/**
 * The model safety and taste check (ADR 0016), one Gemini call per batch of drafts that already passed the
 * term filter and verification. Everything in CLAUDE.md's step 7. Fails closed: an item the reply leaves out,
 * or a reason it can't name, is not passed.
 */
import { geminiGenerate, providerCall, type CallDeps, type GeminiClient } from "@contestly/ai";
import { wantsPolitics, type PricedModel, type SafetyResult } from "@contestly/shared";
import type { SafetyReviewer } from "../types.js";
import { answerKeyText } from "../../pipeline/text.js";

export const SAFETY_REASONS = ["profanity", "hate", "sexual", "private_individual", "gambling_promo", "alcohol_promo", "politics", "excluded_topic", "other_harm"] as const;

export interface GeminiSafetyDeps {
  client: GeminiClient;
  call: CallDeps;
  model: () => Promise<PricedModel>;
}

const SYSTEM = `You review quiz questions for a live trivia game for a general Nigerian audience, including teenagers, before they are played. For each question decide whether it is safe and in good taste. A question fails if it:
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

const SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: { index: { type: "integer" }, safe: { type: "boolean" }, reasons: { type: "array", items: { type: "string", enum: [...SAFETY_REASONS] } } },
        required: ["index", "safe", "reasons"],
      },
    },
  },
  required: ["results"],
};

export function geminiSafety(deps: GeminiSafetyDeps): SafetyReviewer {
  return {
    name: "gemini",
    async review(brief, items) {
      if (!items.length) return [];
      const model = await deps.model();
      const text = [
        `Brief: ${brief.topic}`,
        `Politics asked for: ${wantsPolitics(brief) ? "yes" : "no"}`,
        `Excluded topics: ${brief.exclusions.length ? brief.exclusions.join("; ") : "none"}`,
        "",
        ...items.map((it, i) => `<question index="${i}">\n${answerKeyText(it.format, it.payload)}${it.explanation ? `\nExplanation: ${it.explanation}` : ""}\n</question>`),
      ].join("\n");
      const answer = await providerCall({ provider: "gemini", model, step: "safety" }, deps.call, (signal) =>
        geminiGenerate(deps.client, { model, system: SYSTEM, parts: [{ text }], schema: SCHEMA, thinkingLevel: "low" }, signal));
      const results = ((answer.json as { results?: unknown[] })?.results ?? []) as { index?: number; safe?: boolean; reasons?: string[] }[];
      return items.map((_, i): SafetyResult => {
        const r = results.find((x) => x.index === i);
        if (!r || typeof r.safe !== "boolean") return { passed: false, reasons: ["no_verdict"] };
        const reasons = (r.reasons ?? []).map((x) => (SAFETY_REASONS.includes(x as never) ? `model:${x}` : "model:unknown_reason"));
        return reasons.length || !r.safe ? { passed: false, reasons: reasons.length ? reasons : ["model:unsafe"] } : { passed: true, reasons: [] };
      });
    },
  };
}

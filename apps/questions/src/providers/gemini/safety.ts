/**
 * The model safety and taste check on Gemini (ADR 0016; an option, Claude is the default): one call per batch
 * of drafts that already passed the term filter and verification. Prompt and fail-closed mapping in
 * checks/safetyPrompt.ts.
 */
import { geminiGenerate, providerCall, type CallDeps, type GeminiClient } from "@contestly/ai";
import type { PricedModel } from "@contestly/shared";
import type { SafetyReviewer } from "../types.js";
import { SAFETY_SCHEMA, SAFETY_SYSTEM, safetyPrompt, safetyResults } from "../checks/safetyPrompt.js";

export interface GeminiSafetyDeps {
  client: GeminiClient;
  call: CallDeps;
  model: () => Promise<PricedModel>;
}

export function geminiSafety(deps: GeminiSafetyDeps): SafetyReviewer {
  return {
    name: "gemini",
    async review(brief, items) {
      if (!items.length) return [];
      const model = await deps.model();
      const answer = await providerCall({ provider: "gemini", model, step: "safety" }, deps.call, (signal) =>
        geminiGenerate(deps.client, { model, system: SAFETY_SYSTEM, parts: [{ text: safetyPrompt(brief, items) }], schema: SAFETY_SCHEMA, thinkingLevel: "low" }, signal));
      return safetyResults(answer.json, items.length).map((r) => ({ ...r, reviewedBy: model }));
    },
  };
}

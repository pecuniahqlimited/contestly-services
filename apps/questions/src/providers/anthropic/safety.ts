/**
 * The model safety and taste check on Claude (ADR 0016; the default, a small model): one structured call per
 * batch of drafts that already passed the term filter and verification. Prompt and fail-closed mapping in
 * checks/safetyPrompt.ts.
 */
import { claudeJson, providerCall, type CallDeps, type ClaudeClient } from "@contestly/ai";
import type { PricedModel } from "@contestly/shared";
import type { SafetyReviewer } from "../types.js";
import { SAFETY_SCHEMA, SAFETY_SYSTEM, safetyPrompt, safetyResults } from "../checks/safetyPrompt.js";

/** A batch is at most the round's drafts; each result is a few tokens. */
const MAX_TOKENS = 4_000;

export interface ClaudeSafetyDeps {
  client: ClaudeClient;
  call: CallDeps;
  model: () => Promise<PricedModel>;
}

export function claudeSafety(deps: ClaudeSafetyDeps): SafetyReviewer {
  return {
    name: "anthropic",
    async review(brief, items) {
      if (!items.length) return [];
      const model = await deps.model();
      const { json } = await providerCall({ provider: "anthropic", model, step: "safety" }, deps.call, (signal) =>
        claudeJson(deps.client, { model, system: SAFETY_SYSTEM, user: safetyPrompt(brief, items), schema: SAFETY_SCHEMA, maxTokens: MAX_TOKENS, effort: "low" }, signal));
      return safetyResults(json, items.length).map((r) => ({ ...r, reviewedBy: model }));
    },
  };
}

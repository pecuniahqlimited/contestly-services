/** Gemini writes the questions (the free profile, ADR 0016): a free-tier model, structured output, no grounding. */
import { geminiGenerate, providerCall, type CallDeps, type GeminiClient } from "@contestly/ai";
import type { CallTier, PricedModel } from "@contestly/shared";
import type { Generator } from "../types.js";
import { MAX_TOKENS, structuredGenerator } from "../drafting/generator.js";

export interface GeminiGeneratorDeps {
  client: GeminiClient;
  call: CallDeps;
  model: () => Promise<PricedModel>;
  tier: CallTier;
}

export function geminiGenerator(deps: GeminiGeneratorDeps): Generator {
  return structuredGenerator({
    provider: "gemini",
    model: deps.model,
    ask: async ({ model, system, user, schema }) => (await providerCall({ provider: "gemini", model, step: "generate", tier: deps.tier }, deps.call, (signal) =>
      geminiGenerate(deps.client, { model, system, parts: [{ text: user }], schema, thinkingLevel: "medium", maxOutputTokens: MAX_TOKENS }, signal))).json,
  });
}

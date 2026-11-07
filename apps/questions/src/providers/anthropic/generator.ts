/** Claude writes the questions (the paid profile, ADR 0016): adaptive thinking at medium effort, structured output. */
import { claudeJson, providerCall, type CallDeps, type ClaudeClient } from "@contestly/ai";
import type { PricedModel } from "@contestly/shared";
import type { Generator } from "../types.js";
import { MAX_TOKENS, structuredGenerator } from "../drafting/generator.js";

export interface AnthropicGeneratorDeps {
  client: ClaudeClient;
  call: CallDeps;
  model: () => Promise<PricedModel>;
}

export function anthropicGenerator(deps: AnthropicGeneratorDeps): Generator {
  return structuredGenerator({
    provider: "anthropic",
    model: deps.model,
    ask: async ({ model, system, user, schema }) => (await providerCall({ provider: "anthropic", model, step: "generate" }, deps.call, (signal) =>
      claudeJson(deps.client, { model, system, user, schema, maxTokens: MAX_TOKENS, effort: "medium" }, signal))).json,
  });
}

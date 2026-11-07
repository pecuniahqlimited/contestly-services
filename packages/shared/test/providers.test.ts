import { describe, expect, it } from "vitest";
import { DEFAULT_PROVIDERS_CONFIG, estimateCostMicros, providerOf, providersConfigSchema } from "../src/index.js";

describe("provider costs", () => {
  it("prices tokens and each vendor's web search", () => {
    // Opus 5.5: 10k in × $4 + 500 out × $20 per M = $0.05, plus 2 searches at $10 per 1,000
    expect(estimateCostMicros("claude-opus-5-5", { inputTokens: 10_000, outputTokens: 500, searchQueries: 2 })).toBe(70_000);
    // Gemini grounding is $14 per 1,000
    expect(estimateCostMicros("gemini-3.8-flash", { inputTokens: 0, outputTokens: 0, searchQueries: 1 })).toBe(14_000);
  });
});

describe("provider config", () => {
  const withModels = (models: Record<string, string>) => providersConfigSchema.safeParse({ ...DEFAULT_PROVIDERS_CONFIG, models: { ...DEFAULT_PROVIDERS_CONFIG.models, ...models } });

  it("defaults to Claude for every model step, the verifier on a different model from the generator", () => {
    const m = DEFAULT_PROVIDERS_CONFIG.models;
    expect([m.generate, m.verify, m.safety].map((x) => providerOf(x))).toEqual(["anthropic", "anthropic", "anthropic"]);
    expect(m.verify).not.toBe(m.generate);
    expect(providersConfigSchema.safeParse(DEFAULT_PROVIDERS_CONFIG).success).toBe(true);
  });

  it("lets verify and safety be either vendor's chat model, never the generator's model or a non-chat model", () => {
    expect(withModels({ verify: "gemini-3.8-flash", safety: "gemini-3.5-flash-lite" }).success).toBe(true);
    expect(withModels({ verify: "claude-sonnet-5-5" }).success).toBe(false);
    expect(withModels({ verify: "gemini-embedding-2" }).success).toBe(false);
    expect(withModels({ safety: "gemini-3.5-transcribe" }).success).toBe(false);
    expect(withModels({ generate: "gemini-3.8-flash" }).success).toBe(false);
  });
});

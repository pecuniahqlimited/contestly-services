/**
 * AI providers behind the question engine and voice-note transcription (ADR 0016): the priced model list,
 * the steps a call can be made for, and the admin-editable budget and per-step models. Prices are USD per
 * million tokens (or per thousand search queries), checked against the providers' pricing pages on
 * 7 Nov 2026. This table is the only place a price lives; costs are recorded in integer micro-USD.
 */
import { z } from "zod";

export const PROVIDER_NAMES = ["anthropic", "gemini"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

/** What a call was for. One row per call in provider_calls, tied to a party when there is one. */
export const PROVIDER_STEPS = ["generate", "verify", "safety", "embed", "transcribe"] as const;
export type ProviderStep = (typeof PROVIDER_STEPS)[number];

/** What a model is for: chat models write, check and review; the others only embed or transcribe. */
export type ModelUse = "chat" | "embed" | "transcribe";

export interface ModelPrice {
  provider: ProviderName;
  use: ModelUse;
  /** USD per 1M input tokens (text). */
  inputPerM: number;
  /** USD per 1M output tokens, thinking included. */
  outputPerM: number;
  /** USD per 1M cached input tokens read. */
  cachedInputPerM?: number;
  /** USD per 1M audio input tokens, where audio is priced apart. */
  audioInputPerM?: number;
}

export const PROVIDER_PRICES = {
  "claude-opus-5-5": { provider: "anthropic", use: "chat", inputPerM: 4, outputPerM: 20, cachedInputPerM: 0.2 },
  "claude-sonnet-5-5": { provider: "anthropic", use: "chat", inputPerM: 2, outputPerM: 10, cachedInputPerM: 0.1 },
  "claude-haiku-5-5": { provider: "anthropic", use: "chat", inputPerM: 0.1, outputPerM: 0.5, cachedInputPerM: 0.01 },
  "gemini-4-argon": { provider: "gemini", use: "chat", inputPerM: 2, outputPerM: 10, cachedInputPerM: 0.1 },
  "gemini-3.8-flash": { provider: "gemini", use: "chat", inputPerM: 0.75, outputPerM: 3.75, cachedInputPerM: 0.075 },
  "gemini-3.5-flash-lite": { provider: "gemini", use: "chat", inputPerM: 0.3, outputPerM: 2.5, cachedInputPerM: 0.03 },
  "gemini-3.1-flash-lite": { provider: "gemini", use: "chat", inputPerM: 0.25, outputPerM: 1.5, cachedInputPerM: 0.025, audioInputPerM: 0.5 },
  "gemini-3.5-transcribe": { provider: "gemini", use: "transcribe", inputPerM: 2, outputPerM: 12, audioInputPerM: 2 },
  "gemini-embedding-2": { provider: "gemini", use: "embed", inputPerM: 0.2, outputPerM: 0 },
} as const satisfies Record<string, ModelPrice>;
export type PricedModel = keyof typeof PROVIDER_PRICES;
export const PRICED_MODELS = Object.keys(PROVIDER_PRICES) as PricedModel[];

/**
 * Web search, per query the model runs, on top of tokens: Claude's web search tool ($10 per 1000) and Gemini's
 * Google Search grounding on Gemini 3+ ($14 per 1000, after a free monthly allowance we don't count on).
 */
export const SEARCH_USD_PER_QUERY: Record<ProviderName, number> = { anthropic: 10 / 1000, gemini: 14 / 1000 };

export const MICRO_USD_PER_USD = 1_000_000;
export const MICRO_USD_PER_CENT = 10_000;

export interface CallUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  audioInputTokens?: number;
  searchQueries?: number;
}

/** Estimated cost of one call in integer micro-USD. Cached and audio input are priced apart from the rest of the input. */
export function estimateCostMicros(model: PricedModel, u: CallUsage): number {
  const p: ModelPrice = PROVIDER_PRICES[model];
  const cached = u.cachedInputTokens ?? 0;
  const audio = u.audioInputTokens ?? 0;
  const plainInput = Math.max(0, u.inputTokens - cached - audio);
  const usd =
    (plainInput * p.inputPerM + cached * (p.cachedInputPerM ?? p.inputPerM) + audio * (p.audioInputPerM ?? p.inputPerM) + u.outputTokens * p.outputPerM) / 1_000_000 +
    (u.searchQueries ?? 0) * SEARCH_USD_PER_QUERY[p.provider];
  return Math.round(usd * MICRO_USD_PER_USD);
}

const pricedModel = z.enum(PRICED_MODELS as [PricedModel, ...PricedModel[]]);
const chatModel = pricedModel.refine((m) => PROVIDER_PRICES[m].use === "chat", "must be a chat model");
const chatModelOf = (provider: ProviderName) => chatModel.refine((m) => PROVIDER_PRICES[m].provider === provider, `must be a ${provider} model`);

/** The vendor a priced model belongs to: verification and safety follow the model the admin picked. */
export const providerOf = (model: PricedModel): ProviderName => PROVIDER_PRICES[model].provider;

/** The question engine's provider settings: admin config under questions.providers. */
export const providersConfigSchema = z.object({
  /**
   * Per step, which model. Only priced chat models, so every call has a cost; embed and transcribe models are
   * env (changing the embedder means re-embedding). Verify and safety may be either vendor's: the model picks
   * the vendor. The verifier is never the generator's model (ADR 0016).
   */
  models: z.object({
    generate: chatModelOf("anthropic"),
    verify: chatModel,
    safety: chatModel,
  }).refine((m) => m.verify !== m.generate, { message: "the verifier must be a different model from the generator", path: ["verify"] }),
  /** A party's provider spend stops here (US cents, all steps); the set then falls back to the bank. */
  perPartyCents: z.number().int().min(1).max(100_000),
  /** All providers, per day (Africa/Lagos), US cents. Reached: every call is refused until midnight. */
  dailyCents: z.number().int().min(1).max(10_000_000),
  /** The day's spend crossing this share of dailyCents raises a warning alert. */
  alertAtPct: z.number().int().min(1).max(100),
});
export type ProvidersConfig = z.infer<typeof providersConfigSchema>;

export const DEFAULT_PROVIDERS_CONFIG: ProvidersConfig = {
  models: { generate: "claude-sonnet-5-5", verify: "claude-opus-5-5", safety: "claude-haiku-5-5" },
  perPartyCents: 500,
  dailyCents: 2_500,
  alertAtPct: 80,
};

/** Verification verdicts (ADR 0016). Only "correct" passes the gate. Records from before keep pass | fail | needs_source. */
export const VERIFY_VERDICTS = ["correct", "incorrect", "ambiguous", "unverifiable"] as const;
export type VerifyVerdictKind = (typeof VERIFY_VERDICTS)[number];

/** Admin: the budget and per-step models, edited with a reason (logged). */
export const adminProvidersConfigBodySchema = z.object({ config: providersConfigSchema, reason: z.string().trim().min(3).max(500) });

/** Admin: provider usage, per day and per party, in micro-USD. */
export const adminProviderUsageQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(90).default(14) });
const usageTotals = { calls: z.number().int(), failed: z.number().int(), inputTokens: z.number().int(), outputTokens: z.number().int(), searchQueries: z.number().int(), costMicros: z.number().int() };
export const adminProviderUsageSchema = z.object({
  config: providersConfigSchema,
  today: z.object({ day: z.string(), costMicros: z.number().int(), dailyCapMicros: z.number().int() }),
  days: z.array(z.object({ day: z.string(), provider: z.string(), step: z.string(), model: z.string(), ...usageTotals })),
  parties: z.array(z.object({ partyId: z.string().uuid(), title: z.string(), ...usageTotals })),
});
export type AdminProviderUsage = z.infer<typeof adminProviderUsageSchema>;

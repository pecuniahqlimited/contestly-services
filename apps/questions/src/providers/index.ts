/**
 * Provider selection by profile (ADR 0016): AI_PROFILE = mock | free | paid, mock by default (tests, sims,
 * dev). A profile is a factory here, built once at start, failing at start when it can't run (a missing key;
 * the paid profile with paid providers off), and never falling back to another profile.
 *
 * - free: Gemini's free tier only. A free model writes, a stronger free model checks from its own knowledge
 *   (no grounding, which has no free quota; such verdicts are "checked without sources" and only this
 *   profile's gate accepts them), a third checks safety, and gemini-embedding-2 embeds. Every call is a
 *   free-tier call: counted against the model's daily quota and refused once it's spent.
 * - paid: the production setup. Claude writes; the admin's verify and safety models pick their vendor per
 *   call (Claude with web search by default, Gemini with Google Search as the option); Gemini embeds. Every
 *   call is paid, so it needs AI_PAID_CAP_USD above 0; with it unset or 0 the profile won't start, and any
 *   paid call anywhere is refused before it's made.
 *
 * Every real call goes through @contestly/ai providerCall: the paid cap, the free quotas, spend caps, a
 * breaker per provider and step, a timeout per step, retries, and a provider_calls row.
 */
import { aiProfileFromEnv, Breakers, claudeClient, DEFAULT_BREAKER, DEFAULT_RETRY, geminiClient, Limiters, paidCapMicrosFromEnv, ProviderUnavailable, type CallDeps, type RetryPolicy } from "@contestly/ai";
import { dbBudgetGate, dbFreeQuota, dbUsageSink, getQuestionsConfig } from "@contestly/db";
import { FREE_PROFILE_MODELS, FREE_TIER_LIMITS, PRICED_MODELS, providerOf, type AiProfile, type PricedModel, type ProviderName, type ProviderStep } from "@contestly/shared";
import { mockEmbedder } from "./mock/embedder.js";
import { mockGenerator } from "./mock/generator.js";
import { mockSafety } from "./mock/safety.js";
import { mockVerifier } from "./mock/verifier.js";
import { anthropicGenerator } from "./anthropic/generator.js";
import { claudeVerifier } from "./anthropic/verifier.js";
import { claudeSafety } from "./anthropic/safety.js";
import { geminiGenerator } from "./gemini/generator.js";
import { geminiVerifier } from "./gemini/verifier.js";
import { geminiSafety } from "./gemini/safety.js";
import { geminiEmbedder } from "./gemini/embedder.js";
import { cachedVerifier, dbVerificationCache, type VerificationCache } from "./cachedVerifier.js";
import type { Providers, SafetyReviewer, Verifier } from "./types.js";

/** Per attempt. Generation thinks and writes a batch; verification searches; the rest are quick. */
export const STEP_TIMEOUT_MS: Record<ProviderStep, number> = { generate: 180_000, verify: 90_000, safety: 45_000, embed: 30_000, transcribe: 60_000 };
/**
 * Retries per step. Embeddings wait out a per-minute rate limit (Gemini says when to come back, often
 * 10–60 s) rather than fail, so a re-embed runs slowly instead of stopping; a daily quota fails at once.
 */
export const STEP_RETRY: Partial<Record<ProviderStep, RetryPolicy>> = { embed: { attempts: 6, baseDelayMs: 2_000, maxDelayMs: 65_000 } };
export const DEFAULT_EMBED_MODEL: PricedModel = "gemini-embedding-2";

export const aiProfile = aiProfileFromEnv;

/** The shared call path, wired to Postgres. One breaker set and one free-tier limiter per model, per process. */
export function dbCallDeps(breakers = new Breakers(DEFAULT_BREAKER), limiters = new Limiters((m) => FREE_TIER_LIMITS[m]?.rpm)) {
  return (step: ProviderStep): CallDeps => ({
    sink: dbUsageSink, budget: dbBudgetGate, freeQuota: dbFreeQuota, limiters, breakers,
    retry: STEP_RETRY[step] ?? DEFAULT_RETRY, timeoutMs: STEP_TIMEOUT_MS[step],
  });
}

const modelFor = (step: "generate" | "verify" | "safety") => async () => (await getQuestionsConfig()).providers.models[step];
const fixed = (model: PricedModel) => async () => model;

export function pricedModel(name: string, envVar: string): PricedModel {
  if (!PRICED_MODELS.includes(name as PricedModel)) throw new Error(`${envVar}=${name} has no price in PROVIDER_PRICES (have: ${PRICED_MODELS.join(", ")})`);
  return name as PricedModel;
}

const key = (envVar: string) => process.env[envVar] ?? "";
type Deps = (step: ProviderStep) => CallDeps;

export const mockProviders = (): Providers => ({ generator: mockGenerator, verifier: mockVerifier, embedder: mockEmbedder, safety: mockSafety });

/** Gemini's free tier only (the client is injectable for tests). */
export function freeProviders(deps: Deps, client = geminiClient({ apiKey: key("GEMINI_API_KEY") }), cache: VerificationCache = dbVerificationCache): Providers {
  const m = FREE_PROFILE_MODELS;
  return {
    generator: geminiGenerator({ client, call: deps("generate"), model: fixed(m.generate), tier: "free" }),
    verifier: cachedVerifier(geminiVerifier({ client, call: deps("verify"), model: fixed(m.verify), mode: "unsourced", tier: "free" }), fixed(m.verify), cache),
    embedder: geminiEmbedder({ client, call: deps("embed"), model: m.embed, tier: "free" }),
    safety: geminiSafety({ client, call: deps("safety"), model: fixed(m.safety), tier: "free" }),
    allowUnsourced: true,
  };
}

/** The production setup. Refuses to start while paid providers are off (AI_PAID_CAP_USD unset or 0). */
export function paidProviders(deps: Deps): Providers {
  if (paidCapMicrosFromEnv() <= 0) throw new Error("AI_PROFILE=paid needs AI_PAID_CAP_USD above 0 (paid providers are off until it's set)");
  return {
    generator: anthropicGenerator({ client: claudeClient({ apiKey: key("ANTHROPIC_API_KEY") }), call: deps("generate"), model: modelFor("generate") }),
    verifier: liveVerifier(deps),
    embedder: geminiEmbedder({
      client: geminiClient({ apiKey: key("GEMINI_API_KEY") }), call: deps("embed"), tier: "paid",
      model: pricedModel(process.env.GEMINI_EMBED_MODEL ?? DEFAULT_EMBED_MODEL, "GEMINI_EMBED_MODEL"),
    }),
    safety: liveSafety(deps),
  };
}

type Clients = { anthropic: ReturnType<typeof claudeClient> | null; gemini: ReturnType<typeof geminiClient> | null };

/** Each vendor's client, when its key is set. */
function clients(): Clients {
  return {
    anthropic: key("ANTHROPIC_API_KEY") ? claudeClient({ apiKey: key("ANTHROPIC_API_KEY") }) : null,
    gemini: key("GEMINI_API_KEY") ? geminiClient({ apiKey: key("GEMINI_API_KEY") }) : null,
  };
}

/** The vendor of the step's current model, or a closed failure when that vendor's key isn't set. */
function routed<T>(step: "verify" | "safety", model: () => Promise<PricedModel>, byVendor: Partial<Record<ProviderName, T>>): () => Promise<T> {
  if (!Object.keys(byVendor).length) throw new Error(`no provider key is set for ${step} (ANTHROPIC_API_KEY or GEMINI_API_KEY)`);
  return async () => {
    const m = await model();
    const vendor = byVendor[providerOf(m)];
    if (!vendor) throw new ProviderUnavailable("auth", providerOf(m), step, `${m} is configured but ${providerOf(m) === "anthropic" ? "ANTHROPIC_API_KEY" : "GEMINI_API_KEY"} isn't set`);
    return vendor;
  };
}

/** The paid profile's verifier: the admin's model picks the vendor per call. Model and clients injectable for tests. */
export function liveVerifier(deps: Deps, model = modelFor("verify"), c = clients(), cache: VerificationCache = dbVerificationCache): Verifier {
  const pick = routed<Verifier>("verify", model, {
    ...(c.anthropic ? { anthropic: cachedVerifier(claudeVerifier({ client: c.anthropic, call: deps("verify"), model }), model, cache) } : {}),
    ...(c.gemini ? { gemini: cachedVerifier(geminiVerifier({ client: c.gemini, call: deps("verify"), model, mode: "grounded", tier: "paid" }), model, cache) } : {}),
  });
  return { name: "live", verify: async (q) => (await pick()).verify(q) };
}

export function liveSafety(deps: Deps, model = modelFor("safety"), c = clients()): SafetyReviewer {
  const pick = routed<SafetyReviewer>("safety", model, {
    ...(c.anthropic ? { anthropic: claudeSafety({ client: c.anthropic, call: deps("safety"), model }) } : {}),
    ...(c.gemini ? { gemini: geminiSafety({ client: c.gemini, call: deps("safety"), model, tier: "paid" }) } : {}),
  });
  return { name: "live", review: async (brief, items) => (items.length ? (await pick()).review(brief, items) : []) };
}

const profiles: Record<AiProfile, (deps: Deps) => Providers> = { mock: mockProviders, free: (d) => freeProviders(d), paid: paidProviders };

export function selectProviders(deps = dbCallDeps(), profile = aiProfile()): Providers {
  return profiles[profile](deps);
}

/** What's selected, for the start-up line and the eval report. */
export function providerNames(profile = aiProfile()): Record<"profile" | "generator" | "verifier" | "embedder" | "safety", string> {
  if (profile === "mock") return { profile, generator: "mock", verifier: "mock", embedder: "mock", safety: "mock" };
  if (profile === "free") {
    const m = FREE_PROFILE_MODELS;
    return { profile, generator: `gemini ${m.generate}`, verifier: `gemini ${m.verify}, no sources`, embedder: `gemini ${m.embed}`, safety: `gemini ${m.safety}` };
  }
  return { profile, generator: "anthropic (admin model)", verifier: "admin model, with web search", embedder: `gemini ${process.env.GEMINI_EMBED_MODEL ?? DEFAULT_EMBED_MODEL}`, safety: "admin model" };
}

export * from "./types.js";

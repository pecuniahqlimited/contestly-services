/**
 * The providers of each AI profile (ADR 0016) and the registry that hands a job the ones its route names. Which
 * profile runs is the AI routing config (admin, versioned, read when a job starts: the party's tier, or the default
 * profile), under the AI_ALLOWED_PROFILES ceiling; this file only builds each profile's set, once, on first use.
 * A profile that can't be built (a key that isn't set) is a set whose every call is unavailable, so generation
 * falls back to the bank and checks fail closed, as with any provider that can't answer.
 *
 * - mock: calls nothing (tests, sims, dev).
 * - free: Gemini's free tier only. The routing config's free models write, check (from the model's own knowledge:
 *   no grounding, which has no free quota; such verdicts are "checked without sources" and only this profile's
 *   gate accepts them) and review safety; gemini-embedding-2 embeds. Every call is counted against the model's
 *   daily quota and refused once it's spent.
 * - paid: the production setup. Claude writes; the routing config's verify and safety models pick their vendor per
 *   call (Claude with web search by default, Gemini with Google Search as the option); Gemini embeds. Every call is
 *   paid: with AI_PAID_CAP_USD unset or 0, providerCall refuses each before it's made.
 *
 * Models are read per call from the routing config, so an admin change applies to the next call.
 */
import { Breakers, claudeClient, DEFAULT_BREAKER, DEFAULT_RETRY, geminiClient, Limiters, ProviderUnavailable, type CallDeps, type RetryPolicy } from "@contestly/ai";
import { currentAiRouting, dbBudgetGate, dbFreeQuota, dbUsageSink, getQuestionsConfig } from "@contestly/db";
import { FREE_PROFILE_MODELS, FREE_TIER_LIMITS, PRICED_MODELS, providerOf, type AiProfile, type PricedModel, type ProviderName, type ProviderStep, type RoutedStep } from "@contestly/shared";
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
import { batchedVerifier } from "./batchedVerifier.js";
import type { Embedder, Providers, SafetyReviewer, Verifier } from "./types.js";

/** Per attempt. Generation thinks and writes a set; verification searches; the rest are quick. */
export const STEP_TIMEOUT_MS: Record<ProviderStep, number> = { generate: 180_000, verify: 90_000, safety: 45_000, embed: 30_000, transcribe: 60_000 };
/**
 * Retries per step. Embeddings wait out a per-minute rate limit (Gemini says when to come back, often
 * 10–60 s) rather than fail, so a re-embed runs slowly instead of stopping; a daily quota fails at once.
 */
export const STEP_RETRY: Partial<Record<ProviderStep, RetryPolicy>> = { embed: { attempts: 6, baseDelayMs: 2_000, maxDelayMs: 65_000 } };
export const DEFAULT_EMBED_MODEL: PricedModel = "gemini-embedding-2";

/** The shared call path, wired to Postgres. One breaker set and one free-tier limiter per model, per process. */
export function dbCallDeps(breakers = new Breakers(DEFAULT_BREAKER), limiters = new Limiters((m) => FREE_TIER_LIMITS[m]?.rpm)) {
  return (step: ProviderStep): CallDeps => ({
    sink: dbUsageSink, budget: dbBudgetGate, freeQuota: dbFreeQuota, limiters, breakers,
    retry: STEP_RETRY[step] ?? DEFAULT_RETRY, timeoutMs: STEP_TIMEOUT_MS[step],
  });
}

/** A profile's model for a step, read from the routing config per call. */
export type ModelOf = (step: RoutedStep) => () => Promise<PricedModel>;
const routedModel = (profile: "free" | "paid"): ModelOf => (step) => async () => (await currentAiRouting()).config.profiles[profile].models[step];
/** Questions per verification call, read per call so an admin change applies to the next set. */
export const verifyBatchSize = async () => (await getQuestionsConfig()).providers.verifyBatchSize;

/** Every verifier is the same stack: the cache first (a question verified before is never sent again), then batches. */
const verifierStack = (v: Verifier, model: () => Promise<string>, cache: VerificationCache, batchSize = verifyBatchSize) => cachedVerifier(batchedVerifier(v, batchSize), model, cache);

export function pricedModel(name: string, envVar: string): PricedModel {
  if (!PRICED_MODELS.includes(name as PricedModel)) throw new Error(`${envVar}=${name} has no price in PROVIDER_PRICES (have: ${PRICED_MODELS.join(", ")})`);
  return name as PricedModel;
}
/** The paid profile's embedder (env: changing it means re-embedding the bank). */
export const paidEmbedModel = () => pricedModel(process.env.GEMINI_EMBED_MODEL ?? DEFAULT_EMBED_MODEL, "GEMINI_EMBED_MODEL");

const key = (envVar: string) => process.env[envVar] ?? "";
type Deps = (step: ProviderStep) => CallDeps;

/** The mocks, batched like the others (no cache: nothing to save). */
export const mockProviders = (batchSize = verifyBatchSize): Providers => ({ generator: mockGenerator, verifier: batchedVerifier(mockVerifier, batchSize), embedder: mockEmbedder, safety: mockSafety });

/** Gemini's free tier only (the client, models and cache are injectable for tests). */
export function freeProviders(deps: Deps, client = geminiClient({ apiKey: key("GEMINI_API_KEY") }), cache: VerificationCache = dbVerificationCache, batchSize = verifyBatchSize, model: ModelOf = routedModel("free")): Providers {
  return {
    generator: geminiGenerator({ client, call: deps("generate"), model: model("generate"), tier: "free" }),
    verifier: verifierStack(geminiVerifier({ client, call: deps("verify"), model: model("verify"), mode: "unsourced", tier: "free" }), model("verify"), cache, batchSize),
    embedder: geminiEmbedder({ client, call: deps("embed"), model: FREE_PROFILE_MODELS.embed, tier: "free" }),
    safety: geminiSafety({ client, call: deps("safety"), model: model("safety"), tier: "free" }),
    allowUnsourced: true,
  };
}

/** The production setup (every call paid: refused before it's made while AI_PAID_CAP_USD is 0). */
export function paidProviders(deps: Deps, model: ModelOf = routedModel("paid")): Providers {
  return {
    generator: anthropicGenerator({ client: claudeClient({ apiKey: key("ANTHROPIC_API_KEY") }), call: deps("generate"), model: model("generate") }),
    verifier: liveVerifier(deps, model("verify")),
    embedder: geminiEmbedder({ client: geminiClient({ apiKey: key("GEMINI_API_KEY") }), call: deps("embed"), tier: "paid", model: paidEmbedModel() }),
    safety: liveSafety(deps, model("safety")),
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

/** The paid profile's verifier: the routed model picks the vendor per call. Model and clients injectable for tests. */
export function liveVerifier(deps: Deps, model = routedModel("paid")("verify"), c = clients(), cache: VerificationCache = dbVerificationCache, batchSize = verifyBatchSize): Verifier {
  const pick = routed<Verifier>("verify", model, {
    ...(c.anthropic ? { anthropic: verifierStack(claudeVerifier({ client: c.anthropic, call: deps("verify"), model }), model, cache, batchSize) } : {}),
    ...(c.gemini ? { gemini: verifierStack(geminiVerifier({ client: c.gemini, call: deps("verify"), model, mode: "grounded", tier: "paid" }), model, cache, batchSize) } : {}),
  });
  return { name: "live", verifyBatch: async (qs) => (await pick()).verifyBatch(qs) };
}

export function liveSafety(deps: Deps, model = routedModel("paid")("safety"), c = clients()): SafetyReviewer {
  const pick = routed<SafetyReviewer>("safety", model, {
    ...(c.anthropic ? { anthropic: claudeSafety({ client: c.anthropic, call: deps("safety"), model }) } : {}),
    ...(c.gemini ? { gemini: geminiSafety({ client: c.gemini, call: deps("safety"), model, tier: "paid" }) } : {}),
  });
  return { name: "live", review: async (brief, items) => (items.length ? (await pick()).review(brief, items) : []) };
}

/** A set of providers that can't answer: every call is unavailable (a profile that couldn't be built, or none allowed). */
export function unavailableProviders(why: string, embedModel = "none"): Providers {
  const no = (step: ProviderStep) => async (): Promise<never> => { throw new ProviderUnavailable("auth", "none", step, why); };
  const embedder: Embedder = { model: embedModel, embed: no("embed") };
  return { generator: { draft: no("generate"), distract: no("generate") }, verifier: { name: "unavailable", verifyBatch: no("verify") }, embedder, safety: { name: "unavailable", review: no("safety") } };
}

export type ProfileBuilders = Record<AiProfile, (deps: Deps) => Providers>;
export const PROFILE_BUILDERS: ProfileBuilders = { mock: () => mockProviders(), free: (d) => freeProviders(d), paid: (d) => paidProviders(d) };

/** Each profile's providers, built on first use and kept (one per process); `for(null)` is the none-allowed set. */
export class ProviderRegistry {
  private readonly built = new Map<AiProfile, Providers>();
  constructor(private readonly deps: Deps = dbCallDeps(), private readonly builders: ProfileBuilders = PROFILE_BUILDERS) {}

  for(profile: AiProfile | null): Providers {
    if (profile === null) return unavailableProviders("no AI profile is allowed for this route (AI_ALLOWED_PROFILES)");
    let p = this.built.get(profile);
    if (!p) {
      try {
        p = this.builders[profile](this.deps);
      } catch (err) {
        console.error(`[questions] the ${profile} profile can't run: ${(err as Error).message}`);
        p = unavailableProviders(`the ${profile} profile can't run: ${(err as Error).message}`);
      }
      this.built.set(profile, p);
    }
    return p;
  }
}

/** One profile's providers on their own (the eval, tests): no routing, no ceiling. */
export const selectProviders = (deps: Deps = dbCallDeps(), profile: AiProfile = "mock"): Providers => new ProviderRegistry(deps).for(profile);

/** What a profile runs, for the start-up line and the eval report. */
export async function providerNames(profile: AiProfile): Promise<Record<"profile" | "generator" | "verifier" | "embedder" | "safety", string>> {
  if (profile === "mock") return { profile, generator: "mock", verifier: "mock", embedder: "mock", safety: "mock" };
  const m = (await currentAiRouting()).config.profiles[profile].models;
  if (profile === "free") return { profile, generator: `gemini ${m.generate}`, verifier: `gemini ${m.verify}, no sources`, embedder: `gemini ${FREE_PROFILE_MODELS.embed}`, safety: `gemini ${m.safety}` };
  return { profile, generator: `anthropic ${m.generate}`, verifier: `${m.verify}, with web search`, embedder: `gemini ${process.env.GEMINI_EMBED_MODEL ?? DEFAULT_EMBED_MODEL}`, safety: m.safety };
}

export * from "./types.js";

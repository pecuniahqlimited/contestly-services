/**
 * Provider selection by env (ADR 0016). Mocks are the default for every seam, for tests and dev without
 * keys. A real provider is a factory here: built once at start, failing at start if its key is missing, and
 * never falling back to a mock. Unknown names throw (fail closed).
 *
 * Verification and the safety check are "live" when real: the admin's model for the step picks the vendor on
 * every call (Claude by default; Gemini when billing is on), so switching needs no restart. A vendor's client
 * exists only when its key is set; a model whose vendor has no key fails that call, closed.
 *
 * Every real provider shares one call path (@contestly/ai providerCall): spend caps, a breaker per provider
 * and step, a timeout per step, retries, and a provider_calls row per call.
 */
import { Breakers, claudeClient, DEFAULT_BREAKER, DEFAULT_RETRY, geminiClient, ProviderUnavailable, RateLimiter, type CallDeps, type RetryPolicy } from "@contestly/ai";
import { dbBudgetGate, dbUsageSink, getQuestionsConfig } from "@contestly/db";
import { PRICED_MODELS, providerOf, type PricedModel, type ProviderName, type ProviderStep } from "@contestly/shared";
import { mockEmbedder } from "./mock/embedder.js";
import { mockGenerator } from "./mock/generator.js";
import { mockSafety } from "./mock/safety.js";
import { mockVerifier } from "./mock/verifier.js";
import { anthropicGenerator } from "./anthropic/generator.js";
import { claudeVerifier } from "./anthropic/verifier.js";
import { claudeSafety } from "./anthropic/safety.js";
import { geminiVerifier } from "./gemini/verifier.js";
import { geminiSafety } from "./gemini/safety.js";
import { geminiEmbedder } from "./gemini/embedder.js";
import { cachedVerifier, dbVerificationCache, type VerificationCache } from "./cachedVerifier.js";
import type { Embedder, Generator, Providers, SafetyReviewer, Verifier } from "./types.js";

/** Per attempt. Generation thinks and writes a batch; verification searches; the rest are quick. */
export const STEP_TIMEOUT_MS: Record<ProviderStep, number> = { generate: 180_000, verify: 90_000, safety: 45_000, embed: 30_000, transcribe: 60_000 };
/**
 * Retries per step. Embeddings wait out a rate limit (Gemini's free tier says when to come back, often 10–60 s)
 * rather than fail, so a re-embed runs slowly instead of stopping; the rest keep the default.
 */
export const STEP_RETRY: Partial<Record<ProviderStep, RetryPolicy>> = { embed: { attempts: 6, baseDelayMs: 2_000, maxDelayMs: 65_000 } };
export const DEFAULT_EMBED_MODEL: PricedModel = "gemini-embedding-2";
/** Gemini's free tier allows 100 embed requests a minute per project and model (seen on its 429, 7 Nov 2026); a margin under it. */
export const DEFAULT_EMBED_RPM = 90;

/** The shared call path, wired to Postgres. One breaker set per process. */
export function dbCallDeps(breakers = new Breakers(DEFAULT_BREAKER)) {
  return (step: ProviderStep): CallDeps => ({ sink: dbUsageSink, budget: dbBudgetGate, breakers, retry: STEP_RETRY[step] ?? DEFAULT_RETRY, timeoutMs: STEP_TIMEOUT_MS[step] });
}

const modelFor = (step: "generate" | "verify" | "safety") => async () => (await getQuestionsConfig()).providers.models[step];

export function pricedModel(name: string, envVar: string): PricedModel {
  if (!PRICED_MODELS.includes(name as PricedModel)) throw new Error(`${envVar}=${name} has no price in PROVIDER_PRICES (have: ${PRICED_MODELS.join(", ")})`);
  return name as PricedModel;
}

const key = (envVar: string) => process.env[envVar] ?? "";

type Factory<T> = (deps: (step: ProviderStep) => CallDeps) => T;

const generators: Record<string, Factory<Generator>> = {
  mock: () => mockGenerator,
  anthropic: (deps) => anthropicGenerator({ client: claudeClient({ apiKey: key("ANTHROPIC_API_KEY") }), call: deps("generate"), model: modelFor("generate") }),
};
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

/** The model and clients are injectable for tests; in the services they're the admin config and the env keys. */
export function liveVerifier(deps: (step: ProviderStep) => CallDeps, model = modelFor("verify"), c = clients(), cache: VerificationCache = dbVerificationCache): Verifier {
  const pick = routed<Verifier>("verify", model, {
    ...(c.anthropic ? { anthropic: cachedVerifier(claudeVerifier({ client: c.anthropic, call: deps("verify"), model }), model, cache) } : {}),
    ...(c.gemini ? { gemini: cachedVerifier(geminiVerifier({ client: c.gemini, call: deps("verify"), model }), model, cache) } : {}),
  });
  return { name: "live", verify: async (q) => (await pick()).verify(q) };
}

export function liveSafety(deps: (step: ProviderStep) => CallDeps, model = modelFor("safety"), c = clients()): SafetyReviewer {
  const pick = routed<SafetyReviewer>("safety", model, {
    ...(c.anthropic ? { anthropic: claudeSafety({ client: c.anthropic, call: deps("safety"), model }) } : {}),
    ...(c.gemini ? { gemini: geminiSafety({ client: c.gemini, call: deps("safety"), model }) } : {}),
  });
  return { name: "live", review: async (brief, items) => (items.length ? (await pick()).review(brief, items) : []) };
}

/** "anthropic" and "gemini" are kept as names for live from before the vendor followed the model. */
const verifiers: Record<string, Factory<Verifier>> = { mock: () => mockVerifier, live: (d) => liveVerifier(d), anthropic: (d) => liveVerifier(d), gemini: (d) => liveVerifier(d) };
const safeties: Record<string, Factory<SafetyReviewer>> = { mock: () => mockSafety, live: (d) => liveSafety(d), anthropic: (d) => liveSafety(d), gemini: (d) => liveSafety(d) };

const embedders: Record<string, Factory<Embedder>> = {
  mock: () => mockEmbedder,
  gemini: (deps) => geminiEmbedder({
    client: geminiClient({ apiKey: key("GEMINI_API_KEY") }), call: deps("embed"),
    model: pricedModel(process.env.GEMINI_EMBED_MODEL ?? DEFAULT_EMBED_MODEL, "GEMINI_EMBED_MODEL"),
    limiter: new RateLimiter({ limit: positiveInt(process.env.GEMINI_EMBED_RPM, DEFAULT_EMBED_RPM, "GEMINI_EMBED_RPM"), windowMs: 60_000 }),
  }),
};

function positiveInt(raw: string | undefined, fallback: number, envVar: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${envVar}=${raw} must be a positive whole number`);
  return n;
}

function pick<T>(registry: Record<string, Factory<T>>, envVar: string, deps: (step: ProviderStep) => CallDeps): T {
  const name = process.env[envVar] ?? "mock";
  const factory = registry[name];
  if (!factory) throw new Error(`${envVar}=${name} is not a registered provider (have: ${Object.keys(registry).join(", ")})`);
  return factory(deps);
}

export function selectProviders(deps = dbCallDeps()): Providers {
  return {
    generator: pick(generators, "QUESTIONS_GENERATOR", deps),
    verifier: pick(verifiers, "QUESTIONS_VERIFIER", deps),
    embedder: pick(embedders, "QUESTIONS_EMBEDDER", deps),
    safety: pick(safeties, "QUESTIONS_SAFETY", deps),
  };
}

/** What's selected, for the start-up line and the eval report. */
export const providerNames = () => ({
  generator: process.env.QUESTIONS_GENERATOR ?? "mock",
  verifier: process.env.QUESTIONS_VERIFIER ?? "mock",
  embedder: process.env.QUESTIONS_EMBEDDER ?? "mock",
  safety: process.env.QUESTIONS_SAFETY ?? "mock",
});

export * from "./types.js";

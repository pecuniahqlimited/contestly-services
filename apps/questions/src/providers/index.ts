/**
 * Provider selection by env (ADR 0016). Mocks are the default for every seam, for tests and dev without
 * keys. A real provider is a factory here: built once at start, failing at start if its key is missing, and
 * never falling back to a mock. Unknown names throw (fail closed).
 *
 * Every real provider shares one call path (@contestly/ai providerCall): spend caps, a breaker per provider
 * and step, a timeout per step, retries, and a provider_calls row per call.
 */
import { Breakers, claudeClient, DEFAULT_BREAKER, DEFAULT_RETRY, geminiClient, type CallDeps } from "@contestly/ai";
import { dbBudgetGate, dbUsageSink, getQuestionsConfig } from "@contestly/db";
import { PRICED_MODELS, type PricedModel, type ProviderStep } from "@contestly/shared";
import { mockEmbedder } from "./mock/embedder.js";
import { mockGenerator } from "./mock/generator.js";
import { mockSafety } from "./mock/safety.js";
import { mockVerifier } from "./mock/verifier.js";
import { anthropicGenerator } from "./anthropic/generator.js";
import { geminiVerifier } from "./gemini/verifier.js";
import { geminiSafety } from "./gemini/safety.js";
import { geminiEmbedder } from "./gemini/embedder.js";
import { cachedVerifier } from "./cachedVerifier.js";
import type { Embedder, Generator, Providers, SafetyReviewer, Verifier } from "./types.js";

/** Per attempt. Generation thinks and writes a batch; verification searches; the rest are quick. */
export const STEP_TIMEOUT_MS: Record<ProviderStep, number> = { generate: 180_000, verify: 90_000, safety: 45_000, embed: 30_000, transcribe: 60_000 };
export const DEFAULT_EMBED_MODEL: PricedModel = "gemini-embedding-2";

/** The shared call path, wired to Postgres. One breaker set per process. */
export function dbCallDeps(breakers = new Breakers(DEFAULT_BREAKER)) {
  return (step: ProviderStep): CallDeps => ({ sink: dbUsageSink, budget: dbBudgetGate, breakers, retry: DEFAULT_RETRY, timeoutMs: STEP_TIMEOUT_MS[step] });
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
const verifiers: Record<string, Factory<Verifier>> = {
  mock: () => mockVerifier,
  gemini: (deps) => cachedVerifier(geminiVerifier({ client: geminiClient({ apiKey: key("GEMINI_API_KEY") }), call: deps("verify"), model: modelFor("verify") }), modelFor("verify")),
};
const embedders: Record<string, Factory<Embedder>> = {
  mock: () => mockEmbedder,
  gemini: (deps) => geminiEmbedder({
    client: geminiClient({ apiKey: key("GEMINI_API_KEY") }), call: deps("embed"),
    model: pricedModel(process.env.GEMINI_EMBED_MODEL ?? DEFAULT_EMBED_MODEL, "GEMINI_EMBED_MODEL"),
  }),
};
const safeties: Record<string, Factory<SafetyReviewer>> = {
  mock: () => mockSafety,
  gemini: (deps) => geminiSafety({ client: geminiClient({ apiKey: key("GEMINI_API_KEY") }), call: deps("safety"), model: modelFor("safety") }),
};

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

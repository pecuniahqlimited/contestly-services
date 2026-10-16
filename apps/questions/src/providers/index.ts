/**
 * Provider selection by env. Adding a real provider = one new file exporting the interface,
 * one registry entry here, one env change. Unknown names throw (fail closed) rather than
 * silently falling back to a mock.
 */
import { mockEmbedder } from "./mock/embedder.js";
import { mockGenerator } from "./mock/generator.js";
import { mockVerifier } from "./mock/verifier.js";
import type { Embedder, Generator, Providers, Verifier } from "./types.js";

const generators: Record<string, Generator> = { mock: mockGenerator };
const verifiers: Record<string, Verifier> = { mock: mockVerifier };
const embedders: Record<string, Embedder> = { mock: mockEmbedder };

function pick<T>(registry: Record<string, T>, envVar: string): T {
  const name = process.env[envVar] ?? "mock";
  const provider = registry[name];
  if (!provider) throw new Error(`${envVar}=${name} is not a registered provider (have: ${Object.keys(registry).join(", ")})`);
  return provider;
}

export function selectProviders(): Providers {
  return {
    generator: pick(generators, "QUESTIONS_GENERATOR"),
    verifier: pick(verifiers, "QUESTIONS_VERIFIER"),
    embedder: pick(embedders, "QUESTIONS_EMBEDDER"),
  };
}

export * from "./types.js";

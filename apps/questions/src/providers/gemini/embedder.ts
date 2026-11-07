/**
 * The Gemini embedder (ADR 0016): EMBEDDING_DIM-wide vectors, one call per batch of texts, unit-normalised
 * here too so the dot product is the cosine whatever the model returns. gemini-embedding-2 takes its task as a
 * prompt prefix; every text gets the same one, so a question, a spec and a chunk land in one comparable space.
 */
import { geminiEmbed, providerCall, type CallDeps, type GeminiClient } from "@contestly/ai";
import { EMBEDDING_DIM, type PricedModel } from "@contestly/shared";
import type { Embedder } from "../types.js";

/** Texts per call (each is its own request underneath; this bounds how many go at once). */
export const EMBED_BATCH = 16;
const TASK_PREFIX = "task: clustering | query: ";

export interface GeminiEmbedderDeps {
  client: GeminiClient;
  call: CallDeps;
  model: PricedModel;
}

export function geminiEmbedder(deps: GeminiEmbedderDeps): Embedder {
  return {
    model: deps.model,
    async embed(texts) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += EMBED_BATCH) {
        const batch = texts.slice(i, i + EMBED_BATCH).map((t) => TASK_PREFIX + t);
        const vectors = await providerCall({ provider: "gemini", model: deps.model, step: "embed" }, deps.call, (signal) =>
          geminiEmbed(deps.client, { model: deps.model, texts: batch, dimensions: EMBEDDING_DIM }, signal));
        out.push(...vectors.map(normalise));
      }
      return out;
    },
  };
}

export function normalise(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

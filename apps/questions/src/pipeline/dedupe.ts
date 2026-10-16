/**
 * Semantic dedupe, pure: cosine similarity over unit-normalised embeddings. The orchestrator
 * compares each draft against the bank (via pgvector) and against the batch drafted so far;
 * anything at or above the configured similarity is the same fact reworded and is dropped.
 */

/** Both vectors are unit-normalised by the Embedder contract, so cosine is the dot product. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export interface Neighbour {
  id: string;
  similarity: number;
}

/** The most similar of `others`, or null when there is nothing to compare against. */
export function nearest(embedding: number[], others: { id: string; embedding: number[] }[]): Neighbour | null {
  let best: Neighbour | null = null;
  for (const o of others) {
    const similarity = cosine(embedding, o.embedding);
    if (!best || similarity > best.similarity) best = { id: o.id, similarity };
  }
  return best;
}

export const isDuplicate = (neighbour: Neighbour | null, threshold: number): boolean =>
  neighbour !== null && neighbour.similarity >= threshold;

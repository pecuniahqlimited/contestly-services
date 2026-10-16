/**
 * Deterministic embedder: character trigrams hashed into EMBEDDING_DIM buckets, L2-normalised.
 * Near-identical wording lands in near-identical buckets, so cosine similarity behaves like a
 * (crude) semantic distance and the dedupe step catches the deck's planted near-duplicate.
 */
import { EMBEDDING_DIM } from "@contestly/shared";
import type { Embedder } from "../types.js";

/** FNV-1a, 32-bit. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function embedOne(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  const t = ` ${text.toLowerCase().replace(/\s+/g, " ").trim()} `;
  for (let i = 0; i + 3 <= t.length; i++) v[hash(t.slice(i, i + 3)) % EMBEDDING_DIM] += 1;
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export const mockEmbedder: Embedder = {
  async embed(texts) {
    return texts.map(embedOne);
  },
};

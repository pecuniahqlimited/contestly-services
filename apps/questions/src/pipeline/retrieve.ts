/**
 * Retrieval over the bank (pgvector cosine): proven questions matching the spec come back before
 * anything is generated — reusing played questions is the strongest anti-slop measure we have.
 */
import { and, desc, eq, inArray, isNull, ne, notInArray, cosineDistance, sql } from "drizzle-orm";
import { db, bankQuestions, type BankQuestion } from "@contestly/db";
import type { Category } from "@contestly/shared";
import type { GenerationSpec } from "../providers/types.js";
import type { Neighbour } from "./dedupe.js";

/**
 * The cosine similarity to the spec a bank question needs to be reused, per embedding model: below it, it's
 * off-topic and the gap is generated instead. Real embeddings score unrelated text high, so each model's floor is
 * measured, not guessed: gemini-embedding-2 (11 Nov 2026, five briefs against on-topic questions, other topics and
 * mock filler) put on-topic at 0.79–0.87 and everything else at 0.65–0.78. The mock embedder's scores are its own.
 */
export const RETRIEVAL_MIN_SIMILARITY: Record<string, number> = { mock: 0.1, "gemini-embedding-2": 0.79 };
/** A model nobody has measured: strict, so a new embedder generates rather than reuses until it's calibrated. */
export const UNCALIBRATED_MIN_SIMILARITY = 0.85;
export const retrievalFloor = (model: string) => RETRIEVAL_MIN_SIMILARITY[model] ?? UNCALIBRATED_MIN_SIMILARITY;

/** The catch-all category: it means "we couldn't tell", so it never narrows retrieval. */
export const CATCH_ALL_CATEGORY: Category = "General knowledge";

/**
 * Proven open-knowledge questions for the spec, most similar first, at or above the model's floor. Excludes
 * questions generated from someone's uploaded file (only answerable with that file) and anything in `excludeIds`.
 * Only rows embedded by `model` are comparable with the spec's vector (ADR 0016); a real model never gets a
 * mock-written row; and a spec with a specific category gets only that category's questions.
 */
export async function retrieveFromBank(spec: GenerationSpec, specEmbedding: number[], limit: number, excludeIds: string[], model: string): Promise<BankQuestion[]> {
  const similarity = sql<number>`1 - (${cosineDistance(bankQuestions.embedding, specEmbedding)})`;
  const rows = await db
    .select({ q: bankQuestions, similarity })
    .from(bankQuestions)
    .where(and(
      reusable(spec, excludeIds),
      eq(bankQuestions.embeddingModel, model),
      model === "mock" ? undefined : ne(bankQuestions.writtenBy, "mock"),
      spec.categoryTag === CATCH_ALL_CATEGORY ? undefined : eq(bankQuestions.categoryTag, spec.categoryTag),
    ))
    .orderBy(desc(similarity))
    .limit(limit);
  const floor = retrievalFloor(model);
  return rows.filter((r) => Number(r.similarity) >= floor).map((r) => r.q);
}

/** A bank question this spec may reuse: active, open-knowledge, an allowed format, not excluded. */
const reusable = (spec: GenerationSpec, excludeIds: string[]) => and(
  eq(bankQuestions.status, "active"),
  inArray(bankQuestions.format, spec.formats),
  isNull(bankQuestions.sourceChunkId),
  excludeIds.length ? notInArray(bankQuestions.id, excludeIds) : undefined,
);

/**
 * Of these bank ids, the ones the spec may reuse. A draft that only rewrites one of them gets the
 * proven original instead of being thrown away (fill.ts).
 */
export async function reusableAmong(spec: GenerationSpec, ids: string[], excludeIds: string[]): Promise<BankQuestion[]> {
  if (!ids.length) return [];
  return db.select().from(bankQuestions).where(and(inArray(bankQuestions.id, ids), reusable(spec, excludeIds)));
}

/**
 * The bank's most similar question to an embedding, any status: a draft that rewords a retired
 * question is still a duplicate. Only rows embedded by the same model are compared.
 */
export async function nearestInBank(embedding: number[], excludeIds: string[], model: string): Promise<Neighbour | null> {
  const similarity = sql<number>`1 - (${cosineDistance(bankQuestions.embedding, embedding)})`;
  const [row] = await db
    .select({ id: bankQuestions.id, similarity })
    .from(bankQuestions)
    .where(and(eq(bankQuestions.embeddingModel, model), excludeIds.length ? notInArray(bankQuestions.id, excludeIds) : undefined))
    .orderBy(desc(similarity))
    .limit(1);
  return row ? { id: row.id, similarity: Number(row.similarity) } : null;
}

/**
 * Retrieval over the bank (pgvector cosine): proven questions matching the spec come back before
 * anything is generated — reusing played questions is the strongest anti-slop measure we have.
 */
import { and, desc, eq, inArray, isNull, notInArray, cosineDistance, sql } from "drizzle-orm";
import { db, bankQuestions, type BankQuestion } from "@contestly/db";
import type { GenerationSpec } from "../providers/types.js";
import type { Neighbour } from "./dedupe.js";

/** Below this cosine similarity to the spec, a bank question is off-topic and not worth reusing. */
export const RETRIEVAL_MIN_SIMILARITY = 0.1;

/**
 * Proven open-knowledge questions for the spec, most similar first. Excludes questions generated
 * from someone's uploaded file (only answerable with that file) and anything in `excludeIds`.
 */
export async function retrieveFromBank(spec: GenerationSpec, specEmbedding: number[], limit: number, excludeIds: string[] = []): Promise<BankQuestion[]> {
  const similarity = sql<number>`1 - (${cosineDistance(bankQuestions.embedding, specEmbedding)})`;
  const rows = await db
    .select({ q: bankQuestions, similarity })
    .from(bankQuestions)
    .where(reusable(spec, excludeIds))
    .orderBy(desc(similarity))
    .limit(limit);
  return rows.filter((r) => Number(r.similarity) >= RETRIEVAL_MIN_SIMILARITY).map((r) => r.q);
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
 * question is still a duplicate.
 */
export async function nearestInBank(embedding: number[]): Promise<Neighbour | null> {
  const similarity = sql<number>`1 - (${cosineDistance(bankQuestions.embedding, embedding)})`;
  const [row] = await db
    .select({ id: bankQuestions.id, similarity })
    .from(bankQuestions)
    .orderBy(desc(similarity))
    .limit(1);
  return row ? { id: row.id, similarity: Number(row.similarity) } : null;
}

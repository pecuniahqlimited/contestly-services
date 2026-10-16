/**
 * Retrieval over the bank (pgvector cosine): proven questions matching the spec come back before
 * anything is generated — reusing played questions is the strongest anti-slop measure we have.
 */
import { and, desc, eq, inArray, cosineDistance, sql } from "drizzle-orm";
import { db, bankQuestions, type BankQuestion } from "@contestly/db";
import type { GenerationSpec } from "../providers/types.js";
import type { Neighbour } from "./dedupe.js";

/** Below this cosine similarity to the spec, a bank question is off-topic and not worth reusing. */
export const RETRIEVAL_MIN_SIMILARITY = 0.1;

export async function retrieveFromBank(spec: GenerationSpec, specEmbedding: number[], limit: number): Promise<BankQuestion[]> {
  const similarity = sql<number>`1 - (${cosineDistance(bankQuestions.embedding, specEmbedding)})`;
  const rows = await db
    .select({ q: bankQuestions, similarity })
    .from(bankQuestions)
    .where(and(eq(bankQuestions.status, "active"), inArray(bankQuestions.format, spec.formats)))
    .orderBy(desc(similarity))
    .limit(limit);
  return rows.filter((r) => Number(r.similarity) >= RETRIEVAL_MIN_SIMILARITY).map((r) => r.q);
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

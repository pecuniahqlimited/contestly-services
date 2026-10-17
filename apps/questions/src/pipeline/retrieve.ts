/**
 * Retrieval over the bank (pgvector cosine): proven questions matching the spec come back before
 * anything is generated — reusing played questions is the strongest anti-slop measure we have.
 */
import { and, desc, eq, inArray, isNotNull, isNull, notInArray, cosineDistance, sql } from "drizzle-orm";
import { db, bankQuestions, partyAnswers, partyPlayers, partyQuestions, type BankQuestion } from "@contestly/db";
import type { GenerationSpec } from "../providers/types.js";
import type { Neighbour } from "./dedupe.js";

/** Below this cosine similarity to the spec, a bank question is off-topic and not worth reusing. */
export const RETRIEVAL_MIN_SIMILARITY = 0.1;

export interface PlayedQuestion {
  bankId: string;
  payload: unknown;
}

/**
 * Bank questions that anyone seated in this party has already been shown in an earlier party
 * (answered or not). Retrieval never serves these again, and the generator is told to avoid them.
 */
export async function playedBySeatedPlayers(partyId: string): Promise<PlayedQuestion[]> {
  const seated = db.select({ userId: partyPlayers.userId }).from(partyPlayers).where(eq(partyPlayers.partyId, partyId));
  const rows = await db
    .selectDistinct({ bankId: partyQuestions.sourceRef, payload: partyQuestions.payload })
    .from(partyAnswers)
    .innerJoin(partyQuestions, eq(partyAnswers.questionId, partyQuestions.id))
    .where(and(inArray(partyAnswers.userId, seated), isNotNull(partyQuestions.sourceRef)));
  return rows.map((r) => ({ bankId: r.bankId!, payload: r.payload }));
}

/**
 * Proven open-knowledge questions for the spec, most similar first. Excludes questions generated
 * from someone's uploaded file (only answerable with that file) and anything in `excludeIds`.
 */
export async function retrieveFromBank(spec: GenerationSpec, specEmbedding: number[], limit: number, excludeIds: string[] = []): Promise<BankQuestion[]> {
  const similarity = sql<number>`1 - (${cosineDistance(bankQuestions.embedding, specEmbedding)})`;
  const rows = await db
    .select({ q: bankQuestions, similarity })
    .from(bankQuestions)
    .where(and(
      eq(bankQuestions.status, "active"),
      inArray(bankQuestions.format, spec.formats),
      isNull(bankQuestions.sourceChunkId),
      excludeIds.length ? notInArray(bankQuestions.id, excludeIds) : undefined,
    ))
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

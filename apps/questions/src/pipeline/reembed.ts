/**
 * reembed (ADR 0016): vectors from different embedding models live in different spaces, so retrieval and
 * dedupe only compare rows embedded by the current model. This job moves the rest over: a batch of bank
 * questions (then file chunks) whose embedding_model isn't current, re-embedded and marked, then the job
 * queues itself again until none are left. Resumable by construction: the column is the progress.
 */
import { and, eq, isNotNull, ne } from "drizzle-orm";
import { bankQuestions, db, fileChunks } from "@contestly/db";
import type { QuestionFormat } from "@contestly/shared";
import type { Embedder } from "../providers/types.js";
import { embeddingText } from "./text.js";

export const REEMBED_BATCH = 64;

const staleBank = (model: string) => ne(bankQuestions.embeddingModel, model);
const staleChunks = (model: string) => and(isNotNull(fileChunks.embedding), ne(fileChunks.embeddingModel, model));

export async function needsReembed(model: string): Promise<boolean> {
  const [b] = await db.select({ id: bankQuestions.id }).from(bankQuestions).where(staleBank(model)).limit(1);
  if (b) return true;
  const [c] = await db.select({ id: fileChunks.id }).from(fileChunks).where(staleChunks(model)).limit(1);
  return !!c;
}

/** One batch. Returns how many rows moved; the caller queues the next batch while that's above zero. */
export async function reembedBatch(deps: { embedder: Embedder }): Promise<number> {
  const model = deps.embedder.model;
  const bank = await db.select({ id: bankQuestions.id, format: bankQuestions.format, payload: bankQuestions.payload }).from(bankQuestions).where(staleBank(model)).limit(REEMBED_BATCH);
  if (bank.length) {
    const vectors = await deps.embedder.embed(bank.map((q) => embeddingText(q.format as QuestionFormat, q.payload)));
    await db.transaction(async (tx) => {
      for (const [i, q] of bank.entries()) await tx.update(bankQuestions).set({ embedding: vectors[i], embeddingModel: model }).where(eq(bankQuestions.id, q.id));
    });
    return bank.length;
  }
  const chunks = await db.select({ id: fileChunks.id, text: fileChunks.text }).from(fileChunks).where(staleChunks(model)).limit(REEMBED_BATCH);
  if (!chunks.length) return 0;
  const vectors = await deps.embedder.embed(chunks.map((c) => c.text));
  await db.transaction(async (tx) => {
    for (const [i, c] of chunks.entries()) await tx.update(fileChunks).set({ embedding: vectors[i], embeddingModel: model }).where(eq(fileChunks.id, c.id));
  });
  return chunks.length;
}

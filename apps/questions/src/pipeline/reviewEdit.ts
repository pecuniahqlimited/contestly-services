/**
 * An admin's edit of a bank question, judged like a new draft (verify, safety, dedupe, the gate) before
 * it replaces the bank row. Accepted: the bank row takes the edit and its new embedding and goes back into
 * retrieval with its flags cleared. Rejected: the bank row is untouched. Either way the review keeps every
 * check result. A review is judged once.
 */
import { and, desc, eq } from "drizzle-orm";
import { bankQuestions, db, fileChunks, getQuestionsConfig, questionGenerations, questionReviews } from "@contestly/db";
import type { QuestionFormat } from "@contestly/shared";
import type { DraftQuestion, GenerationSpec, Providers, SourceChunk } from "../providers/types.js";
import { judgeOne } from "./judge.js";

interface Edit { payload: unknown; explanation?: string; claim: string }

/** The spec the question was generated from, or a plain open-knowledge one for questions that have no record (seeded). */
async function specFor(bank: typeof bankQuestions.$inferSelect): Promise<GenerationSpec> {
  const [g] = await db.select({ spec: questionGenerations.spec }).from(questionGenerations).where(eq(questionGenerations.bankQuestionId, bank.id)).orderBy(desc(questionGenerations.createdAt)).limit(1);
  if (g) return g.spec as GenerationSpec;
  return {
    topic: bank.categoryTag, categoryTag: bank.categoryTag, difficulty: "mixed", secondsPerQuestion: 15, formats: [bank.format as QuestionFormat],
    exclusions: [], language: bank.language, sourceScope: "open", summary: bank.categoryTag,
  };
}

/** A file-sourced question is checked against its chunk; once the chunk is gone (retention) it can't be verified. */
async function sourcesFor(bank: typeof bankQuestions.$inferSelect): Promise<SourceChunk[] | undefined> {
  if (!bank.sourceChunkId) return undefined;
  const [chunk] = await db.select({ id: fileChunks.id, text: fileChunks.text }).from(fileChunks).where(eq(fileChunks.id, bank.sourceChunkId));
  return chunk ? [chunk] : [];
}

export async function reviewEdit(job: { reviewId: string }, ctx: { providers: Providers }): Promise<void> {
  const [review] = await db.select().from(questionReviews).where(and(eq(questionReviews.id, job.reviewId), eq(questionReviews.status, "pending")));
  if (!review) return; // already judged (a retried job)
  const [bank] = await db.select().from(bankQuestions).where(eq(bankQuestions.id, review.bankQuestionId));
  const edit = review.edit as Edit;
  const draft: DraftQuestion = { format: bank.format as QuestionFormat, payload: edit.payload, explanation: edit.explanation, claim: edit.claim, sourceChunkId: bank.sourceChunkId ?? undefined };
  const [spec, sources, cfg] = await Promise.all([specFor(bank), sourcesFor(bank), getQuestionsConfig()]);
  const j = await judgeOne(draft, { spec, providers: ctx.providers, dedupeSimilarity: cfg.dedupeSimilarity, sources, excludeBankIds: [bank.id] });

  await db.transaction(async (tx) => {
    const [claimed] = await tx.update(questionReviews)
      .set({ status: j.outcome, verify: j.verify, safety: j.safety, dedupe: j.nearest, judgedAt: new Date() })
      .where(and(eq(questionReviews.id, review.id), eq(questionReviews.status, "pending"))).returning({ id: questionReviews.id });
    if (!claimed || j.outcome !== "accepted") return;
    await tx.update(bankQuestions).set({
      payload: draft.payload, explanation: draft.explanation ?? null, embedding: j.embedding,
      status: "active", flagCount: 0, retiredReason: null, retiredAt: null,
    }).where(eq(bankQuestions.id, bank.id));
  });
  console.log(`[questions] review ${review.id} of bank question ${bank.id}: ${j.outcome}`);
}

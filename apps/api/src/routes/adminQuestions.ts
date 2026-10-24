/**
 * The question queue: bank questions players flagged, that a room voided (pending review), or that were
 * retired, with each one's generation record. Restore puts one back in retrieval; retire takes it out
 * for good; an edit is re-checked by the questions service (verify, safety, dedupe) before it applies.
 * Content is never shown while a party that hasn't started holds the question (sealed sets, and another
 * host's drafts, stay unseen until start).
 */
import type { FastifyInstance } from "fastify";
import { and, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import {
  bankQuestions, db, fileChunks, parties, partyQuestionEvents, partyQuestions, questionGenerations, questionReviews, recordAdminAction, users, type BankQuestion, type Tx,
} from "@contestly/db";
import { questionsQueue } from "@contestly/queue";
import {
  adminEditQuestionSchema, adminQuestionDetailSchema, adminQuestionReviewResponseSchema, adminQuestionsQuerySchema, adminQuestionsResponseSchema,
  adminReasonBodySchema, type AdminQuestionRow, type QuestionFormat,
} from "@contestly/shared";
import { payloadSchemas } from "@contestly/game";
import { requireAdmin, uuidParam } from "../auth.js";
import { actionsView } from "../adminViews.js";
import { httpError } from "../httpError.js";
import { toPerson } from "../people.js";

const questionJobs = questionsQueue();
/** Retired by an admin: permanent, never restored or edited back in (the sweep's retirements can be). */
export const ADMIN_RETIRED = "admin";

/** Of `ids`, the bank questions some party that hasn't started has in its set. */
async function heldByUnstartedParties(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await db.selectDistinct({ id: partyQuestions.sourceRef }).from(partyQuestions).innerJoin(parties, eq(parties.id, partyQuestions.partyId))
    .where(and(inArray(partyQuestions.sourceRef, ids), eq(parties.status, "open")));
  return new Set(rows.map((r) => r.id!));
}

/** Per bank question: flags by reason, and how many times a room voided it. */
async function flagTallies(ids: string[]) {
  const flags = new Map<string, Record<string, number>>();
  const voids = new Map<string, number>();
  if (!ids.length) return { flags, voids };
  const rows = await db.select({ bankId: partyQuestions.sourceRef, kind: partyQuestionEvents.kind, reason: partyQuestionEvents.reason, n: sql<number>`count(*)::int` })
    .from(partyQuestionEvents).innerJoin(partyQuestions, eq(partyQuestions.id, partyQuestionEvents.questionId))
    .where(and(inArray(partyQuestions.sourceRef, ids), inArray(partyQuestionEvents.kind, ["flag", "void"])))
    .groupBy(partyQuestions.sourceRef, partyQuestionEvents.kind, partyQuestionEvents.reason);
  for (const r of rows) {
    if (r.kind === "void") voids.set(r.bankId!, (voids.get(r.bankId!) ?? 0) + Number(r.n));
    else flags.set(r.bankId!, { ...(flags.get(r.bankId!) ?? {}), [r.reason ?? "unspecified"]: Number(r.n) });
  }
  return { flags, voids };
}

async function questionRows(list: BankQuestion[]): Promise<AdminQuestionRow[]> {
  const ids = list.map((q) => q.id);
  const [held, { flags, voids }] = await Promise.all([heldByUnstartedParties(ids), flagTallies(ids)]);
  return list.map((q) => ({
    id: q.id, format: q.format, status: q.status, categoryTag: q.categoryTag, origin: q.origin,
    flagCount: q.flagCount, flags: flags.get(q.id) ?? {}, voids: voids.get(q.id) ?? 0,
    retiredReason: q.retiredReason, retiredAt: q.retiredAt?.toISOString() ?? null,
    timesPlayed: q.timesPlayed, timesAnswered: q.timesAnswered, correctPct: q.timesAnswered ? q.correctnessSum / q.timesAnswered : null,
    payload: held.has(q.id) ? null : (q.payload as Record<string, unknown>), inUnstartedParty: held.has(q.id),
    createdAt: q.createdAt.toISOString(),
  }));
}

async function lockQuestion(tx: Tx, id: string): Promise<BankQuestion> {
  const [q] = await tx.select().from(bankQuestions).where(eq(bankQuestions.id, id)).for("update");
  if (!q) throw httpError(404, "not_found");
  return q;
}

const statusOf = (q: BankQuestion) => ({ status: q.status, flagCount: q.flagCount, retiredReason: q.retiredReason });

async function questionDetail(id: string) {
  const [q] = await db.select().from(bankQuestions).where(eq(bankQuestions.id, id));
  if (!q) throw httpError(404, "not_found");
  const [[row], voidRows, generations, reviews, actions] = await Promise.all([
    questionRows([q]),
    db.select({ e: partyQuestionEvents, title: parties.title }).from(partyQuestionEvents)
      .innerJoin(partyQuestions, eq(partyQuestions.id, partyQuestionEvents.questionId)).innerJoin(parties, eq(parties.id, partyQuestionEvents.partyId))
      .where(and(eq(partyQuestions.sourceRef, id), eq(partyQuestionEvents.kind, "void"))).orderBy(desc(partyQuestionEvents.createdAt)),
    db.select({ g: questionGenerations, mode: parties.mode }).from(questionGenerations).innerJoin(parties, eq(parties.id, questionGenerations.partyId))
      .where(eq(questionGenerations.bankQuestionId, id)).orderBy(desc(questionGenerations.createdAt)),
    db.select({ r: questionReviews, admin: users }).from(questionReviews).innerJoin(users, eq(users.id, questionReviews.adminUserId))
      .where(eq(questionReviews.bankQuestionId, id)).orderBy(desc(questionReviews.createdAt)),
    actionsView({ targetType: "question", targetId: id }),
  ]);
  const generation = await Promise.all(generations.map(async ({ g, mode }) => {
    const chunkId = (g.draft as { sourceChunkId?: string }).sourceChunkId;
    const [chunk] = chunkId ? await db.select({ id: fileChunks.id, text: fileChunks.text }).from(fileChunks).where(eq(fileChunks.id, chunkId)) : [];
    // Sealed sets are approved by the automated gate; a curate set by the host who approved this question.
    const [approval] = mode === "curate"
      ? await db.select({ u: users }).from(partyQuestionEvents).innerJoin(partyQuestions, eq(partyQuestions.id, partyQuestionEvents.questionId)).innerJoin(users, eq(users.id, partyQuestionEvents.userId))
        .where(and(eq(partyQuestionEvents.partyId, g.partyId), eq(partyQuestions.sourceRef, id), eq(partyQuestionEvents.kind, "approve"))).limit(1)
      : [];
    return {
      partyId: g.partyId, brief: g.brief, spec: g.spec, draft: g.draft, sourceChunk: chunk ?? null, verify: g.verify, dedupe: g.dedupe,
      difficulty: g.difficulty, safety: g.safety, outcome: g.outcome,
      approvedBy: approval ? { kind: "host" as const, person: toPerson(approval.u) } : { kind: "gate" as const },
      createdAt: g.createdAt.toISOString(),
    };
  }));
  const hidden = row.inUnstartedParty;
  return adminQuestionDetailSchema.parse({
    question: { ...row, explanation: hidden ? null : q.explanation, difficulty: q.difficulty, difficultySource: q.difficultySource, sourceChunkId: q.sourceChunkId },
    voidEvents: voidRows.map(({ e, title }) => ({ partyId: e.partyId, partyTitle: title, at: e.createdAt.toISOString(), detail: e.detail })),
    // A generation record carries the draft itself, so it's withheld with the content.
    generation: hidden ? [] : generation,
    reviews: reviews.map(({ r, admin }) => ({ id: r.id, status: r.status, reason: r.reason, admin: toPerson(admin), edit: r.edit, verify: r.verify, safety: r.safety, dedupe: r.dedupe, createdAt: r.createdAt.toISOString(), judgedAt: r.judgedAt?.toISOString() ?? null })),
    actions,
  });
}

export async function adminQuestionsRoutes(app: FastifyInstance) {
  app.get("/admin/questions", async (req) => {
    requireAdmin(req);
    const { view, limit } = adminQuestionsQuerySchema.parse(req.query);
    const where = view === "flagged" ? or(gt(bankQuestions.flagCount, 0), eq(bankQuestions.status, "pending_review")) : eq(bankQuestions.status, view);
    const rows = await db.select().from(bankQuestions).where(where).orderBy(desc(bankQuestions.flagCount), desc(bankQuestions.createdAt)).limit(limit);
    return adminQuestionsResponseSchema.parse({ questions: await questionRows(rows) });
  });

  app.get("/admin/questions/:id", async (req) => {
    requireAdmin(req);
    return questionDetail(uuidParam(req));
  });

  /** Back into retrieval: active, flags cleared (the admin vouched for it, so the sweep mustn't retire it again for the same flags). */
  app.post("/admin/questions/:id/restore", async (req) => {
    const admin = requireAdmin(req);
    const { reason } = adminReasonBodySchema.parse(req.body);
    const id = uuidParam(req);
    await db.transaction(async (tx) => {
      const q = await lockQuestion(tx, id);
      if (q.retiredReason === ADMIN_RETIRED) throw httpError(409, "retired_permanently");
      if (q.status === "active" && q.flagCount === 0) return;
      const [after] = await tx.update(bankQuestions).set({ status: "active", flagCount: 0, retiredReason: null, retiredAt: null }).where(eq(bankQuestions.id, id)).returning();
      await recordAdminAction(tx, { adminUserId: admin.id, action: "question.restore", targetType: "question", targetId: id, reason, before: statusOf(q), after: statusOf(after) });
    });
    return questionDetail(id);
  });

  /** Out of the bank for good. */
  app.post("/admin/questions/:id/retire", async (req) => {
    const admin = requireAdmin(req);
    const { reason } = adminReasonBodySchema.parse(req.body);
    const id = uuidParam(req);
    await db.transaction(async (tx) => {
      const q = await lockQuestion(tx, id);
      if (q.retiredReason === ADMIN_RETIRED) return;
      const [after] = await tx.update(bankQuestions).set({ status: "retired", retiredReason: ADMIN_RETIRED, retiredAt: new Date() }).where(eq(bankQuestions.id, id)).returning();
      await recordAdminAction(tx, { adminUserId: admin.id, action: "question.retire", targetType: "question", targetId: id, reason, before: statusOf(q), after: statusOf(after) });
    });
    return questionDetail(id);
  });

  /** Edit and re-verify: opens a review the questions service judges; the bank row changes only if the edit passes. */
  app.post("/admin/questions/:id/edit", async (req, reply) => {
    const admin = requireAdmin(req);
    const body = adminEditQuestionSchema.parse(req.body);
    const id = uuidParam(req);
    const review = await db.transaction(async (tx) => {
      const q = await lockQuestion(tx, id);
      if (q.retiredReason === ADMIN_RETIRED) throw httpError(409, "retired_permanently");
      if ((await heldByUnstartedParties([id])).has(id)) throw httpError(409, "in_unstarted_party");
      if (!payloadSchemas[q.format as QuestionFormat].safeParse(body.payload).success) throw httpError(400, "invalid_payload");
      const edit = { payload: body.payload, explanation: body.explanation, claim: body.claim };
      const [r] = await tx.insert(questionReviews).values({ bankQuestionId: id, adminUserId: admin.id, reason: body.reason, edit }).returning();
      await recordAdminAction(tx, { adminUserId: admin.id, action: "question.edit", targetType: "question", targetId: id, reason: body.reason, before: { payload: q.payload, explanation: q.explanation }, after: { ...edit, reviewId: r.id } });
      return r;
    });
    await questionJobs.add("review_edit", { kind: "review_edit", reviewId: review.id }, { jobId: `review-edit-${review.id}` });
    return reply.code(202).send(adminQuestionReviewResponseSchema.parse({ reviewId: review.id, status: "pending" }));
  });
}

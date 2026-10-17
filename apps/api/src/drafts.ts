/**
 * Curate mode (ADR 0003): the host's team reviews generated drafts before the party — approve,
 * edit, swap for a reserve, or ask the engine to regenerate one. Drafts are party_questions rows
 * with status "draft"; approving makes them "pending" (ready to play). Anyone who has seen the
 * drafts is recorded in party_draft_views and can't play the party. Every action is logged in
 * party_question_events so an admin can see who approved what.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  db, parties, partyPlayers, partyQuestions, partyQuestionEvents, partyDraftViews, partyFiles, questionGenerations,
  isHostTeam, type Party, type Tx, type User,
} from "@contestly/db";
import { payloadSchemas } from "@contestly/game";
import { checkSafety, parseExclusions, type QuestionFormat } from "@contestly/shared";
import { questionsQueue } from "@contestly/queue";

const questionJobs = questionsQueue();

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/** Lock the party and check it's an open curate party this user may review. */
async function lockCurateParty(tx: Tx, partyId: string, user: User): Promise<Party> {
  const [p] = await tx.select().from(parties).where(eq(parties.id, partyId)).for("update");
  if (!p) throw httpError(404, "not_found");
  if (!isHostTeam(p, user.id)) throw httpError(403, "host_team_only");
  if (p.mode !== "curate") throw httpError(409, "not_a_curate_party");
  if (p.status !== "open") throw httpError(409, "party_not_open");
  return p;
}

async function draftRow(tx: Tx, partyId: string, questionId: string) {
  const [q] = await tx.select().from(partyQuestions).where(and(eq(partyQuestions.id, questionId), eq(partyQuestions.partyId, partyId)));
  if (!q) throw httpError(404, "question_not_found");
  return q;
}

const log = (tx: Tx, e: typeof partyQuestionEvents.$inferInsert) => tx.insert(partyQuestionEvents).values(e);

/** Ask the engine to draft the set. Waits for any attached file to finish parsing. */
export async function requestDrafts(partyId: string, user: User): Promise<void> {
  await db.transaction(async (tx) => {
    await lockCurateParty(tx, partyId, user);
    const files = await tx.select({ status: partyFiles.status }).from(partyFiles).where(eq(partyFiles.partyId, partyId));
    if (files.some((f) => f.status === "failed")) throw httpError(409, "source_file_failed");
    if (files.some((f) => f.status !== "parsed")) throw httpError(409, "source_file_not_ready");
    const existing = await tx.select({ id: partyQuestions.id }).from(partyQuestions).where(eq(partyQuestions.partyId, partyId)).limit(1);
    if (existing.length) throw httpError(409, "drafts_already_generated");
    await tx.update(parties).set({ questionsStatus: "generating", questionsError: null }).where(eq(parties.id, partyId));
  });
  // A fresh job id each time: an earlier attempt that failed keeps its id in the queue's history.
  await questionJobs.add("generate_set", { kind: "generate_set", partyId }, { jobId: `generate-set-${partyId}-${Date.now()}` });
}

/** The full drafts, answers included, for the host's team. Looking bars the viewer from playing. */
export async function listDrafts(partyId: string, user: User) {
  const [p] = await db.select().from(parties).where(eq(parties.id, partyId));
  if (!p) throw httpError(404, "not_found");
  if (!isHostTeam(p, user.id)) throw httpError(403, "host_team_only");
  if (p.mode !== "curate") throw httpError(409, "not_a_curate_party");
  const seated = await db.select().from(partyPlayers).where(and(eq(partyPlayers.partyId, partyId), eq(partyPlayers.userId, user.id)));
  if (seated.length) throw httpError(409, "you_are_playing_this_party");

  await db.insert(partyDraftViews).values({ partyId, userId: user.id }).onConflictDoNothing();
  const rows = await db.select().from(partyQuestions).where(eq(partyQuestions.partyId, partyId)).orderBy(asc(partyQuestions.idx));
  const bankIds = rows.map((r) => r.sourceRef).filter((x): x is string => !!x);
  const records = bankIds.length ? await db.select().from(questionGenerations).where(inArray(questionGenerations.bankQuestionId, bankIds)) : [];
  const recordOf = new Map(records.map((r) => [r.bankQuestionId, r]));
  return {
    specSummary: p.specSummary,
    questions: rows.map((r) => {
      const rec = r.sourceRef ? recordOf.get(r.sourceRef) : undefined;
      return {
        id: r.id, idx: r.idx, reserve: r.reserve, status: r.status, format: r.format,
        payload: r.payload, explanation: r.explanation, hostAuthored: r.hostAuthored,
        verification: rec ? { sources: (rec.verify as { sources?: string[] } | null)?.sources ?? [], difficulty: rec.difficulty } : null,
      };
    }),
  };
}

export async function approveDraft(partyId: string, questionId: string, user: User): Promise<void> {
  await db.transaction(async (tx) => {
    await lockCurateParty(tx, partyId, user);
    const q = await draftRow(tx, partyId, questionId);
    if (q.status !== "draft") throw httpError(409, "not_a_draft");
    await tx.update(partyQuestions).set({ status: "pending" }).where(eq(partyQuestions.id, q.id));
    await log(tx, { partyId, questionId: q.id, kind: "approve", userId: user.id });
  });
}

/**
 * A host edit: the payload must fit its format and pass the same safety filter as generated
 * questions. Edited questions are host-authored, go back to draft for approval, and stay out of
 * the shared bank (they're party-specific and unverified).
 */
export async function editDraft(partyId: string, questionId: string, user: User, edit: { payload: Record<string, unknown>; explanation?: string }): Promise<void> {
  await db.transaction(async (tx) => {
    const p = await lockCurateParty(tx, partyId, user);
    const q = await draftRow(tx, partyId, questionId);
    if (q.status !== "draft" && q.status !== "pending") throw httpError(409, "not_editable");
    const payload = payloadSchemas[q.format as QuestionFormat].parse(edit.payload);
    const safety = checkSafety({ topic: p.brief, exclusions: parseExclusions(p.brief) }, payload, edit.explanation);
    if (!safety.passed) throw httpError(422, `unsafe: ${safety.reasons.join(", ")}`);
    await tx.update(partyQuestions).set({ payload, explanation: edit.explanation ?? q.explanation, hostAuthored: true, sourceRef: null, status: "draft" }).where(eq(partyQuestions.id, q.id));
    await log(tx, { partyId, questionId: q.id, kind: "edit", userId: user.id, detail: { before: { payload: q.payload, explanation: q.explanation, sourceRef: q.sourceRef } } });
  });
}

/**
 * Swap a question for the first unused reserve. The reserve takes the slot (as a draft to review);
 * the swapped-out question becomes a voided reserve, so it never plays but stays in the record.
 */
export async function swapDraft(partyId: string, questionId: string, user: User): Promise<void> {
  await db.transaction(async (tx) => {
    await lockCurateParty(tx, partyId, user);
    const out = await draftRow(tx, partyId, questionId);
    if (out.reserve || (out.status !== "draft" && out.status !== "pending")) throw httpError(409, "not_swappable");
    const [incoming] = await tx.select().from(partyQuestions)
      .where(and(eq(partyQuestions.partyId, partyId), eq(partyQuestions.reserve, true), inArray(partyQuestions.status, ["draft", "pending"])))
      .orderBy(asc(partyQuestions.idx)).limit(1);
    if (!incoming) throw httpError(409, "no_reserves_left_try_regenerate");
    // (party_id, idx) is unique: park the outgoing row on a free index while the two trade places.
    await tx.update(partyQuestions).set({ idx: -1 - out.idx }).where(eq(partyQuestions.id, out.id));
    await tx.update(partyQuestions).set({ idx: out.idx, reserve: false, status: "draft" }).where(eq(partyQuestions.id, incoming.id));
    await tx.update(partyQuestions).set({ idx: incoming.idx, reserve: true, status: "voided" }).where(eq(partyQuestions.id, out.id));
    await log(tx, { partyId, questionId: out.id, kind: "swap", userId: user.id, detail: { replacementId: incoming.id } });
  });
}

export async function requestRegenerate(partyId: string, questionId: string, user: User): Promise<void> {
  await db.transaction(async (tx) => {
    await lockCurateParty(tx, partyId, user);
    const q = await draftRow(tx, partyId, questionId);
    if (q.status === "pending") await tx.update(partyQuestions).set({ status: "draft" }).where(eq(partyQuestions.id, q.id));
    else if (q.status !== "draft") throw httpError(409, "not_regeneratable");
  });
  await questionJobs.add("regenerate_one", { kind: "regenerate_one", partyId, partyQuestionId: questionId, requestedBy: user.id }, { jobId: `regenerate-${questionId}-${Date.now()}` });
}

/** True when this user may not play the party: the host's team in curate mode, or anyone who saw its drafts. */
export async function barredFromPlaying(p: Party, userId: string): Promise<boolean> {
  if (p.mode !== "curate") return false;
  if (isHostTeam(p, userId)) return true;
  const [viewed] = await db.select().from(partyDraftViews).where(and(eq(partyDraftViews.partyId, p.id), eq(partyDraftViews.userId, userId)));
  return !!viewed;
}

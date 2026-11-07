/**
 * Host-written questions as rows (ADR 0015): party_questions with host_written (and host_authored, so nothing
 * treats them as bank questions), pick-one, never with a source_ref. Each one is a draft until the model safety
 * check passes it (edit_check, run by the questions service's check_host_edit), and then approved: its author
 * wrote it. One that fails stays a draft, so the party can't start on it. The party's
 * host_question_count is recomputed from the rows by syncHostQuestionCount() after every change, so the disclosure,
 * the caps and settlement read one number that can't drift from the set.
 */
import { randomInt, randomUUID } from "node:crypto";
import { and, count, eq, sql } from "drizzle-orm";
import { DISTRACTOR_COUNT, hostQuestionPayload, type HostEditCheck, type HostQuestion } from "@contestly/shared";
import type { Tx } from "../client.js";
import { db } from "../client.js";
import { heldPrizes, parties, partyQuestionEvents, partyQuestions, type Party } from "../schema.js";

type Conn = Tx | typeof db;

/** Recount the play order's host-written questions onto the party. Call after any change to them, in the same transaction. */
export async function syncHostQuestionCount(tx: Tx, partyId: string): Promise<number> {
  const [{ n }] = await tx.select({ n: count() }).from(partyQuestions)
    .where(and(eq(partyQuestions.partyId, partyId), eq(partyQuestions.hostWritten, true), eq(partyQuestions.reserve, false)));
  await tx.update(parties).set({ hostQuestionCount: Number(n) }).where(eq(parties.id, partyId));
  return Number(n);
}

/** Where the right answer lands: anywhere among the four, so it's never always A. */
export const shuffledCorrectIndex = () => randomInt(0, DISTRACTOR_COUNT + 1);

/** A model safety check waiting to run on a host's words (the questions service's check_host_edit decides it). */
export const pendingHostCheck = (): HostEditCheck => ({ id: randomUUID(), status: "checking", reasons: [] });

/**
 * Write one host-written question into the party's set at `idx`, a draft until its model safety check passes,
 * logged as "author". The caller has locked the party, checked the stakes and the share cap, run the term filter,
 * and queues the check (by `editCheck.id`) once this commits.
 */
export async function insertHostQuestion(tx: Tx, p: Pick<Party, "id" | "questionSeconds">, q: HostQuestion, idx: number, authorId: string) {
  const [row] = await tx.insert(partyQuestions).values({
    partyId: p.id, idx, format: "pick_one", payload: hostQuestionPayload(q, shuffledCorrectIndex()), seconds: p.questionSeconds,
    explanation: q.explanation ?? null, status: "draft", reserve: false, sourceRef: null, hostAuthored: true, hostWritten: true, editCheck: pendingHostCheck(),
  }).returning();
  await tx.insert(partyQuestionEvents).values({ partyId: p.id, questionId: row.id, kind: "author", userId: authorId });
  return row as typeof row & { editCheck: HostEditCheck };
}

/** The next free index after everything in the set (reserves included), for a question added later. */
export async function nextQuestionIdx(tx: Tx, partyId: string): Promise<number> {
  const [{ max }] = await tx.select({ max: sql<number | null>`max(${partyQuestions.idx})` }).from(partyQuestions).where(eq(partyQuestions.partyId, partyId));
  return max === null ? 0 : Number(max) + 1;
}

/** What a person has in held prizes right now (0 when none). */
export async function heldPrizeKobo(conn: Conn, userId: string): Promise<number> {
  const [{ total }] = await conn.select({ total: sql<number>`coalesce(sum(${heldPrizes.amountKobo}), 0)` }).from(heldPrizes)
    .where(and(eq(heldPrizes.userId, userId), eq(heldPrizes.status, "held")));
  return Number(total);
}

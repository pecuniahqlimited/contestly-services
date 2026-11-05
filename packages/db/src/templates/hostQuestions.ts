/**
 * Host-written questions as rows (ADR 0015): party_questions with host_written (and host_authored, so nothing
 * treats them as bank questions), pick-one, approved by their author, never with a source_ref. The party's
 * host_question_count is recomputed from the rows by syncHostQuestionCount() after every change, so the disclosure,
 * the caps and settlement read one number that can't drift from the set.
 */
import { randomInt } from "node:crypto";
import { and, count, eq, sql } from "drizzle-orm";
import { DISTRACTOR_COUNT, PRIZE_UNDER_REVIEW, hostQuestionPayload, type HostQuestion } from "@contestly/shared";
import type { Tx } from "../client.js";
import { db } from "../client.js";
import { heldPrizes, ledgerAccounts, parties, partyQuestionEvents, partyQuestions, type Party } from "../schema.js";

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

/**
 * Write one host-written question into the party's set at `idx` (approved: its author wrote it), logged as
 * "author". The caller has locked the party, checked the stakes and the share cap, and run the safety filter.
 */
export async function insertHostQuestion(tx: Tx, p: Pick<Party, "id" | "questionSeconds">, q: HostQuestion, idx: number, authorId: string) {
  const [row] = await tx.insert(partyQuestions).values({
    partyId: p.id, idx, format: "pick_one", payload: hostQuestionPayload(q, shuffledCorrectIndex()), seconds: p.questionSeconds,
    explanation: q.explanation ?? null, status: "pending", reserve: false, sourceRef: null, hostAuthored: true, hostWritten: true,
  }).returning();
  await tx.insert(partyQuestionEvents).values({ partyId: p.id, questionId: row.id, kind: "author", userId: authorId });
  return row;
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

/**
 * A held prize stays in the winner's cash until an admin decides, so a reject can always take it back: after
 * anything that took cash from them in this transaction (an entry, a host's prize hold), their cash must still
 * cover what's held, or the transaction is refused (409 prize_under_review) and rolls back. Their cash account
 * is already locked by the movement that just ran.
 */
export async function assertHeldPrizesKept(tx: Tx, userId: string): Promise<void> {
  const held = await heldPrizeKobo(tx, userId);
  if (held <= 0) return;
  const [cash] = await tx.select({ balance: ledgerAccounts.balanceKobo }).from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.userId, userId), eq(ledgerAccounts.kind, "cash"), eq(ledgerAccounts.scope, "")));
  if ((cash?.balance ?? 0) < held) throw Object.assign(new Error(PRIZE_UNDER_REVIEW), { statusCode: 409, details: { heldKobo: held } });
}

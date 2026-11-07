/**
 * Host-written questions (ADR 0015): what only the host can answer, pick-one, the host's question and right answer
 * with three wrong ones (suggested by the questions service, editable). The host's words always pass the term
 * filter here and then the model safety check in the questions service (queued once the row commits; until it
 * passes, the question is a draft and the party can't start), both failing closed; nothing fact-checks them; they
 * live in the party's set only (never the bank).
 *
 * Any at all makes the party curate (the host and anyone who saw the set can't play, ADR 0003), never free, and
 * inside the caps (checkHostWrittenStakes). They can be written at creation or added, edited and removed while the
 * party is open: before the engine has drafted the rest of the set an added one takes a themed question's place;
 * after, it adds to the play order (and a removed one shortens it).
 */
import { and, eq } from "drizzle-orm";
import {
  curateHostType, currentPartyTemplates, db, insertHostQuestion, publicHost, isHostTeam, nextQuestionIdx, parties, partyQuestionEvents, partyQuestions, pendingHostCheck, syncHostQuestionCount, type Party, type Tx, type User,
} from "@contestly/db";
import { payloadSchemas } from "@contestly/game";
import { checkHostWrittenStakes, hostQuestionPayload, type CurateHostType, type HostQuestion, type HostWrittenRules } from "@contestly/shared";
import { assertHostTextSafe } from "./distractors.js";
import { queueEditCheck } from "./drafts.js";
import { httpError } from "./httpError.js";

/** The fewest questions a party plays (createPartySchema's minimum). */
const MIN_QUESTIONS = 3;
const MAX_QUESTIONS = 30;
/** A removed host-written question is parked below every play-order index, keeping its history. */
const PARKED_IDX_BASE = -100_000;

/** Every host question's words through the safety filter (failing closed), with which one failed. */
export function assertHostQuestionsSafe(qs: HostQuestion[], brief: string) {
  qs.forEach((q, index) => assertHostTextSafe(q, brief, { index }));
}

/** The stakes and the share for a party (curate, or with this many host-written questions); refused with the first rule broken. */
export function assertHostWrittenStakes(p: Pick<Party, "funding" | "entryKobo" | "hostPoolKobo" | "prizeKind" | "maxPlayers" | "questionCount" | "mode"> & { fromTemplate: boolean; hostType: CurateHostType }, hostQuestionCount: number, rules: HostWrittenRules) {
  const [refused] = checkHostWrittenStakes({ ...p, hostQuestionCount }, rules);
  if (refused) throw httpError(422, refused);
}

/** A model safety check to queue once its row has committed. */
export interface HostCheck { partyId: string; questionId: string; checkId: string }
export const queueHostChecks = (checks: HostCheck[]) => Promise.all(checks.map((c) => queueEditCheck(c.partyId, c.questionId, c.checkId)));

/**
 * At creation, in its transaction: the host's questions into the new party's set (the engine fills the rest later).
 * Returns their model safety checks, for the caller to queue after the commit.
 */
export async function writeHostQuestions(tx: Tx, p: Party, qs: HostQuestion[], authorId: string): Promise<HostCheck[]> {
  const checks: HostCheck[] = [];
  for (const [i, q] of qs.entries()) {
    const row = await insertHostQuestion(tx, p, q, i, authorId);
    checks.push({ partyId: p.id, questionId: row.id, checkId: row.editCheck.id });
  }
  if (qs.length) await syncHostQuestionCount(tx, p.id);
  return checks;
}

/** Lock the party and check the host's team may change its host-written questions now. */
async function lockForHostQuestions(tx: Tx, partyId: string, user: User): Promise<Party> {
  const [p] = await tx.select().from(parties).where(eq(parties.id, partyId)).for("update");
  if (!p) throw httpError(404, "not_found");
  if (!isHostTeam(p, user.id)) throw httpError(403, "host_team_only");
  if (p.status !== "open") throw httpError(409, "party_not_open");
  // A sealed host plays (and is seated, maybe charged): host-written questions would turn that around. Make it curate from the start.
  if (p.mode !== "curate") throw httpError(409, "sealed_party_no_host_questions");
  if (p.questionsStatus === "generating") throw httpError(409, "questions_generating");
  return p;
}

/** Whether the engine has drafted the rest of the set yet. */
async function drafted(tx: Tx, partyId: string): Promise<boolean> {
  const [row] = await tx.select({ id: partyQuestions.id }).from(partyQuestions).where(and(eq(partyQuestions.partyId, partyId), eq(partyQuestions.hostWritten, false))).limit(1);
  return !!row;
}

async function hostRow(tx: Tx, partyId: string, questionId: string) {
  const [q] = await tx.select().from(partyQuestions).where(and(eq(partyQuestions.id, questionId), eq(partyQuestions.partyId, partyId)));
  if (!q) throw httpError(404, "question_not_found");
  if (!q.hostWritten) throw httpError(409, "not_host_written");
  if (q.reserve || (q.status !== "pending" && q.status !== "draft")) throw httpError(409, "not_editable");
  return q;
}

/** The party's own copy of the rules; one from before copies were kept takes the current config's (never code's). */
const rulesOf = async (tx: Tx, p: Party) => p.hostRules ?? (await currentPartyTemplates(tx)).config.rules;

/** Add one to an open curate party. */
export async function addHostQuestion(partyId: string, user: User, q: HostQuestion) {
  const added = await db.transaction(async (tx) => {
    const p = await lockForHostQuestions(tx, partyId, user);
    assertHostTextSafe(q, p.brief);
    const grows = await drafted(tx, partyId);
    const questionCount = grows ? p.questionCount + 1 : p.questionCount;
    if (questionCount > MAX_QUESTIONS) throw httpError(409, "too_many_questions");
    assertHostWrittenStakes({ ...p, questionCount, fromTemplate: !!p.template, hostType: curateHostType(await publicHost(p)) }, p.hostQuestionCount + 1, await rulesOf(tx, p));
    if (grows) await tx.update(parties).set({ questionCount }).where(eq(parties.id, partyId));
    const row = await insertHostQuestion(tx, p, q, await nextQuestionIdx(tx, partyId), user.id);
    await syncHostQuestionCount(tx, partyId);
    return { id: row.id, idx: row.idx, checkId: row.editCheck.id };
  });
  await queueHostChecks([{ partyId, questionId: added.id, checkId: added.checkId }]);
  return { id: added.id, idx: added.idx };
}

/**
 * The host rewrites one of theirs: the same term filter, and a draft again until the model check passes the new
 * words (then approved again: they wrote it). Logged with what it was.
 */
export async function editHostQuestion(partyId: string, questionId: string, user: User, q: HostQuestion) {
  const check = pendingHostCheck();
  await db.transaction(async (tx) => {
    const p = await lockForHostQuestions(tx, partyId, user);
    const row = await hostRow(tx, partyId, questionId);
    assertHostTextSafe(q, p.brief);
    // Where the right answer sits stays where it was, so a reworded question doesn't move it.
    const was = payloadSchemas.pick_one.parse(row.payload);
    const payload = hostQuestionPayload(q, was.correctIndex);
    await tx.update(partyQuestions).set({ payload, explanation: q.explanation ?? null, status: "draft", editCheck: check }).where(eq(partyQuestions.id, row.id));
    await tx.insert(partyQuestionEvents).values({ partyId, questionId: row.id, kind: "edit", userId: user.id, detail: { before: { payload: row.payload, explanation: row.explanation }, checkId: check.id } });
  });
  await queueHostChecks([{ partyId, questionId, checkId: check.id }]);
}

/**
 * Remove one of theirs. Before the rest of the set is drafted it's simply gone (the engine fills its place). After,
 * the play order shortens by one (never below the minimum) and the row is kept out of it, voided, for the record.
 */
export async function removeHostQuestion(partyId: string, questionId: string, user: User) {
  await db.transaction(async (tx) => {
    const p = await lockForHostQuestions(tx, partyId, user);
    const row = await hostRow(tx, partyId, questionId);
    if (!(await drafted(tx, partyId))) {
      await tx.delete(partyQuestions).where(eq(partyQuestions.id, row.id));
    } else {
      if (p.questionCount - 1 < MIN_QUESTIONS) throw httpError(409, "too_few_questions");
      await tx.update(partyQuestions).set({ status: "voided", reserve: true, idx: PARKED_IDX_BASE - row.idx }).where(eq(partyQuestions.id, row.id));
      await tx.update(parties).set({ questionCount: p.questionCount - 1 }).where(eq(parties.id, partyId));
      await tx.insert(partyQuestionEvents).values({ partyId, questionId: row.id, kind: "author", userId: user.id, detail: { removed: true, idx: row.idx } });
    }
    await syncHostQuestionCount(tx, partyId);
  });
}

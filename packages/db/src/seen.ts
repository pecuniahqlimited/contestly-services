/**
 * "Seen by a seated player": the one rule for not repeating questions. A bank question counts as
 * seen by a player once they were in the match when it ran in another party (answered or not).
 * The questions service excludes these when building a set, and the worker checks the final
 * roster against the sealed set at start; both read it from here.
 */
import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { db } from "./client.js";
import { partyAnswers, partyPlayers, partyQuestions } from "./schema.js";

export interface SeenQuestion {
  bankId: string;
  payload: unknown;
}

/** Bank questions anyone now seated in `partyId` has been shown in an earlier party. */
export async function seenBySeated(partyId: string): Promise<SeenQuestion[]> {
  const seated = db.select({ userId: partyPlayers.userId }).from(partyPlayers).where(eq(partyPlayers.partyId, partyId));
  const rows = await db
    .selectDistinct({ bankId: partyQuestions.sourceRef, payload: partyQuestions.payload })
    .from(partyAnswers)
    .innerJoin(partyQuestions, eq(partyAnswers.questionId, partyQuestions.id))
    .where(and(inArray(partyAnswers.userId, seated), isNotNull(partyQuestions.sourceRef), ne(partyAnswers.partyId, partyId)));
  return rows.map((r) => ({ bankId: r.bankId!, payload: r.payload }));
}

/**
 * The party's playable questions (play order and unused reserves) that someone seated has already
 * seen — what the start-time re-check must swap. Empty means the set can start as sealed.
 */
export async function seenInSet(partyId: string) {
  const seen = new Set((await seenBySeated(partyId)).map((s) => s.bankId));
  if (!seen.size) return [];
  const rows = await db.select().from(partyQuestions)
    .where(and(eq(partyQuestions.partyId, partyId), inArray(partyQuestions.status, ["pending", "draft"])));
  return rows.filter((q) => q.sourceRef && seen.has(q.sourceRef));
}

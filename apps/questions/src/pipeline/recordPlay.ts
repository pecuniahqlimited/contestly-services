/**
 * record_play: fold a finished party's answers back into the bank — raw counters, so difficulty
 * recalibration is pure math over the row. Idempotent via parties.play_stats_recorded_at (job ids
 * get cleaned, the column doesn't). Once a question has enough real answers, its difficulty flips
 * from the model estimate to observed 1 − answer rate.
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db, parties, partyQuestions, partyAnswers, bankQuestions } from "@contestly/db";

/** Real answers needed before play stats overrule the model estimate. */
export const RECALIBRATION_FLOOR = 30;

export async function recordPlay(partyId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [party] = await tx.select().from(parties).where(eq(parties.id, partyId)).for("update");
    if (!party || party.status !== "finished" || party.playStatsRecordedAt) return;

    // Per bank question: every graded row counts as asked; no-answers drag the answer rate down on purpose.
    const stats = await tx
      .select({
        bankId: partyQuestions.sourceRef,
        answered: sql<number>`count(*)`,
        correctnessSum: sql<number>`coalesce(sum(${partyAnswers.correctness}), 0)`,
        answeredMsSum: sql<number>`coalesce(sum(${partyAnswers.answeredMs}), 0)`,
        skipped: sql<number>`count(*) filter (where ${partyAnswers.answer} is null)`,
      })
      .from(partyAnswers)
      .innerJoin(partyQuestions, eq(partyAnswers.questionId, partyQuestions.id))
      .where(and(eq(partyQuestions.partyId, partyId), eq(partyQuestions.status, "played"), isNotNull(partyQuestions.sourceRef)))
      .groupBy(partyQuestions.sourceRef);

    for (const s of stats) {
      if (!s.bankId) continue;
      await tx.update(bankQuestions).set({
        timesPlayed: sql`${bankQuestions.timesPlayed} + 1`,
        timesAnswered: sql`${bankQuestions.timesAnswered} + ${Number(s.answered)}`,
        correctnessSum: sql`${bankQuestions.correctnessSum} + ${Number(s.correctnessSum)}`,
        answeredMsSum: sql`${bankQuestions.answeredMsSum} + ${Number(s.answeredMsSum)}`,
        timesSkipped: sql`${bankQuestions.timesSkipped} + ${Number(s.skipped)}`,
        lastPlayedAt: new Date(),
      }).where(eq(bankQuestions.id, s.bankId));

      await tx.update(bankQuestions).set({
        difficulty: sql`1 - (${bankQuestions.correctnessSum}::real / ${bankQuestions.timesAnswered} / 100)`,
        difficultySource: "play_stats",
      }).where(and(eq(bankQuestions.id, s.bankId), sql`${bankQuestions.timesAnswered} >= ${RECALIBRATION_FLOOR}`));
    }

    await tx.update(parties).set({ playStatsRecordedAt: new Date() }).where(eq(parties.id, partyId));
    console.log(`[questions] ${party.title}: play stats recorded for ${stats.length} bank question(s)`);
  });
}

/**
 * Learning from play, the negative half: a question voided in a room leaves retrieval at once
 * (pending review), and a daily sweep retires bank questions that players keep flagging, that
 * almost nobody gets right, or that most players don't answer at all. Thresholds are admin
 * config; the decision is a pure function so the edges are unit-tested.
 */
import { and, eq, gte, inArray, or, sql } from "drizzle-orm";
import { db, bankQuestions, partyQuestions, getQuestionsConfig } from "@contestly/db";
import type { QuestionsConfig } from "@contestly/shared";

export type RetireReason = "flagged" | "too_hard" | "skipped";

export interface BankStats {
  flagCount: number;
  timesAnswered: number;
  correctnessSum: number; // sum of 0–100 per answer
  timesSkipped: number;
}

export function retirementReason(s: BankStats, cfg: QuestionsConfig): RetireReason | null {
  if (s.flagCount >= cfg.retireFlagCount) return "flagged";
  if (s.timesAnswered < cfg.retireMinAnswers) return null;
  if (s.correctnessSum / s.timesAnswered < cfg.retireBelowCorrectPct) return "too_hard";
  if ((s.timesSkipped / s.timesAnswered) * 100 > cfg.retireAboveSkipPct) return "skipped";
  return null;
}

/** A question voided by player flags: count the flags and pull it from retrieval until reviewed. */
export async function questionVoided(job: { partyQuestionId: string; flags: number }): Promise<void> {
  const [pq] = await db.select({ sourceRef: partyQuestions.sourceRef }).from(partyQuestions).where(eq(partyQuestions.id, job.partyQuestionId));
  if (!pq?.sourceRef) return; // host-authored edits never entered the bank
  await db.update(bankQuestions).set({
    flagCount: sql`${bankQuestions.flagCount} + ${job.flags}`,
    status: sql`case when ${bankQuestions.status} = 'active' then 'pending_review'::bank_question_status else ${bankQuestions.status} end`,
  }).where(eq(bankQuestions.id, pq.sourceRef));
}

export async function retireSweep(): Promise<void> {
  const cfg = await getQuestionsConfig();
  const candidates = await db.select().from(bankQuestions).where(and(
    inArray(bankQuestions.status, ["active", "pending_review"]),
    or(gte(bankQuestions.flagCount, cfg.retireFlagCount), gte(bankQuestions.timesAnswered, cfg.retireMinAnswers)),
  ));
  const byReason = new Map<RetireReason, string[]>();
  for (const q of candidates) {
    const reason = retirementReason(q, cfg);
    if (reason) byReason.set(reason, [...(byReason.get(reason) ?? []), q.id]);
  }
  for (const [reason, ids] of byReason) {
    await db.update(bankQuestions).set({ status: "retired", retiredReason: reason, retiredAt: new Date() }).where(inArray(bankQuestions.id, ids));
  }
  const total = [...byReason.values()].reduce((a, ids) => a + ids.length, 0);
  console.log(`[questions] retirement sweep: ${total} retired of ${candidates.length} candidate(s)`);
}

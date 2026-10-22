/** The onboarding round's record: its questions from the bank, and each player's result. */
import { and, eq, inArray, isNull, lte, sql as dsql } from "drizzle-orm";
import { db } from "./client.js";
import { bankQuestions, onboardingRounds, users, type BankQuestion } from "./schema.js";
import { claimOnboardingReward } from "./accounts.js";

/**
 * `count` easy pick-one questions from the bank, preferring the players' lanes, random otherwise.
 * Never one generated from a party's file (those belong to that party).
 */
export async function onboardingQuestions(lanes: string[], count: number, maxDifficulty: number): Promise<BankQuestion[]> {
  const order = lanes.length ? [dsql`case when ${inArray(bankQuestions.categoryTag, lanes)} then 0 else 1 end`, dsql`random()`] : [dsql`random()`];
  return db.select().from(bankQuestions)
    .where(and(eq(bankQuestions.status, "active"), eq(bankQuestions.format, "pick_one"), isNull(bankQuestions.sourceChunkId), lte(bankQuestions.difficulty, maxDifficulty)))
    .orderBy(...order).limit(count);
}

/** Players who already have a round (one each, ever). */
export async function playedOnboarding(userIds: string[]): Promise<Set<string>> {
  if (!userIds.length) return new Set();
  const rows = await db.select({ id: onboardingRounds.userId }).from(onboardingRounds).where(inArray(onboardingRounds.userId, userIds));
  return new Set(rows.map((r) => r.id));
}

export type OnboardingRoundInsert = typeof onboardingRounds.$inferInsert;

/**
 * Save a finished round. A guest's coins wait on the round until they sign up; someone already signed
 * up claims them now. One round per player: a second one is ignored.
 */
export async function recordOnboardingRound(row: OnboardingRoundInsert) {
  return db.transaction(async (tx) => {
    const [saved] = await tx.insert(onboardingRounds).values(row).onConflictDoNothing().returning();
    if (!saved) return { saved: false as const };
    const [u] = await tx.select().from(users).where(eq(users.id, row.userId));
    return { saved: true as const, claim: await claimOnboardingReward(tx, u) };
  });
}

/**
 * The Forge, from the engine's side: as a set is made, record its stage and the cards so far (formats
 * only) on the party, and tell the room. Party detail and the room show it through questionDisclosure().
 */
import { eq } from "drizzle-orm";
import { db, parties } from "@contestly/db";
import type { ForgeProgress, ForgeStage, QuestionFormat } from "@contestly/shared";

export type Publish = (ev: { partyId: string; status: string }) => Promise<unknown>;

/** The progress a fill reports, as the deck shows it: never more cards than the set has. */
export const deckProgress = (stage: ForgeStage, formats: QuestionFormat[], total: number): ForgeProgress => {
  const cards = formats.slice(0, total);
  return { stage, done: cards.length, total, formats: cards };
};

export function forgeReporter(partyId: string, total: number, publish: Publish) {
  return async (stage: ForgeStage, formats: QuestionFormat[]) => {
    await db.update(parties).set({ forgeProgress: deckProgress(stage, formats, total) }).where(eq(parties.id, partyId));
    await publish({ partyId, status: "questions_progress" });
  };
}

/**
 * record_progress (ADR 0012): after a party has settled, who played whom (played_with), the host's corner
 * progress, and head-to-head rival nudges. Its own job, queued once settlement has committed and never part of it, so a failure here can't
 * hold up or undo a payout; the job retries with backoff. Idempotent via parties.progress_recorded_at, set in
 * the same transaction as what it records.
 */
import { eq } from "drizzle-orm";
import { db } from "./client.js";
import { parties, partyPlayers, users } from "./schema.js";
import { recordPlayedWith } from "./social.js";
import { recordCornerProgress } from "./corners.js";
import { emitHeadToHeadRivals } from "./nudges/emitters.js";

/** Record a finished party's progress once. True when this call recorded it. */
export async function recordPartyProgress(partyId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(parties).where(eq(parties.id, partyId)).for("no key update");
    if (!p || p.status !== "finished" || p.progressRecordedAt) return false;
    const endedAt = p.endedAt ?? new Date();
    const seats = await tx.select({ userId: partyPlayers.userId, isGuest: users.isGuest, bannedAt: users.bannedAt }).from(partyPlayers)
      .innerJoin(users, eq(users.id, partyPlayers.userId)).where(eq(partyPlayers.partyId, partyId));
    await recordPlayedWith(tx, partyId, endedAt);
    await recordCornerProgress(tx, p, seats, endedAt);
    await emitHeadToHeadRivals(tx, partyId);
    await tx.update(parties).set({ progressRecordedAt: new Date() }).where(eq(parties.id, partyId));
    return true;
  });
}

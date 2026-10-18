/**
 * source_sweep (daily): a party's source text lives only as long as it's needed. A retention window
 * after the party finishes or is cancelled (questions config, for disputes and flag review), its file
 * records go, and their chunks with them. Questions keep the id of the chunk they cited; the text is gone.
 */
import { and, inArray, sql } from "drizzle-orm";
import { db, parties, partyFiles, getQuestionsConfig } from "@contestly/db";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Parties that ended before this have had their retention window. */
export const retentionCutoff = (now: Date, retentionDays: number) => new Date(now.getTime() - retentionDays * DAY_MS);

export async function sourceSweep(now = new Date()): Promise<void> {
  const cutoff = retentionCutoff(now, (await getQuestionsConfig()).sourceRetentionDays);
  // Parties that ended before ended_at was recorded count from their start.
  const expired = db.select({ id: parties.id }).from(parties)
    .where(and(inArray(parties.status, ["finished", "cancelled"]), sql`coalesce(${parties.endedAt}, ${parties.startsAt}) < ${cutoff.toISOString()}`));
  const gone = await db.delete(partyFiles).where(inArray(partyFiles.partyId, expired)).returning({ id: partyFiles.id });
  if (gone.length) console.log(`[questions] source sweep: deleted ${gone.length} file(s) and their chunks, ended before ${cutoff.toISOString()}`);
}

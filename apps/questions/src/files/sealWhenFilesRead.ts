/**
 * A sealed party created with `awaitFiles` has no set yet: its questions must come from files the host
 * uploads after creating it. Once every file it has is read, or one couldn't be, build the set. A failed
 * file then fails the set (generateSet's FilesNotReady) with a reason the host can act on, rather than
 * quietly falling back to open knowledge.
 */
import { eq } from "drizzle-orm";
import { db, parties, partyFiles, partyQuestions } from "@contestly/db";

/** Files still on their way: the set waits for them. */
const IN_FLIGHT = new Set(["uploading", "parsing"]);

export async function sealWhenFilesRead(fileId: string, enqueue: (partyId: string) => Promise<unknown>): Promise<void> {
  const [file] = await db.select({ partyId: partyFiles.partyId }).from(partyFiles).where(eq(partyFiles.id, fileId));
  if (!file) return;
  const [party] = await db.select().from(parties).where(eq(parties.id, file.partyId));
  if (!party || party.mode !== "sealed" || party.questionsStatus !== "generating") return;
  if (party.status !== "open" && party.status !== "live") return;
  const files = await db.select({ status: partyFiles.status }).from(partyFiles).where(eq(partyFiles.partyId, party.id));
  if (files.some((f) => IN_FLIGHT.has(f.status))) return;
  const built = await db.select({ id: partyQuestions.id }).from(partyQuestions).where(eq(partyQuestions.partyId, party.id)).limit(1);
  if (built.length) return;
  await enqueue(party.id);
}

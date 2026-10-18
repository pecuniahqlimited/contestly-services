/**
 * A sealed party's question set, from the API's side (ADR 0002). It's generated as soon as the party
 * is created; if that fails the party stays open and joinable, and the host's team can try again,
 * optionally changing the brief, difficulty or formats first. The host never sees the questions.
 */
import { and, eq } from "drizzle-orm";
import { db, parties, partyFiles, isHostTeam, type User } from "@contestly/db";
import { questionsQueue } from "@contestly/queue";
import type { RetryQuestionsInput } from "@contestly/shared";

const questionJobs = questionsQueue();
const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/** Queue a sealed set's generation. A fresh job id per attempt: a failed attempt keeps its id in the queue's history. */
export const enqueueSealedSet = (partyId: string, attempt: "create" | "retry") =>
  questionJobs.add("generate_set", { kind: "generate_set", partyId }, { jobId: attempt === "create" ? `generate-set-${partyId}` : `generate-set-${partyId}-${Date.now()}` });

/**
 * A host who just sent a new file retries straight away, while it's still being read: then the set isn't
 * queued here but by the questions service once the file is read (sealWhenFilesRead). The party row lock
 * makes "still being read?" one answer: embedFile marks the file read under the same lock.
 */
export async function retrySealedSet(partyId: string, user: User, edit: RetryQuestionsInput): Promise<void> {
  const fileStillReading = await db.transaction(async (tx) => {
    const [p] = await tx.select().from(parties).where(eq(parties.id, partyId)).for("update");
    if (!p) throw httpError(404, "not_found");
    if (!isHostTeam(p, user.id)) throw httpError(403, "host_team_only");
    if (p.mode !== "sealed") throw httpError(409, "not_a_sealed_party"); // curate: ask for drafts again
    if (p.status !== "open") throw httpError(409, "party_not_open");
    if (p.questionsStatus !== "failed") throw httpError(409, "questions_not_failed");
    await tx.update(parties).set({
      ...(edit.brief === undefined ? {} : { brief: edit.brief }),
      ...(edit.difficulty === undefined ? {} : { difficulty: edit.difficulty }),
      ...(edit.formats === undefined ? {} : { formats: edit.formats }),
      questionsStatus: "generating",
      questionsError: null,
      forgeProgress: null,
    }).where(eq(parties.id, partyId));
    const reading = await tx.select({ id: partyFiles.id }).from(partyFiles).where(and(eq(partyFiles.partyId, partyId), eq(partyFiles.status, "parsing"))).limit(1);
    return reading.length > 0;
  });
  if (!fileStillReading) await enqueueSealedSet(partyId, "retry");
}

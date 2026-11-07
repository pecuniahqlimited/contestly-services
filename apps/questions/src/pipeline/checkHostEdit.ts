/**
 * The model safety check on a curate host's edit (ADR 0016), and on a host-written question (ADR 0015): the API
 * ran the term filter and queued this; here the edit gets the same model review as a generated draft. A
 * host-written question is about the party's own people, so the reviewer is told so (SafetyBrief.hostWritten),
 * and one that passes is approved, since its author wrote it; one that fails stays a draft. Only the latest edit's check counts (a newer
 * edit carries a new id, and an older job finds its id gone). Fail closed: a check that can't run marks the
 * edit failed with "safety_unavailable", and the host edits again or swaps it.
 */
import { and, eq, sql } from "drizzle-orm";
import { db, parties, partyQuestions } from "@contestly/db";
import { ProviderUnavailable } from "@contestly/ai";
import { parseExclusions, type HostEditCheck, type QuestionFormat } from "@contestly/shared";
import type { Providers } from "../providers/types.js";

export async function checkHostEdit(job: { partyId: string; partyQuestionId: string; checkId: string }, deps: { providers: Providers }): Promise<void> {
  const [q] = await db.select().from(partyQuestions).where(and(eq(partyQuestions.id, job.partyQuestionId), eq(partyQuestions.partyId, job.partyId)));
  const check = q?.editCheck as HostEditCheck | null | undefined;
  if (!q || check?.id !== job.checkId || check.status !== "checking") return; // superseded, or already judged
  const [party] = await db.select({ brief: parties.brief }).from(parties).where(eq(parties.id, job.partyId));
  if (!party) return;

  const brief = { topic: party.brief, exclusions: parseExclusions(party.brief), hostWritten: q.hostWritten };
  let result: { passed: boolean; reasons: string[]; reviewedBy?: string };
  try {
    const [r] = await deps.providers.safety.review(brief, [{ format: q.format as QuestionFormat, payload: q.payload, explanation: q.explanation ?? undefined }]);
    result = r ?? { passed: false, reasons: ["no_verdict"] };
  } catch (err) {
    if (!(err instanceof ProviderUnavailable)) throw err;
    result = { passed: false, reasons: ["safety_unavailable"] };
  }
  const judged: HostEditCheck = {
    id: check.id, status: result.passed ? "passed" : "failed", reasons: result.reasons,
    reviewedBy: result.reviewedBy ?? deps.providers.safety.name, checkedAt: new Date().toISOString(),
  };
  // Only if this is still the latest edit: the host may have edited again while the check ran.
  const approved = q.hostWritten && judged.status === "passed" && q.status === "draft";
  await db.update(partyQuestions).set({ editCheck: judged, ...(approved ? { status: "pending" as const } : {}) })
    .where(and(eq(partyQuestions.id, q.id), sql`${partyQuestions.editCheck}->>'id' = ${check.id}`));
  console.log(`[questions] host edit ${check.id} on party ${job.partyId}: ${judged.status}${judged.reasons.length ? ` (${judged.reasons.join(", ")})` : ""}`);
}

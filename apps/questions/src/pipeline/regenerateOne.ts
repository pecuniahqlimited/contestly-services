/**
 * regenerate_one (curate mode): the host asked for a different question in one slot. Draft a
 * fresh one through the same gate, steering clear of everything already in the party's set,
 * and put it in place as a draft awaiting approval. If nothing passes the gate the slot is left
 * as it was and the job fails (the records still show why).
 */
import { and, eq } from "drizzle-orm";
import { db, parties, partyQuestions, partyQuestionEvents, bankQuestions, questionGenerations, getQuestionsConfig } from "@contestly/db";
import type { Providers } from "../providers/types.js";
import { draftAndJudge } from "./judge.js";
import { bankRow, generationRecord } from "./records.js";
import { retrieveChunks } from "./sources.js";
import { specFor } from "./partySpec.js";
import { questionText } from "./text.js";

export async function regenerateOne(job: { partyId: string; partyQuestionId: string; requestedBy: string }, deps: { providers: Providers }): Promise<void> {
  const [party] = await db.select().from(parties).where(eq(parties.id, job.partyId));
  if (!party || party.mode !== "curate" || party.status !== "open") return;
  const [slot] = await db.select().from(partyQuestions).where(and(eq(partyQuestions.id, job.partyQuestionId), eq(partyQuestions.partyId, job.partyId)));
  if (!slot || slot.status !== "draft") return;

  const cfg = await getQuestionsConfig();
  const spec = await specFor(party);
  const [specEmbedding] = await deps.providers.embedder.embed([`${spec.topic} · ${spec.categoryTag}`]);
  const sources = spec.sourceScope === "open" ? undefined : await retrieveChunks(spec.sourceScope.fileIds, specEmbedding);
  const current = await db.select({ payload: partyQuestions.payload }).from(partyQuestions).where(eq(partyQuestions.partyId, job.partyId));

  const { judged, accepted } = await draftAndJudge({
    spec, providers: deps.providers, dedupeSimilarity: cfg.dedupeSimilarity, want: 1,
    avoid: current.map((q) => questionText(q.payload)), sources,
  });
  const chosen = accepted[0];
  if (!chosen) {
    if (judged.length) await db.insert(questionGenerations).values(judged.map((j) => generationRecord(j, { partyId: party.id, brief: party.brief, spec, banked: false })));
    throw new Error(`regenerate ${job.partyQuestionId}: no draft passed the gate`);
  }

  await db.transaction(async (tx) => {
    await tx.insert(bankQuestions).values(bankRow(chosen, spec));
    await tx.insert(questionGenerations).values(judged.map((j) => generationRecord(j, { partyId: party.id, brief: party.brief, spec, banked: j === chosen })));
    await tx.update(partyQuestions).set({
      format: chosen.draft.format,
      payload: chosen.draft.payload,
      explanation: chosen.draft.explanation ?? null,
      sourceRef: chosen.bankId,
      hostAuthored: false,
      status: "draft",
    }).where(eq(partyQuestions.id, slot.id));
    await tx.insert(partyQuestionEvents).values({ partyId: party.id, questionId: slot.id, kind: "regenerate", userId: job.requestedBy, detail: { replacedBankId: slot.sourceRef, newBankId: chosen.bankId } });
  });
  console.log(`[questions] ${party.title}: regenerated draft #${slot.idx}`);
}

/**
 * The generate_set orchestrator: brief → spec → retrieve → generate → verify → embed → dedupe →
 * difficulty → safety → gate, then one transaction that fills the bank, writes a generation
 * record per draft, writes the set into party_questions (reserves last) and stores the spec
 * summary.
 *
 * Sealed parties generate at start (party is live) and publish questions_ready on party:events
 * when the set is sealed (ADR 0002). Curate parties generate at creation (party is open) and the
 * rows land as drafts for the host's team to review (ADR 0003).
 *
 * Retrieval: open-knowledge parties reuse proven bank questions first and generate only the gap;
 * file-sourced parties generate only from the most relevant chunks of their files.
 *
 * Fail closed: if the gate can't fill count + reserves, the records are still written, then the
 * job throws — BullMQ retries, and the final failure becomes a cancel_generation_failed party
 * job (money only ever moves in the worker).
 */
import { and, eq } from "drizzle-orm";
import { db, parties, partyQuestions, bankQuestions, questionGenerations, getQuestionsConfig, type BankQuestion, type Party } from "@contestly/db";
import type { Providers, SourceChunk } from "../providers/types.js";
import { assertSetFilled } from "./gate.js";
import { draftAndJudge } from "./judge.js";
import { bankRow, generationRecord } from "./records.js";
import { retrieveFromBank } from "./retrieve.js";
import { partyFileIds, retrieveChunks } from "./sources.js";
import { buildSpec } from "./spec.js";
import { questionText } from "./text.js";

export interface GenerateSetDeps {
  providers: Providers;
  publish: (ev: { partyId: string; status: string }) => Promise<unknown>;
}

/** Sealed sets are built once the party is live; curate drafts while it's still open. */
const generatesNow = (p: Party) => (p.mode === "sealed" ? p.status === "live" : p.status === "open");

export async function specFor(party: Party) {
  return buildSpec({ brief: party.brief, difficulty: party.difficulty, formats: party.formats, questionCount: party.questionCount, questionSeconds: party.questionSeconds, fileIds: await partyFileIds(party.id) });
}

export async function generateSet(partyId: string, deps: GenerateSetDeps): Promise<void> {
  const [party] = await db.select().from(parties).where(eq(parties.id, partyId));
  if (!party || !generatesNow(party)) return;

  // Replay (or a room-restart race): the set already exists — just re-announce it.
  const existing = await db.select({ id: partyQuestions.id }).from(partyQuestions)
    .where(and(eq(partyQuestions.partyId, partyId), eq(partyQuestions.reserve, false))).limit(1);
  if (existing.length) {
    if (party.mode === "sealed") await deps.publish({ partyId, status: "questions_ready" });
    return;
  }

  const cfg = await getQuestionsConfig();
  const spec = await specFor(party);
  const need = party.questionCount + cfg.reserveCount;

  const [specEmbedding] = await deps.providers.embedder.embed([`${spec.topic} · ${spec.categoryTag}`]);
  let retrieved: BankQuestion[] = [];
  let sources: SourceChunk[] | undefined;
  if (spec.sourceScope === "open") retrieved = await retrieveFromBank(spec, specEmbedding, need);
  else sources = await retrieveChunks(spec.sourceScope.fileIds, specEmbedding);

  const { judged, accepted } = retrieved.length >= need
    ? { judged: [], accepted: [] }
    : await draftAndJudge({ spec, providers: deps.providers, dedupeSimilarity: cfg.dedupeSimilarity, want: need - retrieved.length, avoid: retrieved.map((q) => questionText(q.payload)), sources });

  const filled = retrieved.length + accepted.length;
  if (filled < need) {
    // Keep the audit trail of the failed attempt (nothing enters the bank or the party set), then fail closed.
    if (judged.length) await db.insert(questionGenerations).values(judged.map((j) => generationRecord(j, { partyId, brief: party.brief, spec, banked: false })));
    assertSetFilled(filled, need);
  }

  // Proven bank questions lead, fresh ones follow, reserves continue the numbering.
  const used = accepted.slice(0, need - retrieved.length);
  const set = [
    ...retrieved.slice(0, need).map((q) => ({ format: q.format, payload: q.payload, explanation: q.explanation, bankId: q.id })),
    ...used.map((j) => ({ format: j.draft.format, payload: j.draft.payload, explanation: j.draft.explanation ?? null, bankId: j.bankId })),
  ];

  await db.transaction(async (tx) => {
    // Every accepted draft enters the bank once the set seals — extras beyond this set included.
    if (accepted.length) await tx.insert(bankQuestions).values(accepted.map((j) => bankRow(j, spec)));
    if (judged.length) await tx.insert(questionGenerations).values(judged.map((j) => generationRecord(j, { partyId, brief: party.brief, spec, banked: true })));
    await tx.insert(partyQuestions).values(set.map((q, i) => ({
      partyId,
      idx: i,
      format: q.format,
      payload: q.payload,
      seconds: party.questionSeconds,
      explanation: q.explanation,
      reserve: i >= party.questionCount,
      sourceRef: q.bankId,
      status: party.mode === "curate" ? ("draft" as const) : ("pending" as const),
    }))).onConflictDoNothing();
    await tx.update(parties).set({ specSummary: spec.summary, category: spec.categoryTag }).where(eq(parties.id, partyId));
  });

  if (party.mode === "sealed") await deps.publish({ partyId, status: "questions_ready" });
  console.log(`[questions] ${party.title}: ${party.mode === "sealed" ? "sealed" : "drafted"} ${party.questionCount}+${need - party.questionCount} reserve (${retrieved.length} from bank, ${used.length} generated${sources ? " from file" : ""}, ${judged.length - accepted.length} rejected)`);
}

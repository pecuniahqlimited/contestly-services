/**
 * The generate_set orchestrator: brief → spec → retrieve → generate → verify → embed → dedupe →
 * difficulty → safety → gate, then one transaction that fills the bank, writes a generation
 * record per draft, seals the set into party_questions (reserves last) and stores the spec
 * summary. After commit it publishes questions_ready on party:events (ADR 0002).
 *
 * Fail closed: if the gate can't fill count + reserves, the records are still written, then the
 * job throws — BullMQ retries, and the final failure becomes a cancel_generation_failed party
 * job (money only ever moves in the worker).
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, parties, partyQuestions, bankQuestions, questionGenerations, getQuestionsConfig, type Party } from "@contestly/db";
import { payloadSchemas } from "@contestly/game";
import type { DraftQuestion, Providers, VerifyVerdict } from "../providers/types.js";
import { nearest, type Neighbour } from "./dedupe.js";
import { estimateDifficulty, type DifficultyEstimate } from "./difficulty.js";
import { assertSetFilled, gateDraft, type GateOutcome } from "./gate.js";
import { nearestInBank, retrieveFromBank } from "./retrieve.js";
import { checkSafety, type SafetyResult } from "./safety.js";
import { buildSpec } from "./spec.js";
import { embeddingText, questionText } from "./text.js";

/** Extra drafts requested beyond the gap, so rejections don't force a second round. */
const QUALITY_BUFFER = 6;
const MAX_DRAFT_ROUNDS = 2;

export interface GenerateSetDeps {
  providers: Providers;
  publish: (ev: { partyId: string; status: string }) => Promise<unknown>;
}

interface JudgedDraft {
  draft: DraftQuestion;
  embedding: number[];
  payloadValid: boolean;
  verify: VerifyVerdict | null;
  nearest: Neighbour | null;
  difficulty: DifficultyEstimate;
  safety: SafetyResult | null;
  outcome: GateOutcome;
}

export async function generateSet(partyId: string, deps: GenerateSetDeps): Promise<void> {
  const [party] = await db.select().from(parties).where(eq(parties.id, partyId));
  if (!party || party.status !== "live") return;

  // Replay (or a room-restart race): the set already exists — just re-announce it.
  const existing = await db.select({ id: partyQuestions.id }).from(partyQuestions)
    .where(and(eq(partyQuestions.partyId, partyId), eq(partyQuestions.reserve, false))).limit(1);
  if (existing.length) {
    await deps.publish({ partyId, status: "questions_ready" });
    return;
  }

  const cfg = await getQuestionsConfig();
  const spec = buildSpec({ brief: party.brief, difficulty: party.difficulty, formats: party.formats, questionCount: party.questionCount, questionSeconds: party.questionSeconds });
  const need = party.questionCount + cfg.reserveCount;

  // Bank first; generation only fills the gap.
  const [specEmbedding] = await deps.providers.embedder.embed([`${spec.topic} · ${spec.categoryTag}`]);
  const retrieved = await retrieveFromBank(spec, specEmbedding, need);

  const judged: JudgedDraft[] = [];
  const accepted: JudgedDraft[] = [];
  const avoid = retrieved.map((q) => questionText(q.payload));

  for (let round = 0; round < MAX_DRAFT_ROUNDS && retrieved.length + accepted.length < need; round++) {
    const gap = need - retrieved.length - accepted.length;
    const drafts = await deps.providers.generator.draft({ spec, count: gap + QUALITY_BUFFER, avoid });
    for (const draft of drafts) {
      avoid.push(questionText(draft.payload));
      judged.push(await judge(draft, { spec, cfg, deps, accepted }));
      const last = judged[judged.length - 1];
      if (last.outcome === "accepted") accepted.push(last);
    }
  }

  const bankRowOf = (j: JudgedDraft) => ({
    id: randomUUID(),
    format: j.draft.format,
    payload: j.draft.payload,
    explanation: j.draft.explanation,
    categoryTag: spec.categoryTag,
    language: spec.language,
    embedding: j.embedding,
    difficulty: j.difficulty.value,
  });
  const newBankRows = accepted.map(bankRowOf);
  const bankIdOf = new Map(accepted.map((j, i) => [j, newBankRows[i].id]));

  const recordRows = judged.map((j) => ({
    partyId,
    bankQuestionId: bankIdOf.get(j) ?? null,
    brief: party.brief,
    spec,
    draft: { format: j.draft.format, payload: j.draft.payload, explanation: j.draft.explanation, claim: j.draft.claim },
    verify: j.verify,
    dedupe: j.nearest,
    difficulty: j.difficulty,
    safety: j.safety,
    outcome: j.outcome,
  }));

  const filled = retrieved.length + accepted.length;
  if (filled < need) {
    // Keep the audit trail of the failed attempt (nothing enters the bank or the party set), then fail closed.
    if (recordRows.length) await db.insert(questionGenerations).values(recordRows.map((r) => ({ ...r, bankQuestionId: null })));
    assertSetFilled(filled, need);
  }

  // The sealed set: proven bank questions lead, fresh ones follow, reserves continue the numbering.
  const set = [
    ...retrieved.map((q) => ({ format: q.format, payload: q.payload, explanation: q.explanation, bankId: q.id })),
    ...accepted.map((j) => ({ format: j.draft.format, payload: j.draft.payload, explanation: j.draft.explanation ?? null, bankId: bankIdOf.get(j)! })),
  ].slice(0, need);

  await db.transaction(async (tx) => {
    if (newBankRows.length) await tx.insert(bankQuestions).values(newBankRows);
    if (recordRows.length) await tx.insert(questionGenerations).values(recordRows);
    await tx.insert(partyQuestions).values(set.map((q, i) => ({
      partyId,
      idx: i,
      format: q.format,
      payload: q.payload,
      seconds: party.questionSeconds,
      explanation: q.explanation,
      reserve: i >= party.questionCount,
      sourceRef: q.bankId,
    }))).onConflictDoNothing();
    await tx.update(parties).set({ specSummary: spec.summary, category: spec.categoryTag }).where(eq(parties.id, partyId));
  });

  await deps.publish({ partyId, status: "questions_ready" });
  console.log(`[questions] ${party.title}: sealed ${party.questionCount}+${need - party.questionCount} reserve (${retrieved.length} from bank, ${accepted.length} generated, ${judged.length - accepted.length} rejected)`);
}

/** Run one draft through verify → embed → dedupe → difficulty → safety, in pipeline order, gating as we go. */
async function judge(
  draft: DraftQuestion,
  ctx: { spec: ReturnType<typeof buildSpec>; cfg: { dedupeSimilarity: number }; deps: GenerateSetDeps; accepted: JudgedDraft[] },
): Promise<JudgedDraft> {
  const { spec, cfg, deps, accepted } = ctx;
  const payloadValid = payloadSchemas[draft.format].safeParse(draft.payload).success;
  const [embedding] = await deps.providers.embedder.embed([embeddingText(draft.format, draft.payload)]);
  const difficulty = estimateDifficulty(spec.difficulty, draft.format);

  // Verification is a separate provider call by design — never the same call as generation.
  const verify = payloadValid ? await deps.providers.verifier.verify({ format: draft.format, payload: draft.payload, explanation: draft.explanation, claim: draft.claim }) : null;

  // Nearest of: the whole bank (any status — retired stays dead) and the batch accepted so far.
  const inBank = await nearestInBank(embedding);
  const inBatch = nearest(embedding, accepted.map((a, i) => ({ id: `draft-${i}`, embedding: a.embedding })));
  const near = [inBank, inBatch].reduce<Neighbour | null>((a, b) => (!a ? b : !b ? a : b.similarity > a.similarity ? b : a), null);

  const safety = checkSafety(spec, draft.payload, draft.explanation);
  const outcome = gateDraft({
    payloadValid,
    verify: verify ?? { verdict: "fail", sources: [], note: "payload failed schema validation" },
    nearest: near,
    dedupeThreshold: cfg.dedupeSimilarity,
    safety,
  });
  return { draft, embedding, payloadValid, verify, nearest: near, difficulty, safety, outcome };
}

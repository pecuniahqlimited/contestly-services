/**
 * Draft and judge: ask the generator for candidates, then run each through verify → embed →
 * dedupe → difficulty → safety → gate, in pipeline order. Shared by generate_set (a whole set)
 * and regenerate_one (one curate-mode replacement). Writes nothing; callers persist.
 */
import { randomUUID } from "node:crypto";
import { checkSafety, type SafetyResult } from "@contestly/shared";
import { payloadSchemas } from "@contestly/game";
import type { DraftQuestion, GenerationSpec, Providers, SourceChunk, VerifyVerdict } from "../providers/types.js";
import { nearest, type Neighbour } from "./dedupe.js";
import { estimateDifficulty, type DifficultyEstimate } from "./difficulty.js";
import { gateDraft, type GateOutcome } from "./gate.js";
import { nearestInBank } from "./retrieve.js";
import { embeddingText, questionText } from "./text.js";

/** Extra drafts requested beyond the gap, so rejections don't force a second round. */
const QUALITY_BUFFER = 6;
const MAX_DRAFT_ROUNDS = 2;

export interface JudgedDraft {
  draft: DraftQuestion;
  embedding: number[];
  verify: VerifyVerdict | null;
  nearest: Neighbour | null;
  difficulty: DifficultyEstimate;
  safety: SafetyResult;
  outcome: GateOutcome;
  /** Pre-assigned so records and party rows can reference the bank row before it's inserted. */
  bankId: string;
}

export interface DraftRequest {
  spec: GenerationSpec;
  providers: Providers;
  dedupeSimilarity: number;
  /** How many accepted drafts are wanted. */
  want: number;
  /** Question texts to steer clear of (retrieved bank questions, the rest of the party's set). */
  avoid: string[];
  /** File-scoped specs only: the chunks to generate from and verify against. */
  sources?: SourceChunk[];
}

export async function draftAndJudge(req: DraftRequest): Promise<{ judged: JudgedDraft[]; accepted: JudgedDraft[] }> {
  const judged: JudgedDraft[] = [];
  const accepted: JudgedDraft[] = [];
  const avoid = [...req.avoid];
  for (let round = 0; round < MAX_DRAFT_ROUNDS && accepted.length < req.want; round++) {
    const drafts = await req.providers.generator.draft({ spec: req.spec, count: req.want - accepted.length + QUALITY_BUFFER, avoid, sources: req.sources });
    for (const draft of drafts) {
      avoid.push(questionText(draft.payload));
      const j = await judge(draft, req, accepted);
      judged.push(j);
      if (j.outcome === "accepted") accepted.push(j);
    }
  }
  return { judged, accepted };
}

async function judge(draft: DraftQuestion, req: DraftRequest, accepted: JudgedDraft[]): Promise<JudgedDraft> {
  const payloadValid = payloadSchemas[draft.format].safeParse(draft.payload).success;
  const [embedding] = await req.providers.embedder.embed([embeddingText(draft.format, draft.payload)]);
  const difficulty = estimateDifficulty(req.spec.difficulty, draft.format);
  const verify = payloadValid ? await verifyDraft(draft, req) : null;

  // Nearest of: the whole bank (any status — retired stays dead) and the batch accepted so far.
  // File-sourced drafts skip the bank: the file is the source, so the same file uploaded again must
  // yield its questions again (and file-derived bank rows are never served to open-knowledge parties).
  const inBank = req.sources ? null : await nearestInBank(embedding);
  const inBatch = nearest(embedding, accepted.map((a) => ({ id: a.bankId, embedding: a.embedding })));
  const near = [inBank, inBatch].reduce<Neighbour | null>((a, b) => (!a ? b : !b ? a : b.similarity > a.similarity ? b : a), null);

  const safety = checkSafety(req.spec, draft.payload, draft.explanation);
  const outcome = gateDraft({
    payloadValid,
    verify: verify ?? { verdict: "fail", sources: [], note: "payload failed schema validation" },
    nearest: near,
    dedupeThreshold: req.dedupeSimilarity,
    safety,
  });
  return { draft, embedding, verify, nearest: near, difficulty, safety, outcome, bankId: randomUUID() };
}

/**
 * Verification is a separate provider call by design — never the same call as generation. A
 * file-scoped draft is checked against the chunk it cites; one that cites nothing (or a chunk
 * outside the party's files) can't be verified and needs a source.
 */
async function verifyDraft(draft: DraftQuestion, req: DraftRequest): Promise<VerifyVerdict> {
  const base = { format: draft.format, payload: draft.payload, explanation: draft.explanation, claim: draft.claim };
  if (!req.sources) return req.providers.verifier.verify(base);
  const chunk = req.sources.find((c) => c.id === draft.sourceChunkId);
  if (!chunk) return { verdict: "needs_source", sources: [], note: "no cited chunk from this party's files" };
  return req.providers.verifier.verify({ ...base, sourceText: chunk.text });
}

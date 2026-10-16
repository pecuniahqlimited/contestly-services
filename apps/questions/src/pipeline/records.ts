/** Row builders for what a judged draft leaves behind: its bank row and its generation record. */
import type { GenerationSpec } from "../providers/types.js";
import type { JudgedDraft } from "./judge.js";

export const bankRow = (j: JudgedDraft, spec: GenerationSpec) => ({
  id: j.bankId,
  format: j.draft.format,
  payload: j.draft.payload,
  explanation: j.draft.explanation,
  categoryTag: spec.categoryTag,
  language: spec.language,
  embedding: j.embedding,
  difficulty: j.difficulty.value,
  sourceChunkId: j.draft.sourceChunkId ?? null,
});

/** `banked`: the draft's bank row is being written alongside this record (only when its set sealed). */
export const generationRecord = (j: JudgedDraft, ctx: { partyId: string; brief: string; spec: GenerationSpec; banked: boolean }) => ({
  partyId: ctx.partyId,
  bankQuestionId: ctx.banked && j.outcome === "accepted" ? j.bankId : null,
  brief: ctx.brief,
  spec: ctx.spec,
  draft: { format: j.draft.format, payload: j.draft.payload, explanation: j.draft.explanation, claim: j.draft.claim, sourceChunkId: j.draft.sourceChunkId },
  verify: j.verify,
  dedupe: j.nearest,
  difficulty: j.difficulty,
  safety: j.safety,
  outcome: j.outcome,
});

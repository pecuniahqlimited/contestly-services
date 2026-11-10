/**
 * Fill `want` questions for a spec: proven bank questions first (open-knowledge specs only,
 * skipping anything excluded), then generation for the gap, then — if still short — the proven
 * originals of drafts that dedupe rejected as rewrites of them. Shared by generate_set (a whole set
 * at creation) and reseal_for_roster (just the few questions a late joiner has already seen).
 * Writes nothing; persistFill() does, inside the caller's transaction.
 */
import { questionGenerations, bankQuestions, getQuestionsConfig, type BankQuestion, type Tx } from "@contestly/db";
import type { ForgeStage, QuestionFormat } from "@contestly/shared";
import type { GenerationSpec, Providers, SourceChunk } from "../providers/types.js";
import { draftAndJudge, type JudgedDraft } from "./judge.js";
import { bankRow, generationRecord } from "./records.js";
import { retrieveFromBank, reusableAmong } from "./retrieve.js";
import { retrieveChunks } from "./sources.js";
import { questionText } from "./text.js";
import { pictureLimit, pictureRoom, withinPictureCap } from "./pictures.js";
import { IMAGE_POOL } from "../providers/imagePool.js";

export interface FillRequest {
  spec: GenerationSpec;
  providers: Providers;
  want: number;
  /** The party's play order (questionCount): the picture cap is a quarter of it, whatever `want` adds for reserves. */
  playSize: number;
  /** Bank questions that must not be used (seen by someone seated, or already in this set). */
  excludeBankIds: string[];
  /** Question texts the generator must steer clear of, for the same reasons. */
  avoidPayloads: unknown[];
  /** Questions already in the party's set that stay (a reseal's kept slots and reserves): they count toward the picture cap. */
  inSet?: { format: string; payload: unknown }[];
  /** Told each stage the fill reaches, with the formats of the questions it has so far (bank picks first). */
  progress?: FillProgress;
}

export type FillProgress = (stage: ForgeStage, formats: QuestionFormat[]) => Promise<unknown>;

export interface Picked {
  format: BankQuestion["format"];
  payload: unknown;
  explanation: string | null;
  bankId: string;
  from: "bank" | "generated";
}

export interface Fill {
  picked: Picked[];
  judged: JudgedDraft[];
  accepted: JudgedDraft[];
  /** Provider steps that couldn't answer during this fill (generation stopped there: bank-only from then on). */
  unavailable: string[];
  retrievedCount: number;
}

export async function fillQuestions(req: FillRequest): Promise<Fill> {
  const cfg = await getQuestionsConfig();
  await req.progress?.("reading", []);
  const [specEmbedding] = await req.providers.embedder.embed([`${req.spec.topic} · ${req.spec.categoryTag}`]);
  let retrieved: BankQuestion[] = [];
  let sources: SourceChunk[] | undefined;
  const model = req.providers.embedder.model;
  if (req.spec.sourceScope === "open") retrieved = await retrieveFromBank(req.spec, specEmbedding, req.want, req.excludeBankIds, model);
  else sources = await retrieveChunks(req.spec.sourceScope.fileIds, specEmbedding, model);

  // The picture cap covers the whole set, reserves included: what stays, what the bank gave, what's generated, then
  // any bank originals reused below.
  const inSet = req.inSet ?? [];
  const limit = pictureLimit(req.playSize, IMAGE_POOL.length);
  retrieved = withinPictureCap(retrieved, pictureRoom(inSet, limit)).kept;

  const gap = req.want - retrieved.length;
  const avoid = [...retrieved.map((q) => questionText(q.payload)), ...req.avoidPayloads.map(questionText)];
  const fromRetrieval = retrieved.map((q) => q.format);
  const { judged, accepted, unavailable } = gap > 0
    ? await draftAndJudge(
      { spec: req.spec, providers: req.providers, dedupeSimilarity: cfg.dedupeSimilarity, want: gap, avoid, sources, pictures: { limit, inSet: [...inSet, ...retrieved] } },
      req.progress && ((stage, formats) => req.progress!(stage, [...fromRetrieval, ...formats])),
    )
    : { judged: [], accepted: [], unavailable: [] };

  const fromBank = (q: BankQuestion): Picked => ({ format: q.format, payload: q.payload, explanation: q.explanation, bankId: q.id, from: "bank" });
  const picked: Picked[] = [
    ...retrieved.map(fromBank),
    ...accepted.slice(0, Math.max(0, gap)).map((j) => ({ format: j.draft.format, payload: j.draft.payload, explanation: j.draft.explanation ?? null, bankId: j.bankId, from: "generated" as const })),
  ];

  // Still short: a draft rejected only for rewriting a proven bank question nobody seated has seen
  // (one retrieval ranked below its cut-off) gets that original instead. Open-knowledge specs only.
  const short = req.want - picked.length;
  if (short > 0 && !sources) {
    const nearIds = [...new Set(judged.filter((j) => j.outcome === "rejected_dedupe" && j.nearest).map((j) => j.nearest!.id))];
    const reused = await reusableAmong(req.spec, nearIds, [...req.excludeBankIds, ...picked.map((p) => p.bankId)]);
    const room = pictureRoom([...inSet, ...picked], limit);
    picked.push(...withinPictureCap(reused, room).kept.slice(0, short).map(fromBank));
  }
  await req.progress?.("balance", picked.map((p) => p.format));
  return { picked, judged, accepted, unavailable, retrievedCount: picked.filter((p) => p.from === "bank").length };
}

/**
 * Write what a fill judged: every accepted draft into the bank (extras included, once the set
 * seals), and a generation record per draft. `banked: false` for an attempt that didn't seal.
 */
export async function persistFill(tx: Tx, fill: Fill, ctx: { partyId: string; brief: string; spec: GenerationSpec; banked: boolean }) {
  if (ctx.banked && fill.accepted.length) await tx.insert(bankQuestions).values(fill.accepted.map((j) => bankRow(j, ctx.spec)));
  if (fill.judged.length) await tx.insert(questionGenerations).values(fill.judged.map((j) => generationRecord(j, ctx)));
}

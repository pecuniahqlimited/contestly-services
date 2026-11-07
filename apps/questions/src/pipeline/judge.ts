/**
 * Draft and judge: ask the generator for candidates, then check each (shape, verify, term filter), then
 * the model safety check on the ones still standing, then dedupe each (embed, nearest, difficulty) and let
 * the gate decide, in pipeline order. Shared by generate_set (a whole set) and regenerate_one (one
 * curate-mode replacement). Writes nothing; callers persist.
 *
 * A provider that can't answer (ProviderUnavailable: down, over budget, circuit open) never fails the job
 * here: generation stops and the caller fills from the bank; a check that can't run fails its drafts closed.
 */
import { randomUUID } from "node:crypto";
import { checkSafety, type QuestionFormat, type SafetyResult } from "@contestly/shared";
import { payloadSchemas } from "@contestly/game";
import { ProviderUnavailable } from "@contestly/ai";
import type { DraftQuestion, GenerationSpec, Providers, SourceChunk, VerifyVerdict } from "../providers/types.js";
import { mapLimit } from "./concurrency.js";
import { nearest, type Neighbour } from "./dedupe.js";
import { estimateDifficulty, type DifficultyEstimate } from "./difficulty.js";
import { gateDraft, type GateOutcome } from "./gate.js";
import { nearestInBank } from "./retrieve.js";
import { embeddingText, questionText } from "./text.js";
import { pictureRoom, withinPictureCap } from "./pictures.js";

/** Extra drafts requested beyond the gap, so rejections don't force a second round. */
const QUALITY_BUFFER = 6;
const MAX_DRAFT_ROUNDS = 2;
/** Verification calls in flight at once (each is a grounded search; the provider rate-limits). */
const VERIFY_CONCURRENCY = 4;

/** The steps that can be unavailable, as recorded on a fill. */
export type UnavailableStep = "generate" | "verify" | "safety";

/** A safety result, saying which checks made it. */
export type SafetyOutcome = SafetyResult & { reviewedBy?: string };

export interface JudgedDraft {
  draft: DraftQuestion;
  embedding: number[];
  embeddingModel: string;
  verify: VerifyVerdict | null;
  nearest: Neighbour | null;
  difficulty: DifficultyEstimate;
  safety: SafetyOutcome;
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
  /** Bank questions not to count as duplicates (the question being re-judged after an edit). */
  excludeBankIds?: string[];
  /** The picture cap for the set (pictures.ts): how many it may hold, and what's in it already. Absent: no cap. */
  pictures?: { limit: number; inSet: { format: string; payload: unknown }[] };
}

/** One question, judged exactly like a fresh draft: shape, verify, safety, then dedupe and the gate. An admin's edit goes through this. */
export async function judgeOne(draft: DraftQuestion, req: Omit<DraftRequest, "want" | "avoid">): Promise<JudgedDraft> {
  const full: DraftRequest = { ...req, want: 1, avoid: [] };
  const checks = new Checks(full);
  const [checked] = await checks.review([await checks.check(draft)]);
  const [embedding] = await embedAll([checked], full);
  return dedupeAndGate(checked, embedding, full, []);
}

/**
 * Where a draft round is, for the Forge: "drafting" while the generator writes, "checking" while each
 * draft is verified and safety-checked, "dedupe" while it's compared against the bank and the batch.
 * `formats` are the drafts accepted so far, in order. Formats only, never content.
 */
export type DraftProgress = (stage: "drafting" | "checking" | "dedupe", acceptedFormats: QuestionFormat[]) => Promise<unknown>;

export async function draftAndJudge(req: DraftRequest, progress?: DraftProgress): Promise<{ judged: JudgedDraft[]; accepted: JudgedDraft[]; unavailable: UnavailableStep[] }> {
  const judged: JudgedDraft[] = [];
  const accepted: JudgedDraft[] = [];
  const avoid = [...req.avoid];
  const checks = new Checks(req);
  const formats = () => accepted.map((a) => a.draft.format);
  for (let round = 0; round < MAX_DRAFT_ROUNDS && accepted.length < req.want && !checks.down.size; round++) {
    // Pictures left in the cap, counting what's been accepted so far; none left means none are asked for.
    const room = req.pictures ? pictureRoom([...req.pictures.inSet, ...accepted.map((a) => a.draft)], req.pictures.limit) : null;
    const spec = room && room.left === 0 ? { ...req.spec, formats: req.spec.formats.filter((f) => f !== "picture") } : req.spec;
    if (!spec.formats.length) break;
    await progress?.("drafting", formats());
    let drafts: DraftQuestion[];
    try {
      drafts = await req.providers.generator.draft({ spec, count: req.want - accepted.length + QUALITY_BUFFER, avoid, sources: req.sources, ...(room ? { maxPerFormat: { picture: room.left } } : {}) });
    } catch (err) {
      if (!(err instanceof ProviderUnavailable)) throw err;
      checks.down.add("generate");
      break;
    }
    // Over the cap or a repeated image: dropped before verification, so nothing is paid for them.
    if (room) drafts = withinPictureCap(drafts, room).kept;
    await progress?.("checking", formats());
    for (const d of drafts) avoid.push(questionText(d.payload));
    const checked = await checks.review(await mapLimit(drafts, VERIFY_CONCURRENCY, (d) => checks.check(d)));
    await progress?.("dedupe", formats());
    const embeddings = await embedAll(checked, req);
    for (const [i, c] of checked.entries()) {
      const j = await dedupeAndGate(c, embeddings[i], req, accepted);
      judged.push(j);
      if (j.outcome !== "accepted") continue;
      accepted.push(j);
      await progress?.("dedupe", formats());
    }
  }
  return { judged, accepted, unavailable: [...checks.down] };
}

/** A draft after the checking pass: shape, the independent fact-check and the safety checks. */
interface Checked {
  draft: DraftQuestion;
  payloadValid: boolean;
  verify: VerifyVerdict | null;
  safety: SafetyOutcome;
}

/** The checking pass for one request; remembers which providers went down so it stops calling them. */
class Checks {
  readonly down = new Set<UnavailableStep>();
  constructor(private readonly req: DraftRequest) {}

  async check(draft: DraftQuestion): Promise<Checked> {
    const payloadValid = payloadSchemas[draft.format].safeParse(draft.payload).success;
    const verify = payloadValid ? await this.verify(draft) : null;
    return { draft, payloadValid, verify, safety: { ...checkSafety(this.req.spec, draft.payload, draft.explanation), reviewedBy: "terms" } };
  }

  /**
   * The model safety check, one batch for every draft still standing (valid, verified correct, through the
   * term filter): the others are already rejected, so they aren't paid for. Fails closed.
   */
  async review(checked: Checked[]): Promise<Checked[]> {
    const standing = checked.filter((c) => c.payloadValid && c.verify?.verdict === "correct" && c.safety.passed);
    if (!standing.length) return checked;
    let results: SafetyOutcome[];
    if (this.down.has("safety")) results = standing.map(() => unavailableSafety);
    else {
      try {
        results = await this.req.providers.safety.review(this.req.spec, standing.map((c) => ({ format: c.draft.format, payload: c.draft.payload, explanation: c.draft.explanation })));
      } catch (err) {
        if (!(err instanceof ProviderUnavailable)) throw err;
        this.down.add("safety");
        results = standing.map(() => unavailableSafety);
      }
    }
    const reviewer = this.req.providers.safety.name;
    standing.forEach((c, i) => {
      const r: SafetyOutcome = results[i] ?? { passed: false, reasons: ["no_verdict"] };
      c.safety = { passed: r.passed, reasons: r.reasons, reviewedBy: `terms+${r.reviewedBy ?? reviewer}` };
    });
    return checked;
  }

  /**
   * Verification is a separate provider call by design — never the same call as generation. A
   * file-scoped draft is checked against the chunk it cites; one that cites nothing (or a chunk
   * outside the party's files) can't be verified.
   */
  private async verify(draft: DraftQuestion): Promise<VerifyVerdict> {
    if (this.down.has("verify")) return { verdict: "unverifiable", sources: [], note: "verifier unavailable" };
    const base = { format: draft.format, payload: draft.payload, explanation: draft.explanation, claim: draft.claim };
    let input = base as Parameters<Providers["verifier"]["verify"]>[0];
    if (this.req.sources) {
      const chunk = this.req.sources.find((c) => c.id === draft.sourceChunkId);
      if (!chunk) return { verdict: "unverifiable", sources: [], note: "no cited chunk from this party's files" };
      input = { ...base, sourceText: chunk.text, sourceChunkId: chunk.id };
    }
    try {
      return await this.req.providers.verifier.verify(input);
    } catch (err) {
      if (!(err instanceof ProviderUnavailable)) throw err;
      this.down.add("verify");
      return { verdict: "unverifiable", sources: [], note: `verifier unavailable (${err.kind})` };
    }
  }
}

const unavailableSafety: SafetyResult = { passed: false, reasons: ["safety_unavailable"] };

/** One embedding call for a round's drafts. */
const embedAll = (checked: Checked[], req: DraftRequest) =>
  checked.length ? req.providers.embedder.embed(checked.map((c) => embeddingText(c.draft.format, c.draft.payload))) : Promise.resolve([]);

/** The dedupe pass: find the nearest question, estimate difficulty, then the gate decides. */
async function dedupeAndGate({ draft, payloadValid, verify, safety }: Checked, embedding: number[], req: DraftRequest, accepted: JudgedDraft[]): Promise<JudgedDraft> {
  const embedder = req.providers.embedder;
  const difficulty = estimateDifficulty(req.spec.difficulty, draft.format);

  // Nearest of: the whole bank (any status — retired stays dead) and the batch accepted so far.
  // File-sourced drafts skip the bank: the file is the source, so the same file uploaded again must
  // yield its questions again (and file-derived bank rows are never served to open-knowledge parties).
  const inBank = req.sources ? null : await nearestInBank(embedding, req.excludeBankIds ?? [], embedder.model);
  const inBatch = nearest(embedding, accepted.map((a) => ({ id: a.bankId, embedding: a.embedding })));
  const near = [inBank, inBatch].reduce<Neighbour | null>((a, b) => (!a ? b : !b ? a : b.similarity > a.similarity ? b : a), null);

  const outcome = gateDraft({
    payloadValid,
    verify: verify ?? { verdict: "incorrect", sources: [], note: "payload failed schema validation" },
    nearest: near,
    dedupeThreshold: req.dedupeSimilarity,
    safety,
  });
  return { draft, embedding, embeddingModel: embedder.model, verify, nearest: near, difficulty, safety, outcome, bankId: randomUUID() };
}

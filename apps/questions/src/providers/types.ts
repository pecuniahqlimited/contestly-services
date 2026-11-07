/**
 * The provider seams of the question engine, chosen together by AI_PROFILE (mock, free or paid; ADR 0016). Vendor-neutral by construction: plain structured input and
 * output, no provider SDK types. A real provider is a new folder in providers/ plus a registry entry and an
 * env change. A provider that can't answer now throws ProviderUnavailable (@contestly/ai); the pipeline
 * falls back to the bank (generation) or fails the draft closed (checks).
 *
 * Generation and verification are separate interfaces so they can never be the same call.
 */
import type { Difficulty, QuestionFormat, SafetyBrief, SafetyResult, VerifyVerdictKind } from "@contestly/shared";

/** Open knowledge, or "only from these uploaded files" (questions must be answerable from them). */
export type SourceScope = "open" | { kind: "file"; fileIds: string[] };

/** A chunk of an uploaded source file, handed to the generator and cited back by each draft. */
export interface SourceChunk {
  id: string;
  text: string;
}

/** What we understood from the host's brief — the contract every pipeline step works from. */
export interface GenerationSpec {
  topic: string;
  /** Derived category tag for discovery and recommendations (never host-picked). */
  categoryTag: string;
  audience?: string;
  tone?: string;
  difficulty: Difficulty;
  secondsPerQuestion: number;
  formats: QuestionFormat[];
  /** Things the brief ruled out ("nothing about politics"). */
  exclusions: string[];
  language: string;
  sourceScope: SourceScope;
  /** The one-line "what we understood", shown back to the host and stored on the party. */
  summary: string;
}

export interface DraftQuestion {
  format: QuestionFormat;
  /** Full server payload including correct answers; validated against packages/game payloadSchemas. */
  payload: unknown;
  explanation?: string;
  /** The factual claim in plain text — what the verifier checks against sources. */
  claim: string;
  /** File-sourced drafts cite the chunk they were generated from. */
  sourceChunkId?: string;
  /** Which provider and model wrote it, for the generation record. */
  generatedBy?: { provider: string; model: string };
}

export interface Generator {
  /**
   * Draft `count` candidate questions for the spec, steering clear of the `avoid` texts. With
   * `sources` (a file-scoped spec), every draft must be answerable from one chunk and cite it.
   * `maxPerFormat` caps a format's share (picture rounds, ADR 0016); the rest goes to the other formats.
   */
  draft(input: { spec: GenerationSpec; count: number; avoid: string[]; sources?: SourceChunk[]; maxPerFormat?: Partial<Record<QuestionFormat, number>> }): Promise<DraftQuestion[]>;
}

export interface VerifyVerdict {
  /**
   * correct: the stated answer is right and the only right one. incorrect: it's wrong, or another option is
   * right. ambiguous: more than one defensible answer, an unclear question, or a fact that changes.
   * unverifiable: no reliable source found. Only "correct" passes the gate, in both modes.
   */
  verdict: VerifyVerdictKind;
  /** The answer the verifier found, in its own words. */
  foundAnswer?: string;
  /** URLs backing the verdict (grounding results); the cited chunk on a file-sourced check. */
  sources: string[];
  /** The same sources with their titles, when the provider gives them. */
  citations?: { url: string; title?: string }[];
  note?: string;
  /** Which provider and model judged it, and whether the result came from the cache. */
  verifiedBy?: { provider: string; model: string; cached?: boolean };
  /**
   * Checked from the model's knowledge with no sources (the free profile, ADR 0016): recorded as "checked
   * without sources", and accepted at the gate only when the providers allow it (Providers.allowUnsourced).
   */
  unsourced?: boolean;
}

export interface VerifyInput {
  format: QuestionFormat;
  payload: unknown;
  explanation?: string;
  claim: string;
  /** File-sourced drafts: the claim must be supported by this text, not by open knowledge. */
  sourceText?: string;
  sourceChunkId?: string;
}

export interface Verifier {
  /** A name for the cache key and logs ("mock", "anthropic", "gemini"). */
  readonly name: string;
  verify(q: VerifyInput): Promise<VerifyVerdict>;
}

export interface Embedder {
  /** The model behind the vectors, stored with each one: vectors from different models are never compared. */
  readonly model: string;
  /** One unit-normalised vector of EMBEDDING_DIM numbers per input text. */
  embed(texts: string[]): Promise<number[][]>;
}

/** The model-based safety and taste check, run after the term filter on drafts that passed it (step 7). */
export interface SafetyReviewer {
  readonly name: string;
  /** One result per item, in order, with the model that judged it. Fails closed: anything it can't judge comes back not passed, with the reason. */
  review(brief: SafetyBrief, items: { format: QuestionFormat; payload: unknown; explanation?: string }[]): Promise<(SafetyResult & { reviewedBy?: string })[]>;
}

export interface Providers {
  generator: Generator;
  verifier: Verifier;
  embedder: Embedder;
  safety: SafetyReviewer;
  /** The free profile only: a "correct" checked without sources passes the gate. */
  allowUnsourced?: boolean;
}

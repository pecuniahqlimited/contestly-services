/**
 * The three provider seams of the question engine, each chosen by env (QUESTIONS_GENERATOR,
 * QUESTIONS_VERIFIER, QUESTIONS_EMBEDDER). Vendor-neutral by construction: plain structured
 * input and output, no provider SDK types. A real provider is a new file in providers/ plus a
 * registry entry and an env change — nothing else.
 *
 * Generation and verification are separate interfaces so they can never be the same call.
 */
import type { Difficulty, QuestionFormat } from "@contestly/shared";

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
}

export interface Generator {
  /**
   * Draft `count` candidate questions for the spec, steering clear of the `avoid` texts. With
   * `sources` (a file-scoped spec), every draft must be answerable from one chunk and cite it.
   */
  draft(input: { spec: GenerationSpec; count: number; avoid: string[]; sources?: SourceChunk[] }): Promise<DraftQuestion[]>;
}

export interface VerifyVerdict {
  /** "needs_source": the claim couldn't be verified — the question can't be approved without a host edit (2b). */
  verdict: "pass" | "fail" | "needs_source";
  /** Citations backing the verdict: at least two on an open-knowledge pass; the cited chunk on a file-sourced pass. */
  sources: string[];
  note?: string;
}

export interface Verifier {
  /** With `sourceText` (file-sourced drafts), the claim must be supported by that text, not by open knowledge. */
  verify(q: { format: QuestionFormat; payload: unknown; explanation?: string; claim: string; sourceText?: string }): Promise<VerifyVerdict>;
}

export interface Embedder {
  /** One unit-normalised vector of EMBEDDING_DIM numbers per input text. */
  embed(texts: string[]): Promise<number[][]>;
}

export interface Providers {
  generator: Generator;
  verifier: Verifier;
  embedder: Embedder;
}

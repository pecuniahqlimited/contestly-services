/**
 * The three provider seams of the question engine, each chosen by env (QUESTIONS_GENERATOR,
 * QUESTIONS_VERIFIER, QUESTIONS_EMBEDDER). Vendor-neutral by construction: plain structured
 * input and output, no provider SDK types. A real provider is a new file in providers/ plus a
 * registry entry and an env change — nothing else.
 *
 * Generation and verification are separate interfaces so they can never be the same call.
 */
import type { Difficulty, QuestionFormat } from "@contestly/shared";

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
  /** Open knowledge in 2a; step 2b adds "only from this file". */
  sourceScope: "open";
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
}

export interface Generator {
  /** Draft `count` candidate questions for the spec, steering clear of the `avoid` texts (already-retrieved bank questions). */
  draft(input: { spec: GenerationSpec; count: number; avoid: string[] }): Promise<DraftQuestion[]>;
}

export interface VerifyVerdict {
  /** "needs_source": the claim couldn't be verified — the question can't be approved without a host edit (2b). */
  verdict: "pass" | "fail" | "needs_source";
  /** Citations backing the verdict; at least two on a pass. */
  sources: string[];
  note?: string;
}

export interface Verifier {
  verify(q: { format: QuestionFormat; payload: unknown; explanation?: string; claim: string }): Promise<VerifyVerdict>;
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

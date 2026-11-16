/**
 * Input → spec: turn the host's brief and party settings into the structured GenerationSpec
 * every later step works from, including the one-line "what we understood" that is stored on
 * the party and shown back to the host. Pure.
 */
import { briefPeriod, inferCategory, isRecentPeriod, parseExclusions, type Difficulty, type QuestionFormat, type ThemedSpec } from "@contestly/shared";
import type { GenerationSpec, SourceScope, SpecPeriod } from "../providers/types.js";

export interface SpecInput {
  brief: string;
  difficulty: Difficulty;
  formats: QuestionFormat[];
  questionCount: number;
  questionSeconds: number;
  /** Parsed source files attached to the party; none means open knowledge. */
  fileIds?: string[];
  /** A template party's themed spec (ADR 0015): who it's for, the tone, and what the themed questions stay away from. */
  themed?: ThemedSpec;
  /** Today, for "this year" and what counts as recent. */
  now?: Date;
}

const label: Record<Difficulty, string> = { easy: "Easy", mixed: "Mixed-difficulty", hard: "Hard", brutal: "Brutal" };

export function buildSpec(input: SpecInput): GenerationSpec {
  const topic = input.brief.replace(/\s+/g, " ").trim();
  const categoryTag = inferCategory(topic);
  const exclusions = [...new Set([...parseExclusions(topic), ...(input.themed?.exclusions ?? []).map((e) => e.toLowerCase())])];
  const shortTopic = topic.length > 80 ? `${topic.slice(0, 77)}…` : topic;
  const sourceScope: SourceScope = input.fileIds?.length ? { kind: "file", fileIds: input.fileIds } : "open";
  // A file's own dates are the file's business: the period only steers open-knowledge sets.
  const period = sourceScope === "open" ? periodOf(topic, input.now ?? new Date()) : undefined;
  const summary =
    `${label[input.difficulty]} ${categoryTag} — ${shortTopic} · ` +
    `${input.questionCount} questions · ${input.formats.length} format${input.formats.length === 1 ? "" : "s"} · ${input.questionSeconds}s each` +
    (sourceScope === "open" ? "" : ` · only from your file${input.fileIds!.length === 1 ? "" : "s"}`) +
    (period ? (period.use === "only" ? ` · ${period.label} only` : ` · its history, not ${period.label}`) : "") +
    (exclusions.length ? ` · skipping ${exclusions.join(", ")}` : "");
  return {
    topic,
    categoryTag,
    ...(input.themed?.audience ? { audience: input.themed.audience } : {}),
    ...(input.themed?.tone ? { tone: input.themed.tone } : {}),
    difficulty: input.difficulty,
    secondsPerQuestion: input.questionSeconds,
    formats: input.formats,
    exclusions,
    language: "en",
    sourceScope,
    summary,
    ...(period ? { period } : {}),
  };
}

/**
 * The brief's period and how the set treats it: inside it, or, when it's too recent, the topic's history. History is
 * the only choice a host can make for a recent period today (the API refuses the brief without it), so it needs
 * no lookup; parties.recent_period records that they made it.
 */
function periodOf(topic: string, now: Date): SpecPeriod | undefined {
  const p = briefPeriod(topic, now);
  if (!p) return undefined;
  return { ...p, use: isRecentPeriod(p, now) ? "history" : "only" };
}

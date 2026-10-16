/**
 * Input → spec: turn the host's brief and party settings into the structured GenerationSpec
 * every later step works from, including the one-line "what we understood" that is stored on
 * the party and shown back to the host. Pure.
 */
import { inferCategory, type Difficulty, type QuestionFormat } from "@contestly/shared";
import type { GenerationSpec } from "../providers/types.js";

export interface SpecInput {
  brief: string;
  difficulty: Difficulty;
  formats: QuestionFormat[];
  questionCount: number;
  questionSeconds: number;
}

/** "nothing about politics", "no questions about X", "avoid X" → ["politics", "x"]. */
export function parseExclusions(brief: string): string[] {
  const out: string[] = [];
  for (const m of brief.matchAll(/\b(?:no(?:thing)?(?: questions)? about|avoid|skip|without)\s+([a-z0-9' -]+?)(?=[.,;!\n]|$)/gi)) {
    out.push(m[1].trim().toLowerCase());
  }
  return [...new Set(out)];
}

const label: Record<Difficulty, string> = { easy: "Easy", mixed: "Mixed-difficulty", hard: "Hard", brutal: "Brutal" };

export function buildSpec(input: SpecInput): GenerationSpec {
  const topic = input.brief.replace(/\s+/g, " ").trim();
  const categoryTag = inferCategory(topic);
  const exclusions = parseExclusions(topic);
  const shortTopic = topic.length > 80 ? `${topic.slice(0, 77)}…` : topic;
  const summary =
    `${label[input.difficulty]} ${categoryTag} — ${shortTopic} · ` +
    `${input.questionCount} questions · ${input.formats.length} format${input.formats.length === 1 ? "" : "s"} · ${input.questionSeconds}s each` +
    (exclusions.length ? ` · skipping ${exclusions.join(", ")}` : "");
  return {
    topic,
    categoryTag,
    difficulty: input.difficulty,
    secondsPerQuestion: input.questionSeconds,
    formats: input.formats,
    exclusions,
    language: "en",
    sourceScope: "open",
    summary,
  };
}

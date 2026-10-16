/** The text a question is embedded and deduped by: its question plus every player-visible option. */
import type { QuestionFormat } from "@contestly/shared";

export function embeddingText(format: QuestionFormat, payload: unknown): string {
  const p = payload as Record<string, unknown>;
  const parts: unknown[] = [p.question];
  for (const key of ["options", "items", "left", "right"]) {
    const v = p[key];
    if (Array.isArray(v)) parts.push(...v);
  }
  return parts.filter((x) => typeof x === "string").join(" · ");
}

export function questionText(payload: unknown): string {
  const q = (payload as { question?: unknown })?.question;
  return typeof q === "string" ? q : "";
}

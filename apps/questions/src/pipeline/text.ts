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

/**
 * A question with its answer key spelled out, for checkers and the eval report: the options, which are
 * stated to be right, and what a picture shows. Format-aware, no letters the player would never see.
 */
export function answerKeyText(format: QuestionFormat, payload: unknown): string {
  const p = payload as Record<string, unknown>;
  const list = (xs: unknown) => (Array.isArray(xs) ? (xs as string[]) : []);
  const lines = [`Question: ${String(p.question ?? "")}`];
  switch (format) {
    case "picture":
      lines.push(`The player sees a picture. Alt text: ${String(p.imageAlt ?? "")}`);
    // falls through: a picture round is a pick-one about the picture
    case "pick_one": {
      const options = list(p.options);
      lines.push(`Options: ${options.join(" | ")}`, `Stated correct answer: ${options[p.correctIndex as number] ?? "?"}`);
      break;
    }
    case "pick_all": {
      const options = list(p.options);
      const right = new Set(list(p.correctIndexes) as unknown as number[]);
      lines.push(`Options: ${options.join(" | ")}`, `Stated correct options: ${options.filter((_, i) => right.has(i)).join(" | ")}`, `Stated wrong options: ${options.filter((_, i) => !right.has(i)).join(" | ")}`);
      break;
    }
    case "order": {
      const items = list(p.items);
      lines.push(`Items: ${items.join(" | ")}`, `Stated correct order: ${(list(p.correctOrder) as unknown as number[]).map((i) => items[i]).join(" → ")}`);
      break;
    }
    case "match": {
      const left = list(p.left);
      const right = list(p.right);
      const pairs = list(p.pairs) as unknown as number[];
      lines.push(`Left: ${left.join(" | ")}`, `Right: ${right.join(" | ")}`, `Stated correct pairs: ${left.map((l, i) => `${l} → ${right[pairs[i]] ?? "?"}`).join("; ")}`);
      break;
    }
  }
  return lines.join("\n");
}

/**
 * The mock generator's file mode: deterministic fill-the-gap questions built from sentences in the
 * uploaded file's chunks. The answer is a name or number taken out of the sentence; distractors are
 * other names/numbers of the same kind from the same file, so every question is answerable only
 * from the file and cites the chunk it came from. pick_one only.
 */
import type { DraftQuestion, SourceChunk } from "../types.js";

const MIN_SENTENCE = 30;
const MAX_SENTENCE = 220;
const GAP = "____";

type Kind = "number" | "name";
const kindOf = (token: string): Kind => (/^\d/.test(token) ? "number" : "name");

/** Names (capitalised words not opening the sentence) and 2–4 digit numbers. */
function candidates(sentence: string): string[] {
  const words = [...sentence.matchAll(/\b(\d{2,4}|[A-Z][a-z]{2,})\b/g)];
  return words.filter((m) => m.index !== 0).map((m) => m[1]);
}

function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_SENTENCE && s.length <= MAX_SENTENCE);
}

export function draftsFromFile(sources: SourceChunk[], count: number, avoidTexts: Set<string>): DraftQuestion[] {
  const avoid = new Set(avoidTexts); // chunks overlap, so the same sentence can come round twice
  const pool: Record<Kind, string[]> = { number: [], name: [] };
  for (const chunk of sources) for (const s of sentences(chunk.text)) for (const c of candidates(s)) pool[kindOf(c)].push(c);
  for (const k of Object.keys(pool) as Kind[]) pool[k] = [...new Set(pool[k])].sort();

  const drafts: DraftQuestion[] = [];
  for (const chunk of sources) {
    for (const sentence of sentences(chunk.text)) {
      if (drafts.length >= count) return drafts;
      const cands = candidates(sentence);
      const answer = cands[cands.length - 1];
      if (!answer) continue;
      const others = pool[kindOf(answer)].filter((t) => t !== answer && !sentence.includes(t));
      const start = others.length ? (drafts.length * 3) % others.length : 0; // rotate so questions don't share one distractor set
      const distractors = [...others.slice(start), ...others.slice(0, start)].slice(0, 3);
      if (distractors.length < 3) continue;
      const question = `Fill the gap, from the file: "${sentence.split(answer).join(GAP)}"`;
      if (avoid.has(question)) continue;
      const correctIndex = drafts.length % 4;
      const options = [...distractors];
      options.splice(correctIndex, 0, answer);
      avoid.add(question);
      drafts.push({ format: "pick_one", payload: { question, options, correctIndex }, claim: sentence, sourceChunkId: chunk.id });
    }
  }
  return drafts;
}

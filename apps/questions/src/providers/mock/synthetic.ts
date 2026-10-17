/**
 * The mock generator's unbounded tail: when the fixture deck has nothing left that isn't being
 * avoided (the same players have played it all), it makes numbered "which word is longest"
 * questions. Deterministic, self-verifying, and worded differently enough that dedupe treats
 * them as distinct facts. pick_one only.
 */
import type { DraftQuestion } from "../types.js";

const WORDS = [
  "Lagos", "Kano", "Ibadan", "Enugu", "Jos", "Calabar", "Owerri", "Abeokuta", "Sokoto", "Maiduguri", "Yola", "Makurdi",
  "Asaba", "Benin", "Warri", "Ilorin", "Osogbo", "Akure", "Uyo", "Lokoja", "Minna", "Bauchi", "Gombe", "Jalingo",
  "Lafia", "Dutse", "Katsina", "Zaria", "Onitsha", "Aba", "Nnewi", "Ogbomosho", "jollof", "suya", "akara", "moimoi",
  "egusi", "ogbono", "amala", "eba", "fufu", "puffpuff", "chinchin", "zobo", "kunu", "garri", "dodo", "ofada",
  "nkwobi", "isiewu", "edikaikong", "afang", "banga", "tuwo", "masa", "kilishi", "boli", "ewa", "agoyin", "abacha",
  "okpa", "ukwa", "fura", "dambu",
];

/** Four distinct words for question n, or null when they collide or the longest isn't unique. */
function wordsFor(n: number): string[] | null {
  const picks = [n, n * 5 + 1, n * 11 + 2, n * 17 + 3].map((i) => WORDS[i % WORDS.length]);
  if (new Set(picks).size < 4) return null;
  const longest = Math.max(...picks.map((w) => w.length));
  return picks.filter((w) => w.length === longest).length === 1 ? picks : null;
}

export function syntheticDrafts(count: number, avoid: Set<string>): DraftQuestion[] {
  const out: DraftQuestion[] = [];
  for (let n = 1; out.length < count && n < 100_000; n++) {
    const words = wordsFor(n);
    if (!words) continue;
    const question = `Mock round ${n}: which of ${words.join(", ")} is spelt with the most letters?`;
    if (avoid.has(question)) continue;
    const longest = words.reduce((a, b) => (b.length > a.length ? b : a));
    out.push({
      format: "pick_one",
      payload: { question, options: words, correctIndex: words.indexOf(longest) },
      claim: `${longest} has more letters than ${words.filter((w) => w !== longest).join(", ")}.`,
    });
  }
  return out;
}

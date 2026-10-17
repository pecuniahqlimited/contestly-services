/**
 * The mock generator's unbounded tail: when the fixture deck has nothing left that isn't being
 * avoided (the same players have played it all), it makes numbered "which word is longest"
 * questions. Deterministic, self-verifying, and worded differently enough that dedupe treats
 * them as distinct facts. pick_one only.
 */
import { createHash } from "node:crypto";
import type { DraftQuestion } from "../types.js";

/** ~200 words, so two questions rarely share three of their four options (which dedupe would catch). */
const WORDS = [
  // cities and towns
  "Lagos", "Kano", "Ibadan", "Enugu", "Jos", "Calabar", "Owerri", "Abeokuta", "Sokoto", "Maiduguri", "Yola", "Makurdi",
  "Asaba", "Benin", "Warri", "Ilorin", "Osogbo", "Akure", "Uyo", "Lokoja", "Minna", "Bauchi", "Gombe", "Jalingo",
  "Lafia", "Dutse", "Katsina", "Zaria", "Onitsha", "Aba", "Nnewi", "Ogbomosho", "Badagry", "Epe", "Ikorodu", "Sagamu",
  "Ijebu", "Ondo", "Ado", "Oyo", "Iseyin", "Offa", "Bida", "Kafanchan", "Keffi", "Suleja", "Gusau", "Birnin",
  "Kontagora", "Potiskum", "Nguru", "Mubi", "Wukari", "Otukpo", "Nsukka", "Awka", "Umuahia", "Abakaliki", "Ikom", "Eket",
  "Opobo", "Bonny", "Brass", "Sapele", "Ughelli", "Auchi", "Ekpoma", "Okene", "Idah", "Ankpa",
  // food and drink
  "jollof", "suya", "akara", "moimoi", "egusi", "ogbono", "amala", "eba", "fufu", "puffpuff", "chinchin", "zobo",
  "kunu", "garri", "dodo", "ofada", "nkwobi", "isiewu", "edikaikong", "afang", "banga", "tuwo", "masa", "kilishi",
  "boli", "ewa", "agoyin", "abacha", "okpa", "ukwa", "fura", "dambu", "gbegiri", "ewedu", "efo", "ikokore",
  "ekuru", "ofe", "oha", "onugbu", "nsala", "kpomo", "asun", "peppersoup", "ugba", "achicha", "kosai", "waina",
  "dankwa", "gurundi", "kokoro", "ipekere", "adalu", "ojojo", "ekpang", "otong", "atama", "fisherman",
  // names
  "Adaeze", "Babatunde", "Chiamaka", "Danjuma", "Ebuka", "Folake", "Garba", "Halima", "Ifeoma", "Jide", "Kelechi", "Lami",
  "Maryam", "Nkechi", "Obinna", "Patience", "Rukayat", "Segun", "Temitope", "Uche", "Victor", "Wale", "Yetunde", "Zainab",
  "Abubakar", "Bisola", "Chidi", "Dayo", "Emeka", "Funmi", "Gbenga", "Hauwa", "Ikenna", "Jumoke", "Kunle", "Lola",
  "Musa", "Ngozi", "Ola", "Precious", "Remi", "Sade", "Tobi", "Ugochi", "Yusuf", "Amaka", "Bolaji", "Chinedu",
  // things
  "danfo", "okada", "keke", "agbada", "buba", "gele", "aso", "ankara", "kaftan", "fila", "talking drum", "shekere",
  "udu", "ogene", "kakaki", "highlife", "juju", "fuji", "apala", "afrobeat", "harmattan", "mangrove", "baobab", "iroko",
];

/** A well-mixed 32-bit hash (FNV-1a's low bits barely change when inputs differ by one character). */
const hash = (s: string): number => createHash("sha256").update(s).digest().readUInt32BE(0);

/**
 * Four distinct words for question n, or null when they collide or the longest isn't unique.
 * Hashed picks, not arithmetic ones: no period, so question n + 64 isn't question n reworded.
 */
function wordsFor(n: number): string[] | null {
  const picks = [0, 1, 2, 3].map((k) => WORDS[hash(`${n}:${k}`) % WORDS.length]);
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

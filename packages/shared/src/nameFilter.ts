/**
 * The name filter (ADR 0014): what people name things (handles, display names, bios, party titles, corner names
 * and bios, crew names). Slurs are refused; milder words are masked, except in a handle, which can't carry a mask
 * and is refused instead. One copy, used by the API wherever a name is set. Chat masks with maskProfanity (chat.ts),
 * which shares the mild list below.
 *
 * The built-in lists are small and conservative on purpose: English slurs, and Nigerian Pidgin, Yoruba, Igbo and
 * Hausa terms we're confident are used as slurs or insults. Words that are also common surnames or everyday words
 * (gambari, aboki, ode, ewu) are left out so real names aren't refused. Ops add terms without a release through
 * app_config "safety" (blockedTerms, maskedTerms); the lists need a native-speaker review before launch.
 */
import { PROFANITY } from "./safety.js";

export const NAME_FIELDS = ["handle", "displayName", "bio", "partyTitle", "cornerName", "cornerBio", "crewName"] as const;
export type NameField = (typeof NAME_FIELDS)[number];

/** Refused wherever they appear. */
export const BLOCKED_NAME_TERMS: readonly string[] = [
  // English slurs
  "nigger", "nigga", "faggot", "retard", "kike", "chink", "spic", "tranny", "wetback",
  // hate phrases (the question filter's list)
  "kill all", "subhuman",
  // Nigerian: ethnic slurs (Igbo, Yoruba) and strong insults (Pidgin, Yoruba, Hausa)
  "nyamiri", "ofe mmanu", "ofemmanu", "ashawo", "ashewo", "omo ale", "shege", "dan iska",
];

/** Masked in display names, titles and bios (refused in handles). */
export const MASKED_NAME_TERMS: readonly string[] = [
  ...PROFANITY,
  // Nigerian: milder insults (Pidgin, Yoruba, Igbo)
  "mumu", "olodo", "werey", "oloshi", "onye ara",
];

/** Blocked terms this long or longer are refused inside a handle too ("xnyamirix"): shorter ones would catch real names. */
const SUBSTRING_MIN = 5;

export interface NameTerms { blockedTerms: readonly string[]; maskedTerms: readonly string[] }
export type NameCheck = { ok: true; text: string } | { ok: false; term: string };

/** Look-alikes people use to slip a word past a filter. */
const LOOKALIKE: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s", "!": "i" };
/** Separators a handle uses instead of spaces. */
const SEPARATOR = /[_.\-]/;

/**
 * One character in, one character out, so a match's position in the folded text is its position in the original
 * (which is what masking needs): lowercase, accents dropped, look-alikes mapped, separators as spaces.
 */
function fold(text: string): string {
  let out = "";
  for (const ch of text) {
    const base = ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    const c = base.length === 1 ? base : base.length ? base[0] : " ";
    const mapped = LOOKALIKE[c] ?? (SEPARATOR.test(c) ? " " : c);
    out += ch.length === 2 ? mapped + " " : mapped; // a surrogate pair keeps its two code units
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A term as a whole word or phrase; spaces in it match any run of spaces. */
const termRe = (term: string, flags = "") => new RegExp(`(?<![\\p{L}\\p{N}])${escape(fold(term).trim()).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`, `u${flags}`);

const squash = (s: string) => s.replace(/\s+/g, "");

function blockedTermIn(folded: string, field: NameField, blocked: readonly string[]): string | null {
  for (const term of blocked) {
    if (termRe(term).test(folded)) return term;
    if (field === "handle" && squash(term).length >= SUBSTRING_MIN && squash(folded).includes(squash(fold(term)))) return term;
  }
  return null;
}

/** The text with each masked term's letters after the first replaced by "*". */
function mask(text: string, folded: string, masked: readonly string[]): string {
  const chars = [...text.split("")];
  for (const term of masked) {
    for (const m of folded.matchAll(termRe(term, "g"))) {
      for (let i = m.index! + 1; i < m.index! + m[0].length; i++) if (chars[i] !== " ") chars[i] = "*";
    }
  }
  return chars.join("");
}

/**
 * Check a name. Refused: `{ ok: false, term }` (the term is for logs, never shown). Otherwise the text to keep,
 * masked where needed. `extra`: ops' own terms from the safety config, on top of the built-in lists.
 */
export function checkName(text: string, field: NameField, extra: NameTerms = { blockedTerms: [], maskedTerms: [] }): NameCheck {
  const folded = fold(text);
  const blocked = [...BLOCKED_NAME_TERMS, ...extra.blockedTerms];
  const masked = [...MASKED_NAME_TERMS, ...extra.maskedTerms];
  const hit = blockedTermIn(folded, field, field === "handle" ? [...blocked, ...masked] : blocked);
  if (hit) return { ok: false, term: hit };
  return { ok: true, text: mask(text, folded, masked) };
}

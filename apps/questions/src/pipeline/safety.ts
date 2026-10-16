/**
 * Safety and taste filter, failing closed: anything the filter can't read is rejected, and any
 * hit on the deny-list is rejected with the reason recorded. Politics is allowed only when the
 * brief itself asked for it (CLAUDE.md step 7). v1 is a term list; a model-based filter would be
 * a better judge but the shape (passed + reasons, fail closed) stays the same.
 */
import type { GenerationSpec } from "../providers/types.js";

export interface SafetyResult {
  passed: boolean;
  reasons: string[];
}

const DENY: Record<string, string[]> = {
  profanity: ["fuck", "shit", "bitch", "asshole", "bastard"],
  sexual: ["sex", "porn", "nude", "nsfw"],
  hate: ["kill all", "subhuman", "vermin"],
  gambling_promo: ["bet9ja", "sportybet", "betway", "casino", "stake your"],
  alcohol_promo: ["drink responsibly", "get drunk", "free beer"],
};
const POLITICS = ["election", "ballot", "vote for", "apc", "pdp", "political party", "campaign rally"];

/** Whole-word (or whole-phrase) match, so "sex" never rejects a question about Essex. */
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (text: string, term: string) => new RegExp(`\\b${escape(term)}\\b`).test(text);

const wantsPolitics = (spec: GenerationSpec) =>
  POLITICS.some((t) => mentions(spec.topic.toLowerCase(), t)) && !spec.exclusions.includes("politics");

/** Every player-visible and server-side string in the draft, lowercased. */
function allText(payload: unknown, explanation?: string): string {
  const strings: string[] = explanation ? [explanation] : [];
  const walk = (v: unknown) => {
    if (typeof v === "string") strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(payload);
  return strings.join(" ").toLowerCase();
}

export function checkSafety(spec: GenerationSpec, payload: unknown, explanation?: string): SafetyResult {
  try {
    const text = allText(payload, explanation);
    if (!text) return { passed: false, reasons: ["empty"] };
    const reasons = Object.entries(DENY).filter(([, terms]) => terms.some((t) => mentions(text, t))).map(([k]) => k);
    if (!wantsPolitics(spec) && POLITICS.some((t) => mentions(text, t))) reasons.push("politics");
    for (const excluded of spec.exclusions) if (excluded && mentions(text, excluded)) reasons.push(`excluded:${excluded}`);
    return { passed: reasons.length === 0, reasons };
  } catch {
    return { passed: false, reasons: ["unreadable"] }; // fail closed
  }
}

/**
 * Safety and taste filter, failing closed: anything the filter can't read is rejected, and any
 * hit on the deny-list is rejected with the reason recorded. Politics is allowed only when the
 * brief itself asked for it; the brief's own exclusions ("nothing about X") are enforced too.
 * One copy, shared by the question engine (generated drafts) and the API (host edits in curate
 * mode). v1 is a term list; a model-based filter would judge better but keeps this shape.
 */

/** What the filter needs to know about the brief. A GenerationSpec satisfies it. */
export interface SafetyBrief {
  topic: string;
  exclusions: string[];
}

export interface SafetyResult {
  passed: boolean;
  reasons: string[];
}

/** Also what chat masks (maskProfanity in chat.ts): one list. */
export const PROFANITY = ["fuck", "shit", "bitch", "asshole", "bastard"];

const DENY: Record<string, string[]> = {
  profanity: PROFANITY,
  sexual: ["sex", "porn", "nude", "nsfw"],
  hate: ["kill all", "subhuman", "vermin"],
  gambling_promo: ["bet9ja", "sportybet", "betway", "casino", "stake your"],
  alcohol_promo: ["drink responsibly", "get drunk", "free beer"],
};
const POLITICS = ["election", "ballot", "vote for", "apc", "pdp", "political party", "campaign rally"];

/** Whole-word (or whole-phrase) match, so "sex" never rejects a question about Essex. */
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (text: string, term: string) => new RegExp(`\\b${escape(term)}\\b`).test(text);

const wantsPolitics = (brief: SafetyBrief) =>
  POLITICS.some((t) => mentions(brief.topic.toLowerCase(), t)) && !brief.exclusions.includes("politics");

/** Every player-visible and server-side string in the question, lowercased. */
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

export function checkSafety(brief: SafetyBrief, payload: unknown, explanation?: string): SafetyResult {
  const text = allText(payload, explanation);
  if (!text.trim()) return { passed: false, reasons: ["empty"] };
  const reasons = Object.entries(DENY).filter(([, terms]) => terms.some((t) => mentions(text, t))).map(([k]) => k);
  if (!wantsPolitics(brief) && POLITICS.some((t) => mentions(text, t))) reasons.push("politics");
  for (const excluded of brief.exclusions) if (excluded && mentions(text, excluded)) reasons.push(`excluded:${excluded}`);
  return { passed: reasons.length === 0, reasons };
}

/** "nothing about politics", "no questions about X", "avoid X" → ["politics", "x"]. */
export function parseExclusions(brief: string): string[] {
  const out: string[] = [];
  for (const m of brief.matchAll(/\b(?:no(?:thing)?(?: questions)? about|avoid|skip|without)\s+([a-z0-9' -]+?)(?=[.,;!\n]|$)/gi)) {
    out.push(m[1].trim().toLowerCase());
  }
  return [...new Set(out)];
}

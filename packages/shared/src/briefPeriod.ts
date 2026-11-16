/**
 * The period a host's brief asks about (ADR 0016, "Periods and recent events", 16 Nov 2026): a year, a range, a
 * season, a decade, or a word like "this season" or "latest". A set stays inside it. A period too recent for the
 * question writer to know (nothing writes with a search yet; generation is from the model's own knowledge) can't be
 * covered honestly, so creating a party with one is refused (409 recent_period_unsupported) until the host says
 * explicitly what to do instead: `recentPeriod: "history"` (the topic's history, up to what's reliably known).
 * Shared by the API (the refusal) and the question engine (the spec, the prompt and the summary). Pure.
 */
import { z } from "zod";

export interface BriefPeriod {
  /** As shown back to the host: "2026", "2010–2015", "the 1990s", "this year". */
  label: string;
  from: number;
  to: number;
}

/** What the host chose for a recent period. Only history for now; "search" when a generator can look things up. */
export const RECENT_PERIOD_CHOICES = ["history"] as const;
export type RecentPeriodChoice = (typeof RECENT_PERIOD_CHOICES)[number];
export const recentPeriodChoiceSchema = z.enum(RECENT_PERIOD_CHOICES);

/**
 * 409 from POST /parties and POST /parties/:id/questions/retry: details { period: BriefPeriod, knownThrough, choices },
 * knownThrough being the last year the writers know well (knownThroughYear()), for the builder's copy.
 */
export const RECENT_PERIOD_UNSUPPORTED = "recent_period_unsupported";

/**
 * How far behind today the question writers' knowledge is assumed to stop. A period ending inside this window is
 * recent: the models were trained before most of it happened.
 */
export const WRITER_KNOWLEDGE_LAG_MONTHS = 12;

const MIN_YEAR = 1900;
const MAX_YEAR = 2099;
const RELATIVE = /\b(this year|this season|recent(ly)?|latest|current(ly)?|right now|nowadays|these days)\b/;
const RANGE = /\b((?:19|20)\d{2})\s*(?:-|–|—|\/|to|until|through)\s*((?:19|20)?\d{2})\b/g;
/** "1990s" anywhere; the short form only as "the 90s" or "'90s", so "in her 30s" isn't a decade. */
const DECADE = /\b((?:19|20)\d)0'?s\b|(?:\bthe\s+|')(\d)0'?s\b/g;
const YEAR = /\b((?:19|20)\d{2})\b/g;

const inRange = (y: number) => y >= MIN_YEAR && y <= MAX_YEAR;
/** "25" after "2024" is 2025; a four-digit end stands as written. */
const endYear = (start: number, end: string) => (end.length === 2 ? Math.floor(start / 100) * 100 + Number(end) : Number(end));
/** "90" is the 1990s; "10" or "20" the 2010s or 2020s (people mean the last hundred years). */
const decadeStart = (digits: string, now: number) => {
  if (digits.length === 3) return Number(digits) * 10;
  const d = Number(digits) * 10;
  return 2000 + d <= now ? 2000 + d : 1900 + d;
};

/** The period a brief asks about, or null when it names none. Several mentions widen it to cover them all. */
export function briefPeriod(brief: string, now: Date = new Date()): BriefPeriod | null {
  const text = brief.toLowerCase();
  const year = now.getUTCFullYear();
  const spans: { from: number; to: number; label: string }[] = [];
  let rest = text;
  for (const m of text.matchAll(RANGE)) {
    const from = Number(m[1]);
    const to = endYear(from, m[2]);
    if (inRange(from) && inRange(to) && to >= from) spans.push({ from, to, label: `${from}–${to}` });
    rest = rest.replace(m[0], " ");
  }
  for (const m of rest.matchAll(DECADE)) {
    const from = decadeStart(m[1] ?? m[2], year);
    if (inRange(from)) spans.push({ from, to: from + 9, label: `the ${from}s` });
  }
  rest = rest.replace(DECADE, " ");
  for (const m of rest.matchAll(YEAR)) spans.push({ from: Number(m[1]), to: Number(m[1]), label: m[1] });
  if (RELATIVE.test(text)) spans.push({ from: year, to: year, label: "this year" });
  if (!spans.length) return null;
  if (spans.length === 1) return spans[0];
  const from = Math.min(...spans.map((s) => s.from));
  const to = Math.max(...spans.map((s) => s.to));
  return { from, to, label: from === to ? String(from) : `${from}–${to}` };
}

/** The last whole year the writers know well: the year before the one WRITER_KNOWLEDGE_LAG_MONTHS ago. */
export const knownThroughYear = (now: Date = new Date()) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - WRITER_KNOWLEDGE_LAG_MONTHS, 1)).getUTCFullYear() - 1;

/** True when the period reaches past what the writers know well. */
export const isRecentPeriod = (period: BriefPeriod, now: Date = new Date()) => period.to > knownThroughYear(now);

/** The brief's period when it's too recent to cover; null when there's none or it's old enough. */
export function recentPeriodIn(brief: string, now: Date = new Date()): BriefPeriod | null {
  const period = briefPeriod(brief, now);
  return period && isRecentPeriod(period, now) ? period : null;
}

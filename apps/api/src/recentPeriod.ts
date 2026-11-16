/**
 * A brief that asks about a period too recent for the question writers to know (briefPeriod.ts in shared) needs
 * the host's explicit choice: refused with 409 recent_period_unsupported { period, knownThrough, choices } until the request
 * says what to do instead (ADR 0016, "Periods and recent events"). Returns what the party keeps: the choice when
 * the brief needs one, else null.
 */
import { RECENT_PERIOD_CHOICES, RECENT_PERIOD_UNSUPPORTED, knownThroughYear, recentPeriodIn, type RecentPeriodChoice } from "@contestly/shared";
import { httpError } from "./httpError.js";

export function assertRecentPeriodChosen(brief: string, choice: RecentPeriodChoice | undefined, now = new Date()): RecentPeriodChoice | null {
  const period = recentPeriodIn(brief, now);
  if (!period) return null;
  if (!choice) throw httpError(409, RECENT_PERIOD_UNSUPPORTED, { period, knownThrough: knownThroughYear(now), choices: RECENT_PERIOD_CHOICES });
  return choice;
}

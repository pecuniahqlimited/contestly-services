import type { Party } from "@contestly/db";
import { splitIdOf } from "@contestly/shared";

/**
 * A party row as anyone may see it. Never the host's brief (it can list the very facts a sealed set asks
 * about), the person behind the host (only publicHost() names a host, ADR 0001), or the engine's working
 * state; the question set's state goes out as questionDisclosure() instead. Nor the limits it was created under.
 */
export function publicParty(p: Party) {
  const { createdByUserId: _creator, brief: _brief, specSummary: _spec, questionsError: _error, forgeProgress: _forge, liveAt: _live, endedAt: _ended, playStatsRecordedAt: _stats, limits: _limits, ...view } = p;
  return { ...view, splitId: splitIdOf(p.split) };
}

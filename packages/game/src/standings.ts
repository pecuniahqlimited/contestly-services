/**
 * Standings: total score descending, tie-break by cumulative answer time ascending
 * (a question left unanswered counts as its full duration), then by userId for determinism.
 * `prevRank` comes from the previous standings; the client never infers it.
 */
export interface PlayerTally {
  userId: string;
  score: number;
  timeMs: number;
}

export interface StandingRow extends PlayerTally {
  rank: number;
  /** null on the first standings of the match. */
  prevRank: number | null;
}

export function computeStandings(tallies: PlayerTally[], previous?: Map<string, number>): StandingRow[] {
  const sorted = [...tallies].sort(
    (a, b) => b.score - a.score || a.timeMs - b.timeMs || (a.userId < b.userId ? -1 : 1),
  );
  return sorted.map((t, i) => ({ ...t, rank: i + 1, prevRank: previous?.get(t.userId) ?? null }));
}

export function rankMap(rows: StandingRow[]): Map<string, number> {
  return new Map(rows.map((r) => [r.userId, r.rank]));
}

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

/** A question of the play order as recorded: voided ones count for nobody. */
export interface RecordedQuestion { id: string; seconds: number; voided: boolean }
/** A recorded verdict (party_answers): the points it scored and when it was answered (null: not answered). */
export interface RecordedAnswer { questionId: string; userId: string; points: number; answeredMs: number | null }

/**
 * Final standings rebuilt from what was recorded, the same way Match keeps them: per question that wasn't
 * voided, a player's points and answer time; a question they have no verdict for (not answered, or played
 * before they joined) counts its full duration and no points. Used when the room that held the match is
 * gone and the party must still settle by the scores everyone earned.
 */
export function standingsFromRecords(players: readonly string[], questions: readonly RecordedQuestion[], answers: readonly RecordedAnswer[]): StandingRow[] {
  const byKey = new Map(answers.map((a) => [`${a.questionId}:${a.userId}`, a]));
  const counted = questions.filter((q) => !q.voided);
  return computeStandings(players.map((userId) => {
    let score = 0, timeMs = 0;
    for (const q of counted) {
      const a = byKey.get(`${q.id}:${userId}`);
      score += a?.points ?? 0;
      timeMs += a?.answeredMs ?? q.seconds * 1000;
    }
    return { userId, score, timeMs };
  }));
}

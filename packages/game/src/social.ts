/**
 * Ranking for the friends and crew boards (ADR 0008): total = Climb points + party points. Boards show
 * competition ranks (equal totals share a rank); ▲/▼ compare with the totals as today began. A crew's
 * closed week needs one person per place: ties go to more Climb points, then whoever joined the crew first.
 */
import { competitionRanks } from "./climb/boards.js";

export interface SocialScore {
  userId: string;
  climb: number;
  parties: number;
  /** Their total when today began; null when they had nothing on the board then. */
  prevTotal: number | null;
}

export interface RankedSocialScore extends SocialScore { total: number; rank: number; prevRank: number | null }

/** Everyone given is on the board, ranked by total; prevRank ranks the start-of-day totals among those who had one. */
export function socialBoardRanks(rows: readonly SocialScore[]): RankedSocialScore[] {
  const ranked = competitionRanks(rows.map((r) => ({ ...r, points: r.climb + r.parties })));
  const prev = new Map(competitionRanks(rows.filter((r) => r.prevTotal !== null).map((r) => ({ userId: r.userId, points: r.prevTotal! }))).map((r) => [r.userId, r.rank]));
  return ranked.map(({ points, ...r }) => ({ ...r, total: points, prevRank: prev.get(r.userId) ?? null }));
}

export interface CrewWeekScore { userId: string; climb: number; parties: number; joinedAt: Date }

/** A crew's closed week: total, then Climb points, then crew tenure, then user id. Nobody with 0 places. */
export function crewWeekPlaces(rows: readonly CrewWeekScore[]) {
  return rows
    .map((r) => ({ ...r, points: r.climb + r.parties }))
    .filter((r) => r.points > 0)
    .sort((a, b) => b.points - a.points || b.climb - a.climb || a.joinedAt.getTime() - b.joinedAt.getTime() || (a.userId < b.userId ? -1 : 1))
    .map((r, i) => ({ userId: r.userId, points: r.points, place: i + 1 }));
}

/**
 * Ranking rules for Climb boards and the weekly prizes. Boards show competition ranks (equal points
 * share a rank). Prizes need one winner per place, so at week close ties go to whoever reached their
 * points first, then to the lower user id so the order is total.
 */
export interface Scored { userId: string; points: number }

/** Rank = 1 + how many scored more. */
export function competitionRanks<T extends Scored>(rows: readonly T[]): (T & { rank: number })[] {
  const sorted = [...rows].sort((a, b) => b.points - a.points || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  return sorted.map((r) => ({ ...r, rank: 1 + sorted.filter((o) => o.points > r.points).length }));
}

export interface WeekScore extends Scored { reachedAt: Date }
export interface WeekPlace extends WeekScore { place: number }

/** The closed week's final order: points, then who got there first, then user id. Places are 1, 2, 3… with no ties. */
export function weekPlaces(rows: readonly WeekScore[]): WeekPlace[] {
  return [...rows]
    .filter((r) => r.points > 0)
    .sort((a, b) => b.points - a.points || a.reachedAt.getTime() - b.reachedAt.getTime() || (a.userId < b.userId ? -1 : 1))
    .map((r, i) => ({ ...r, place: i + 1 }));
}

/** The pending awards for a closed week: the top places that have a prize. */
export function weeklyAwards(places: readonly WeekPlace[], prizeKobo: readonly number[]) {
  return places.slice(0, prizeKobo.length).map((p) => ({ userId: p.userId, place: p.place, points: p.points, amountKobo: prizeKobo[p.place - 1] }));
}

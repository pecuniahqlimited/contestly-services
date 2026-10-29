/**
 * The friends and crew boards (ADR 0008): Climb points plus party points, this week or all time, ranked by
 * socialBoardRanks. The friends board lists you and the people you follow who've scored; a crew board lists
 * every member, with last week's champion crowned.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db, follows, liveUser, socialScores, users } from "@contestly/db";
import { socialBoardRanks } from "@contestly/game";
import { lagosDay, weekEndsAt, weekOf, type BoardPeriod, type Person, type SocialBoard } from "@contestly/shared";
import { personColumns } from "./people.js";

interface BoardOptions {
  /** Crew boards show every member; the friends board only those with points (and you). */
  everyone: boolean;
  /** Who wears the crown (crew boards). */
  champion?: string | null;
}

export async function socialBoard(userIds: string[], period: BoardPeriod, viewerId: string, opts: BoardOptions): Promise<SocialBoard> {
  const today = lagosDay();
  const week = weekOf(today);
  const scores = (await socialScores(userIds, period, today)).filter((s) => opts.everyone || s.userId === viewerId || s.climb + s.parties > 0);
  const ranked = socialBoardRanks(scores);
  const people = ranked.length ? await db.select(personColumns).from(users).where(and(inArray(users.id, ranked.map((r) => r.userId)), liveUser)) : [];
  const personOf = new Map(people.map((p) => [p.id, p as Person]));
  const rows = ranked.filter((r) => personOf.has(r.userId))
    .map((r) => ({
      rank: r.rank, prevRank: period === "week" ? r.prevRank : null, person: personOf.get(r.userId)!, climb: r.climb, parties: r.parties, total: r.total,
      isMe: r.userId === viewerId, crowned: !!opts.champion && r.userId === opts.champion,
    }))
    .sort((a, b) => a.rank - b.rank || a.person.displayName.localeCompare(b.person.displayName));
  return { period, week, endsAt: period === "week" ? weekEndsAt(week).toISOString() : null, rows, me: rows.find((r) => r.isMe) ?? null };
}

/** You and the people you follow. */
export async function friendsBoard(viewerId: string, period: BoardPeriod) {
  const followed = await db.select({ id: follows.followeeId }).from(follows).innerJoin(users, eq(users.id, follows.followeeId))
    .where(eq(follows.followerId, viewerId));
  return socialBoard([viewerId, ...followed.map((f) => f.id)], period, viewerId, { everyone: false });
}

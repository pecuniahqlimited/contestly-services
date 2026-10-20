/**
 * The pure parts of "me and my people": who a party card shows, the head-to-head between two players,
 * and how my parties are grouped. The routes load rows; these decide what they mean.
 */
import { MAX_FRIENDS_NAMED, MAX_PARTY_FACES, MY_RECENT_DAYS, MY_RECENT_LIMIT, type HeadToHead, type Person, type PartyPeople, type PartyStatus } from "@contestly/shared";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Faces: the host's first if they play, then everyone else by join time. Friends: the people the viewer
 * follows who are in it (never the viewer), named in join order.
 * `players` must already be in join order.
 */
export function pickPartyPeople(players: Person[], hostId: string, following: ReadonlySet<string>, viewerId?: string): PartyPeople {
  const faces = [...players.filter((p) => p.id === hostId), ...players.filter((p) => p.id !== hostId)].slice(0, MAX_PARTY_FACES);
  const friends = players.filter((p) => p.id !== viewerId && following.has(p.id));
  return { faces, friendsIn: { people: friends.slice(0, MAX_FRIENDS_NAMED), count: friends.length } };
}

/** Over parties both played: who placed above whom. A party either didn't get a rank in is left out; ties count for neither. */
export function headToHead(rows: { myRank: number | null; theirRank: number | null }[]): HeadToHead {
  const result = { me: 0, them: 0, played: 0 };
  for (const { myRank, theirRank } of rows) {
    if (myRank === null || theirRank === null) continue;
    result.played++;
    if (myRank < theirRank) result.me++;
    else if (theirRank < myRank) result.them++;
  }
  return result;
}

type Groupable = { status: PartyStatus; startsAt: Date; endedAt: Date | null; role: "hosting" | "playing" | "invited" };
export type MyPartyGroups<T> = { invited: T[]; live: T[]; upcoming: T[]; recent: T[] };

const bySoonest = (a: Groupable, b: Groupable) => a.startsAt.getTime() - b.startsAt.getTime();
/** Parties that ended before ended_at was recorded count from their start. */
const endOf = (p: Groupable) => (p.endedAt ?? p.startsAt).getTime();

/**
 * invited: pending invites to parties still open. live and upcoming: mine, soonest first. recent: mine
 * that finished or were cancelled within MY_RECENT_DAYS, newest first, at most MY_RECENT_LIMIT.
 */
export function groupMyParties<T extends Groupable>(parties: T[], now: Date): MyPartyGroups<T> {
  const since = now.getTime() - MY_RECENT_DAYS * DAY_MS;
  const mine = parties.filter((p) => p.role !== "invited");
  return {
    invited: parties.filter((p) => p.role === "invited" && p.status === "open").sort(bySoonest),
    live: mine.filter((p) => p.status === "live").sort(bySoonest),
    upcoming: mine.filter((p) => p.status === "open").sort(bySoonest),
    recent: mine.filter((p) => (p.status === "finished" || p.status === "cancelled") && endOf(p) >= since).sort((a, b) => endOf(b) - endOf(a)).slice(0, MY_RECENT_LIMIT),
  };
}

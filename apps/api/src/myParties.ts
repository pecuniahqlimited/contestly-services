/** GET /me/parties: the parties I host, play or am invited to, grouped, each with its chat thread, last line and unread count. */
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db, hostTeamOf, isHostTeam, parties, partyInvites, partyPlayers, users, type Party, type User } from "@contestly/db";
import { MY_RECENT_DAYS, type MyPartyRole, type Person } from "@contestly/shared";
import { partyThreads } from "./chats.js";
import { partyLinks } from "./invites.js";
import { partySummaries } from "./partySummaries.js";
import { personColumns } from "./people.js";
import { groupMyParties } from "./social.js";

const DAY_MS = 24 * 60 * 60 * 1000;

type Mine = { p: Party; role: MyPartyRole; invitedBy: Person | null; status: Party["status"]; startsAt: Date; endedAt: Date | null };
const mine = (p: Party, role: MyPartyRole, invitedBy: Person | null = null): Mine => ({ p, role, invitedBy, status: p.status, startsAt: p.startsAt, endedAt: p.endedAt });

export async function myParties(me: User, now = new Date()) {
  const since = new Date(now.getTime() - MY_RECENT_DAYS * DAY_MS);
  const seatedIn = db.select({ id: partyPlayers.partyId }).from(partyPlayers).where(eq(partyPlayers.userId, me.id));
  const [own, invites] = await Promise.all([
    db.select().from(parties).where(and(
      or(hostTeamOf(me.id), inArray(parties.id, seatedIn)),
      or(inArray(parties.status, ["open", "live"]), sql`coalesce(${parties.endedAt}, ${parties.startsAt}) >= ${since.toISOString()}`),
    )),
    db.select({ p: parties, inviter: personColumns }).from(partyInvites)
      .innerJoin(parties, eq(parties.id, partyInvites.partyId)).innerJoin(users, eq(users.id, partyInvites.inviterId))
      .where(and(eq(partyInvites.inviteeId, me.id), eq(partyInvites.status, "pending"), eq(parties.status, "open"))),
  ]);
  const ownIds = new Set(own.map((p) => p.id));
  const groups = groupMyParties([
    ...own.map((p) => mine(p, isHostTeam(p, me.id) ? "hosting" : "playing")),
    ...invites.filter((i) => !ownIds.has(i.p.id)).map((i) => mine(i.p, "invited", i.inviter)),
  ], now);

  const shown = Object.values(groups).flat();
  const ids = shown.map((m) => m.p.id);
  const [summaries, threads, ranks] = await Promise.all([
    partySummaries(shown.map((m) => m.p), me.id),
    partyThreads(ids, me.id),
    ids.length ? db.select({ partyId: partyPlayers.partyId, rank: partyPlayers.rank }).from(partyPlayers).where(and(eq(partyPlayers.userId, me.id), inArray(partyPlayers.partyId, ids))) : [],
  ]);
  const summaryOf = new Map(summaries.map((s) => [s.id, s]));
  const rankOf = new Map(ranks.map((r) => [r.partyId, r.rank]));
  const view = (m: Mine) => {
    const chat = threads.get(m.p.id);
    return { ...summaryOf.get(m.p.id)!, role: m.role, invite: partyLinks(m.p.id), threadId: chat?.threadId ?? null, lastLine: chat?.lastLine ?? null, unread: chat?.unread ?? 0, invitedBy: m.invitedBy, myRank: rankOf.get(m.p.id) ?? null };
  };
  return { invited: groups.invited.map(view), live: groups.live.map(view), upcoming: groups.upcoming.map(view), recent: groups.recent.map(view) };
}

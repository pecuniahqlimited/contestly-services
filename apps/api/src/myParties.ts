/** GET /me/parties: the parties I host, play or am invited to, grouped, each with its last chat line. */
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db, chatMessages, hostTeamOf, isHostTeam, parties, partyInvites, partyPlayers, users, type Party, type User } from "@contestly/db";
import { MY_RECENT_DAYS, type LastChatLine, type MyPartyRole, type Person } from "@contestly/shared";
import { partySummaries } from "./partySummaries.js";
import { personColumns } from "./people.js";
import { groupMyParties } from "./social.js";

const DAY_MS = 24 * 60 * 60 * 1000;

type Mine = { p: Party; role: MyPartyRole; invitedBy: Person | null; status: Party["status"]; startsAt: Date; endedAt: Date | null };
const mine = (p: Party, role: MyPartyRole, invitedBy: Person | null = null): Mine => ({ p, role, invitedBy, status: p.status, startsAt: p.startsAt, endedAt: p.endedAt });

async function lastLines(partyIds: string[]): Promise<Map<string, LastChatLine>> {
  if (!partyIds.length) return new Map();
  const rows = await db.selectDistinctOn([chatMessages.partyId], { partyId: chatMessages.partyId, text: chatMessages.text, sticker: chatMessages.sticker, createdAt: chatMessages.createdAt, handle: users.handle, displayName: users.displayName })
    .from(chatMessages).leftJoin(users, eq(users.id, chatMessages.userId))
    .where(inArray(chatMessages.partyId, partyIds)).orderBy(chatMessages.partyId, desc(chatMessages.createdAt));
  return new Map(rows.map((r) => [r.partyId, {
    author: r.handle && r.displayName ? { handle: r.handle, displayName: r.displayName } : null,
    text: r.text, sticker: r.sticker, createdAt: r.createdAt.toISOString(),
  }]));
}

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
  const [summaries, lines, ranks] = await Promise.all([
    partySummaries(shown.map((m) => m.p), me.id),
    lastLines(ids),
    ids.length ? db.select({ partyId: partyPlayers.partyId, rank: partyPlayers.rank }).from(partyPlayers).where(and(eq(partyPlayers.userId, me.id), inArray(partyPlayers.partyId, ids))) : [],
  ]);
  const summaryOf = new Map(summaries.map((s) => [s.id, s]));
  const rankOf = new Map(ranks.map((r) => [r.partyId, r.rank]));
  const view = (m: Mine) => ({ ...summaryOf.get(m.p.id)!, role: m.role, lastLine: lines.get(m.p.id) ?? null, invitedBy: m.invitedBy, myRank: rankOf.get(m.p.id) ?? null });
  return { invited: groups.invited.map(view), live: groups.live.map(view), upcoming: groups.upcoming.map(view), recent: groups.recent.map(view) };
}

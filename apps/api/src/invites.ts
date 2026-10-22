/**
 * Party invites and links. Anyone in an open party (a player or the host's team) can invite people they're
 * connected to: people they follow, who follow them, or they've finished a party with. At most
 * MAX_INVITES_PER_PARTY per party. The invitee sees it in Chats › Parties until they join or dismiss it.
 */
import { and, count, eq, inArray, or, sql } from "drizzle-orm";
import { db, follows, parties, partyInvites, partyPlayers, users, isHostTeam, type Party, type Tx, type User } from "@contestly/db";
import { APP_LINK_SCHEME, MAX_INVITES_PER_PARTY, type PartyLinks } from "@contestly/shared";
import { personColumns } from "./people.js";

/** Until deploy (roadmap step 11) there's no web page behind it; the app link works today. */
const PUBLIC_WEB_URL = (process.env.PUBLIC_WEB_URL ?? "https://contestly.invalid").replace(/\/+$/, "");

export const partyLinks = (partyId: string): PartyLinks => ({ app: `${APP_LINK_SCHEME}://party/${partyId}`, web: `${PUBLIC_WEB_URL}/p/${partyId}` });

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/** Of `ids`, the people `userId` follows, is followed by, or has finished a party with. */
async function connectedTo(q: Tx | typeof db, userId: string, ids: string[]): Promise<Set<string>> {
  const rows = await q.select({ id: users.id }).from(users).where(and(inArray(users.id, ids), eq(users.isGuest, false), or(
    sql`exists (select 1 from ${follows} f where (f.follower_id = ${userId} and f.followee_id = ${users.id}) or (f.follower_id = ${users.id} and f.followee_id = ${userId}))`,
    sql`exists (select 1 from ${partyPlayers} a join ${partyPlayers} b on b.party_id = a.party_id join ${parties} p on p.id = a.party_id
                where a.user_id = ${userId} and b.user_id = ${users.id} and p.status = 'finished')`,
  )));
  return new Set(rows.map((r) => r.id));
}

/**
 * Invites `ids` to `party` from `inviter`, inside the caller's transaction (which holds the party row lock).
 * Skips the inviter, people already in and people already invited. Returns who was newly invited.
 */
export async function inviteToParty(tx: Tx, party: Party, inviter: User, ids: string[]): Promise<string[]> {
  if (party.status !== "open") throw httpError(409, "party_not_open");
  const wanted = [...new Set(ids)].filter((id) => id !== inviter.id);
  if (!wanted.length) return [];
  if (!isHostTeam(party, inviter.id)) {
    const [seat] = await tx.select({ id: partyPlayers.userId }).from(partyPlayers).where(and(eq(partyPlayers.partyId, party.id), eq(partyPlayers.userId, inviter.id)));
    if (!seat) throw httpError(403, "not_in_party");
  }
  const connected = await connectedTo(tx, inviter.id, wanted);
  if (wanted.some((id) => !connected.has(id))) throw httpError(403, "cannot_invite");
  const [seated, invited, [{ n }]] = await Promise.all([
    tx.select({ id: partyPlayers.userId }).from(partyPlayers).where(and(eq(partyPlayers.partyId, party.id), inArray(partyPlayers.userId, wanted))),
    tx.select({ id: partyInvites.inviteeId }).from(partyInvites).where(and(eq(partyInvites.partyId, party.id), inArray(partyInvites.inviteeId, wanted))),
    tx.select({ n: count() }).from(partyInvites).where(eq(partyInvites.partyId, party.id)),
  ]);
  const skip = new Set([...seated, ...invited].map((r) => r.id));
  const fresh = wanted.filter((id) => !skip.has(id));
  if (Number(n) + fresh.length > MAX_INVITES_PER_PARTY) throw httpError(409, "too_many_invites");
  if (fresh.length) await tx.insert(partyInvites).values(fresh.map((inviteeId) => ({ partyId: party.id, inviteeId, inviterId: inviter.id })));
  return fresh;
}

/** Who invited the viewer to this party, while the invite is pending. */
export async function pendingInviter(partyId: string, viewerId: string | undefined) {
  if (!viewerId) return null;
  const [row] = await db.select(personColumns).from(partyInvites).innerJoin(users, eq(users.id, partyInvites.inviterId))
    .where(and(eq(partyInvites.partyId, partyId), eq(partyInvites.inviteeId, viewerId), eq(partyInvites.status, "pending")));
  return row ?? null;
}

/** Joining answers the invite. */
export async function acceptInvite(tx: Tx, partyId: string, userId: string) {
  await tx.update(partyInvites).set({ status: "accepted", respondedAt: new Date() })
    .where(and(eq(partyInvites.partyId, partyId), eq(partyInvites.inviteeId, userId), eq(partyInvites.status, "pending")));
}

/** The invitee says no thanks. Only a pending invite can be dismissed. */
export async function dismissInvite(partyId: string, userId: string) {
  const [row] = await db.update(partyInvites).set({ status: "dismissed", respondedAt: new Date() })
    .where(and(eq(partyInvites.partyId, partyId), eq(partyInvites.inviteeId, userId), eq(partyInvites.status, "pending"))).returning();
  if (!row) throw httpError(404, "no_pending_invite");
}

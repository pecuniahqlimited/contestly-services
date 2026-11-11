/**
 * Challenges (ADR 0019): the challenge rows a party is made with, the invitees' answers, and what the worker
 * decides at the invite's expiry, at the window's halfway point and at its end. Seats and refunds are the usual
 * ones (takeSeat, dropNoShow, refundAndCancel); every money move happens with the party row locked.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  CHALLENGE_ACCEPT_REQUIRED, CHALLENGE_ANSWERED, CHALLENGE_DECLINED_LINE, CHALLENGE_EXPIRED, CHALLENGE_EXPIRED_MESSAGE, CHALLENGE_MIN_PLAYERS, maskProfanity,
  type ChallengeFields, type ChatMessage, type DmPermission,
} from "@contestly/shared";
import { db, type Tx } from "./client.js";
import { parties, partyChallengeInvitees, partyChallenges, partyInvites, partyPlayers, users, type Party, type PartyChallenge, type PartyChallengeInvitee, type User } from "./schema.js";
import { joinPartyThread, openDmIn, partyCardLine, systemLine, type ChatSender } from "./chat.js";
import { nudge } from "./nudges/record.js";
import { refundAndCancel } from "./partyLifecycle.js";
import { dropNoShow, takeSeat } from "./seats.js";

type Conn = Tx | typeof db;

const MINUTE_MS = 60_000;
const challengeError = (statusCode: number, code: string, details?: Record<string, unknown>) =>
  Object.assign(new Error(code), { statusCode, ...(details ? { details } : {}) });

export interface ChallengeRows { challenge: PartyChallenge; invitees: PartyChallengeInvitee[] }

/** The party's challenge and who it asked, or null for an ordinary party. */
export async function challengeOf(conn: Conn, partyId: string): Promise<ChallengeRows | null> {
  const [challenge] = await conn.select().from(partyChallenges).where(eq(partyChallenges.partyId, partyId));
  if (!challenge) return null;
  return { challenge, invitees: await conn.select().from(partyChallengeInvitees).where(eq(partyChallengeInvitees.partyId, partyId)) };
}

/** Of these parties, the open challenges nobody has accepted yet: they start on an accept, not at startsAt. */
export async function awaitingFirstAccept(conn: Conn, partyIds: string[]): Promise<Set<string>> {
  if (!partyIds.length) return new Set();
  const rows = await conn.select({ id: partyChallenges.partyId }).from(partyChallenges).innerJoin(parties, eq(parties.id, partyChallenges.partyId))
    .where(and(inArray(partyChallenges.partyId, partyIds), isNull(partyChallenges.windowOpensAt), eq(parties.status, "open")));
  return new Set(rows.map((r) => r.id));
}

export const isChallenge = async (conn: Conn, partyId: string) => !!(await conn.select({ id: partyChallenges.partyId }).from(partyChallenges).where(eq(partyChallenges.partyId, partyId)))[0];

/** When the invite stops waiting, from the challenger's pick (already inside the admin's range). */
export const inviteExpiry = (f: Pick<ChallengeFields, "inviteExpiresInMinutes">, now: Date) => new Date(now.getTime() + f.inviteExpiresInMinutes * MINUTE_MS);
/** The latest a challenge can start: everyone answers at the last moment, then the whole window. The party's startsAt until someone accepts. */
export const latestStart = (f: Pick<ChallengeFields, "inviteExpiresInMinutes" | "joinWindowMinutes">, now: Date) =>
  new Date(inviteExpiry(f, now).getTime() + f.joinWindowMinutes * MINUTE_MS);

export interface ChallengeInvitee { user: User; permission: Exclude<DmPermission, "refused"> }

/**
 * In the party's creating transaction: the challenge, each invitee's row and party invite, the card in their DM (a
 * request for a stranger, as any first message), and their challenge_received nudge. Returns the card lines to publish.
 */
export async function writeChallenge(tx: Tx, p: Party, challenger: ChatSender, fields: ChallengeFields, invitees: ChallengeInvitee[], now = new Date()): Promise<ChatMessage[]> {
  const message = fields.message ? maskProfanity(fields.message) : null;
  await tx.insert(partyChallenges).values({ partyId: p.id, challengerUserId: challenger.id, message, inviteExpiresAt: inviteExpiry(fields, now), joinWindowMinutes: fields.joinWindowMinutes });
  const lines: ChatMessage[] = [];
  for (const { user, permission } of invitees) {
    const { threadId } = await openDmIn(tx, challenger, user, permission);
    lines.push(await partyCardLine(tx, threadId, p.id, challenger.id, message ?? `${challenger.displayName} challenged you: ${p.title}`));
    await tx.insert(partyChallengeInvitees).values({ partyId: p.id, userId: user.id, threadId });
    await tx.insert(partyInvites).values({ partyId: p.id, inviteeId: user.id, inviterId: challenger.id }).onConflictDoNothing();
    await nudge(tx, {
      userId: user.id, kind: "challenge_received", ref: { type: "party", id: p.id }, dedupeKey: `challenge_received:${p.id}:${user.id}`,
      actor: { id: challenger.id, name: challenger.displayName },
      data: { partyId: p.id, title: p.title, challengerName: challenger.displayName, challengerHandle: challenger.handle, ...(message ? { message } : {}) },
    }, now);
  }
  return lines;
}

/** Lock the party and read its challenge, or refuse: not one (404), or no longer open (409 challenge_expired). */
async function lockChallenge(tx: Tx, partyId: string) {
  const [p] = await tx.select().from(parties).where(eq(parties.id, partyId)).for("update");
  const rows = p ? await challengeOf(tx, partyId) : null;
  if (!p || !rows) throw challengeError(404, "not_found");
  return { p, ...rows };
}

function myInvite(rows: ChallengeRows, userId: string) {
  const mine = rows.invitees.find((i) => i.userId === userId);
  if (!mine) throw challengeError(404, "not_invited");
  return mine;
}

/** Can this invite still be accepted? Before its expiry, and once the window's open, before it closes. */
const stillOpen = (p: Party, c: PartyChallenge, now: Date) =>
  p.status === "open" && now < c.inviteExpiresAt && (!c.windowClosesAt || now < c.windowClosesAt);

export interface Accepted {
  replayed: boolean;
  /** Set when this accept opened the join window: the worker's start and reminder are queued for it. */
  opened: { opensAt: Date; closesAt: Date } | null;
  line: ChatMessage | null;
  seats: { taken: number; max: number } | null;
}

/**
 * Accept: a seat through takeSeat (the equal entry charged, bonus first; 402 if it isn't there), the party chat
 * joined, and the challenger told. The first accept opens the join window and moves startsAt to its end.
 */
export async function acceptChallenge(partyId: string, me: User, now = new Date()): Promise<Accepted> {
  return db.transaction(async (tx) => {
    const rows = await lockChallenge(tx, partyId);
    const { p, challenge } = rows;
    const mine = myInvite(rows, me.id);
    if (mine.answer === "accepted") return { replayed: true, opened: null, line: null, seats: null };
    if (mine.answer !== "pending") throw challengeError(409, mine.answer === "expired" ? CHALLENGE_EXPIRED : CHALLENGE_ANSWERED, { answer: mine.answer });
    if (!stillOpen(p, challenge, now)) throw challengeError(409, CHALLENGE_EXPIRED);
    await takeSeat(tx, p, me.id, p.entryKobo);
    await tx.update(partyChallengeInvitees).set({ answer: "accepted", answeredAt: now }).where(and(eq(partyChallengeInvitees.partyId, partyId), eq(partyChallengeInvitees.userId, me.id)));
    await tx.update(partyInvites).set({ status: "accepted", respondedAt: now }).where(and(eq(partyInvites.partyId, partyId), eq(partyInvites.inviteeId, me.id)));
    await joinPartyThread(tx, partyId, me.id);
    const line = await systemLine(tx, partyId, `${me.displayName} accepted the challenge`);
    let opened: Accepted["opened"] = null;
    if (!challenge.windowOpensAt) {
      opened = { opensAt: now, closesAt: new Date(now.getTime() + challenge.joinWindowMinutes * MINUTE_MS) };
      await tx.update(partyChallenges).set({ windowOpensAt: opened.opensAt, windowClosesAt: opened.closesAt }).where(eq(partyChallenges.partyId, partyId));
      await tx.update(parties).set({ startsAt: opened.closesAt }).where(eq(parties.id, partyId));
    }
    await nudge(tx, {
      userId: challenge.challengerUserId, kind: "challenge_accepted", ref: { type: "party", id: partyId }, dedupeKey: `challenge_accepted:${partyId}:${me.id}`,
      actor: { id: me.id, name: me.displayName }, data: { partyId, title: p.title, byName: me.displayName },
    }, now);
    const taken = (await tx.select({ id: partyPlayers.id }).from(partyPlayers).where(eq(partyPlayers.partyId, partyId))).length;
    return { replayed: false, opened, line, seats: { taken, max: p.maxPlayers } };
  });
}

export interface Declined {
  replayed: boolean;
  /** "Not this time" on the invitee's card in the DM. */
  cardLine: ChatMessage | null;
  /** Nobody's left to play with: cancelled and refunded, with the party's chat line to announce. */
  cancelled: ChatMessage | null;
}

/** Decline: "Not this time" on the card. Once nobody is pending or accepted, the party is cancelled and refunded. */
export async function declineChallenge(partyId: string, me: User, now = new Date()): Promise<Declined> {
  return db.transaction(async (tx) => {
    const rows = await lockChallenge(tx, partyId);
    const { p } = rows;
    const mine = myInvite(rows, me.id);
    if (mine.answer === "declined") return { replayed: true, cardLine: null, cancelled: null };
    if (mine.answer !== "pending") throw challengeError(409, mine.answer === "expired" ? CHALLENGE_EXPIRED : CHALLENGE_ANSWERED, { answer: mine.answer });
    await tx.update(partyChallengeInvitees).set({ answer: "declined", answeredAt: now }).where(and(eq(partyChallengeInvitees.partyId, partyId), eq(partyChallengeInvitees.userId, me.id)));
    await tx.update(partyInvites).set({ status: "dismissed", respondedAt: now }).where(and(eq(partyInvites.partyId, partyId), eq(partyInvites.inviteeId, me.id)));
    const cardLine = await partyCardLine(tx, mine.threadId, partyId, me.id, CHALLENGE_DECLINED_LINE);
    const left = rows.invitees.filter((i) => i.userId !== me.id && (i.answer === "pending" || i.answer === "accepted"));
    if (p.status !== "open" || left.length) return { replayed: false, cardLine, cancelled: null };
    await tx.update(partyChallenges).set({ ending: "declined" }).where(eq(partyChallenges.partyId, partyId));
    const { line } = await refundAndCancel(tx, p, "Challenge declined.");
    return { replayed: false, cardLine, cancelled: line };
  });
}

/** Invites still pending stop waiting: the invite ran out, or the window it could have joined closed. */
async function expirePending(tx: Tx, rows: ChallengeRows, now: Date) {
  const pending = rows.invitees.filter((i) => i.answer === "pending").map((i) => i.userId);
  if (!pending.length) return;
  await tx.update(partyChallengeInvitees).set({ answer: "expired", answeredAt: now }).where(and(eq(partyChallengeInvitees.partyId, rows.challenge.partyId), inArray(partyChallengeInvitees.userId, pending)));
  for (const i of rows.invitees) if (i.answer === "pending") i.answer = "expired";
}

async function cancelExpired(tx: Tx, p: Party): Promise<ChatMessage> {
  await tx.update(partyChallenges).set({ ending: "expired" }).where(eq(partyChallenges.partyId, p.id));
  return (await refundAndCancel(tx, p, CHALLENGE_EXPIRED_MESSAGE)).line;
}

/**
 * The invite's expiry (the worker's job): with nobody accepted, the party is cancelled and refunded ("Challenge
 * expired."); otherwise invites still pending expire and the game waits for the window as usual.
 */
export async function expireChallenge(partyId: string, now = new Date()): Promise<{ cancelled: ChatMessage | null; expiredSome: boolean }> {
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(parties).where(eq(parties.id, partyId)).for("update");
    const rows = p ? await challengeOf(tx, partyId) : null;
    if (!p || !rows || p.status !== "open" || now < rows.challenge.inviteExpiresAt) return { cancelled: null, expiredSome: false };
    const expiredSome = rows.invitees.some((i) => i.answer === "pending");
    await expirePending(tx, rows, now);
    if (!rows.challenge.windowOpensAt) return { cancelled: await cancelExpired(tx, p), expiredSome };
    return { cancelled: null, expiredSome };
  });
}

/**
 * At start (startOrCancel, the party row locked): who plays a challenge. Invites still pending expire. Fewer than two
 * seated players in the lobby, the challenger counted like anyone (ADR 0019), or nobody ever accepted: cancelled and
 * everyone refunded. Otherwise every seated player not in the lobby is unseated and refunded, the challenger included.
 * Null for an ordinary party; else the cancel's line, if any.
 */
export async function settleChallengeRoster(tx: Tx, p: Party, inLobby: ReadonlySet<string>, now = new Date()): Promise<{ cancelled: ChatMessage | null } | null> {
  const rows = await challengeOf(tx, p.id);
  if (!rows) return null;
  await expirePending(tx, rows, now);
  if (!rows.challenge.windowOpensAt) return { cancelled: await cancelExpired(tx, p) };
  const seated = (await tx.select({ userId: partyPlayers.userId }).from(partyPlayers).where(eq(partyPlayers.partyId, p.id))).map((s) => s.userId);
  const absent = seated.filter((id) => !inLobby.has(id));
  if (seated.length - absent.length < CHALLENGE_MIN_PLAYERS) return { cancelled: await cancelExpired(tx, p) };
  if (absent.length) {
    for (const u of await tx.select().from(users).where(inArray(users.id, absent))) await dropNoShow(tx, p, u, now);
  }
  return { cancelled: null };
}

/**
 * After an acceptor's leave (POST /parties/:id/leave, in its transaction; their answer is already "left"): with nobody
 * still asked or accepted, nobody is coming, so it's cancelled now ("Challenge expired."). Null for an ordinary party;
 * else the cancel's line, if any (none means the start may now be ready).
 */
export async function challengeAfterLeave(tx: Tx, p: Party): Promise<{ cancelled: ChatMessage | null } | null> {
  const rows = await challengeOf(tx, p.id);
  if (!rows) return null;
  if (p.status !== "open" || rows.invitees.some((i) => i.answer === "pending" || i.answer === "accepted")) return { cancelled: null };
  return { cancelled: await cancelExpired(tx, p) };
}

/** Everyone has answered, at least two are seated, and every seated player is in the lobby: start now. */
export async function challengeReady(partyId: string, inLobby: ReadonlySet<string>): Promise<boolean> {
  const [p] = await db.select().from(parties).where(eq(parties.id, partyId));
  const rows = p ? await challengeOf(db, partyId) : null;
  if (!p || !rows || p.status !== "open" || !rows.challenge.windowOpensAt) return false;
  if (rows.invitees.some((i) => i.answer === "pending")) return false;
  const seated = await db.select({ userId: partyPlayers.userId }).from(partyPlayers).where(eq(partyPlayers.partyId, partyId));
  return seated.length >= CHALLENGE_MIN_PLAYERS && seated.every((s) => inLobby.has(s.userId));
}

/**
 * Halfway through the join window: a challenge_join_reminder to everyone seated who isn't in the lobby, and to
 * anyone still asked. Once per person per challenge. Returns how many were recorded.
 */
export async function remindChallenge(partyId: string, inLobby: ReadonlySet<string>, now = new Date()): Promise<number> {
  const [p] = await db.select().from(parties).where(eq(parties.id, partyId));
  const rows = p ? await challengeOf(db, partyId) : null;
  const closesAt = rows?.challenge.windowClosesAt;
  if (!p || !rows || p.status !== "open" || !closesAt || now >= closesAt) return 0;
  const minutesLeft = Math.max(1, Math.round((closesAt.getTime() - now.getTime()) / MINUTE_MS));
  const seated = (await db.select({ userId: partyPlayers.userId }).from(partyPlayers).where(eq(partyPlayers.partyId, partyId))).map((s) => s.userId);
  const targets = [
    ...seated.filter((id) => !inLobby.has(id)).map((id) => ({ id, accepted: true })),
    ...rows.invitees.filter((i) => i.answer === "pending").map((i) => ({ id: i.userId, accepted: false })),
  ];
  for (const t of targets) {
    await nudge(db, {
      userId: t.id, kind: "challenge_join_reminder", ref: { type: "party", id: partyId }, dedupeKey: `challenge_join_reminder:${partyId}:${t.id}`,
      about: [rows.challenge.challengerUserId].filter((id) => id !== t.id), data: { partyId, title: p.title, minutesLeft, accepted: t.accepted },
    }, now);
  }
  return targets.length;
}

/** A challenge is joined by accepting it: /join and extra invites refuse it. */
export async function assertNotChallenge(conn: Conn, partyId: string): Promise<void> {
  if (await isChallenge(conn, partyId)) throw challengeError(409, CHALLENGE_ACCEPT_REQUIRED);
}

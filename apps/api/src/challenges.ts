/**
 * Challenges in the API (ADR 0019): who can be challenged, what a challenge body may be, the preset the builder
 * starts from, and the card each person sees. The rows and their answers live in packages/db/src/challenges.ts.
 */
import { and, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import {
  CANNOT_CHALLENGE, CATEGORIES, CHALLENGE_EXPIRED_MESSAGE, CHALLENGE_NOT_ALLOWED, CHALLENGE_OUT_OF_RANGE, CHALLENGE_PRESET_QUESTIONS, CHALLENGE_REFUSALS, TOO_MANY_CHALLENGES,
  challengeBrief, challengeRangeProblem, challengeState, lagosDay, partyHereKey,
  type Category, type ChatMessage, type PartyCancelledEvent, type ChallengeCard, type ChallengeFields, type ChallengePreset, type ChallengeTopic, type CreatePartyInput,
} from "@contestly/shared";
import {
  challengeOf, db, dmPermissionBetween, getChallengeConfig, getPartyConfig, getSocialConfig, isBanned, liveUser, parties, partyPlayers, users,
  type Acting, type ChallengeInvitee, type PartyChallenge, type User,
} from "@contestly/db";
import { PARTY_EVENTS_CHANNEL, partyQueue } from "@contestly/queue";
import { httpError } from "./httpError.js";
import { publishLine } from "./chats.js";
import { limit, valkey } from "./redis.js";
import { toPerson } from "./people.js";

const DAY_SECONDS = 86_400;
const TOPICS_PER_REASON = 3;
/** Finished parties looked at for "last party's topic" and the invitees' recent categories. */
const RECENT_PARTIES = 20;

const partyJobs = partyQueue();

/** A challenge ended unplayed in a request (the last decline, the last acceptor's leave): the room and the chat hear, as with any cancel. */
export async function announceChallengeCancelled(partyId: string, line: ChatMessage) {
  await publishLine(line);
  const ev: PartyCancelledEvent = { partyId, status: "cancelled", by: "system", message: line.text ?? CHALLENGE_EXPIRED_MESSAGE };
  await valkey().publish(PARTY_EVENTS_CHANNEL, JSON.stringify(ev));
}

/** Someone's answer or seat changed: the worker starts it if everyone left to come is in the lobby. */
export const queueChallengeReady = (partyId: string) => partyJobs.add("challenge_ready", { kind: "challenge_ready", partyId });

const isCategory = (s: string | null | undefined): s is Category => !!s && (CATEGORIES as readonly string[]).includes(s);

/** Signed-up, live accounts by id (guests, system and deleted ones never). */
async function peopleById(ids: string[]): Promise<User[]> {
  if (!ids.length) return [];
  return db.select().from(users).where(and(inArray(users.id, ids), eq(users.isGuest, false), eq(users.isSystem, false), liveUser));
}

/** May `me` challenge them: the DM rule (blocks included), and never a brand or a banned account. */
async function challengeable(me: User, them: User): Promise<ChallengeInvitee | null> {
  if (them.isBrand || isBanned(them)) return null;
  const permission = await dmPermissionBetween(db, me, them);
  return permission === "refused" ? null : { user: them, permission };
}

/**
 * Before a challenge party is made: what it may be (sealed, the challenger playing, pooled or free, no crew or own
 * invite list, not as a brand), the admin's ranges, everyone asked can be challenged, and the day's send limit.
 * Returns the invitees with their DM permission, for the card.
 */
export async function checkChallenge(me: User, body: CreatePartyInput, brand: Acting | null | undefined): Promise<ChallengeInvitee[]> {
  const c = body.challenge!;
  const refuse = (reason: (typeof CHALLENGE_REFUSALS)[number]) => httpError(422, CHALLENGE_NOT_ALLOWED, { reason });
  if (brand) throw refuse("as_brand");
  if (body.mode !== "sealed" || body.hostQuestions.length) throw refuse("curate");
  if (body.funding !== "pooled") throw refuse("stakes");
  if (body.crewId) throw refuse("crew");
  if (body.inviteUserIds.length) throw refuse("invite_list");
  const problem = challengeRangeProblem(c, await getChallengeConfig());
  if (problem) throw httpError(422, CHALLENGE_OUT_OF_RANGE, problem);
  const found = new Map((await peopleById(c.invitees)).map((u) => [u.id, u]));
  const invitees: ChallengeInvitee[] = [];
  for (const id of c.invitees) {
    const them = found.get(id);
    const ok = them && id !== me.id ? await challengeable(me, them) : null;
    if (!ok) throw httpError(403, CANNOT_CHALLENGE, { userId: id });
    invitees.push(ok);
  }
  const { challengesPerDay } = await getSocialConfig();
  await limit("challenge", `${me.id}:${lagosDay()}`, challengesPerDay, DAY_SECONDS, TOO_MANY_CHALLENGES);
  return invitees;
}

/**
 * A challenge's rematch (ADR 0019): the same expiry, window and message (each kept inside today's ranges), to the
 * other players who can still be challenged. 403 cannot_challenge when nobody can.
 */
export async function rematchChallenge(me: User, was: PartyChallenge, playerIds: string[]): Promise<ChallengeFields> {
  const cfg = await getChallengeConfig();
  const others = await peopleById(playerIds.filter((id) => id !== me.id));
  const invitees = (await Promise.all(others.map((u) => challengeable(me, u)))).filter((x): x is ChallengeInvitee => !!x).map((x) => x.user.id);
  if (!invitees.length) throw httpError(403, CANNOT_CHALLENGE, { userId: others[0]?.id ?? null });
  const clamp = (n: number, r: { min: number; max: number }) => Math.min(r.max, Math.max(r.min, n));
  const expiry = Math.round((was.inviteExpiresAt.getTime() - was.createdAt.getTime()) / 60_000);
  return {
    invitees, inviteExpiresInMinutes: clamp(expiry, cfg.inviteExpiryMinutes), joinWindowMinutes: clamp(was.joinWindowMinutes, cfg.joinWindowMinutes),
    ...(was.message ? { message: was.message } : {}),
  };
}

/** A challenge's seats: the challenger and everyone asked, or the party limits' minimum if that's more. */
export async function challengeSeats(inviteeCount: number): Promise<number> {
  const { limits } = await getPartyConfig();
  return Math.max(inviteeCount + 1, limits.seatsMin);
}

/** Lanes everyone shares, the last party played together, and the invitees' recent categories. */
async function suggestedTopics(me: User, them: User[]): Promise<ChallengeTopic[]> {
  const topics: ChallengeTopic[] = [];
  const shared = me.interests.filter((l) => them.every((t) => t.interests.includes(l))).slice(0, TOPICS_PER_REASON);
  for (const lane of shared) topics.push({ reason: "shared_lane", label: lane, brief: challengeBrief([lane], [lane]).brief, category: isCategory(lane) ? lane : null });
  const ids = them.map((t) => t.id);
  const mine = db.select({ partyId: partyPlayers.partyId }).from(partyPlayers).where(eq(partyPlayers.userId, me.id));
  const [last] = ids.length ? await db.select({ title: parties.title, brief: parties.brief, category: parties.category }).from(parties)
    .innerJoin(partyPlayers, eq(partyPlayers.partyId, parties.id))
    .where(and(eq(parties.status, "finished"), inArray(partyPlayers.userId, ids), inArray(parties.id, mine)))
    .orderBy(desc(parties.endedAt)).limit(1) : [];
  if (last) topics.push({ reason: "last_party", label: last.title, brief: last.brief, category: isCategory(last.category) ? last.category : null });
  const recent = ids.length ? await db.select({ category: parties.category }).from(parties).innerJoin(partyPlayers, eq(partyPlayers.partyId, parties.id))
    .where(and(eq(parties.status, "finished"), inArray(partyPlayers.userId, ids), isNotNull(parties.category), ne(parties.category, last?.category ?? "")))
    .orderBy(desc(parties.endedAt)).limit(RECENT_PARTIES) : [];
  const seen = new Set(topics.map((t) => t.category));
  for (const { category } of recent) {
    if (!isCategory(category) || seen.has(category) || topics.filter((t) => t.reason === "their_recent").length >= TOPICS_PER_REASON) continue;
    seen.add(category);
    topics.push({ reason: "their_recent", label: category, brief: `A quiz on ${category}`, category });
  }
  return topics;
}

/** GET /challenges/preset: the builder's defaults. Creates nothing. 404 when none of the ids is a person. */
export async function challengePreset(me: User, userIds: string[]): Promise<ChallengePreset> {
  const them = (await peopleById(userIds)).filter((u) => u.id !== me.id);
  if (!them.length) throw httpError(404, "not_found");
  const [cfg, { limits }, invitees, topics] = await Promise.all([
    getChallengeConfig(), getPartyConfig(),
    Promise.all(them.map(async (u) => ({ person: toPerson(u), canChallenge: !!(await challengeable(me, u)) }))),
    suggestedTopics(me, them),
  ]);
  const title = them.length === 1 ? `${me.displayName} vs ${them[0].displayName}` : `${me.displayName}'s challenge`;
  return {
    invitees, topics,
    party: {
      title: title.slice(0, 60), brief: topics[0]?.brief ?? challengeBrief(me.interests, them[0].interests).brief, ...(topics[0]?.category ? { category: topics[0].category } : {}), questionCount: CHALLENGE_PRESET_QUESTIONS, entryKobo: 0,
      funding: "pooled", visibility: "private", mode: "sealed", maxPlayers: Math.max(them.length + 1, limits.seatsMin), split: limits.splits[0],
    },
    challenge: { inviteExpiresInMinutes: cfg.inviteExpiryMinutes.default, joinWindowMinutes: cfg.joinWindowMinutes.default },
    ranges: cfg,
  };
}

/** Who's connected to the party's room right now (the room's own presence, never claimed). */
export async function inLobby(partyId: string): Promise<string[]> {
  return Object.entries(await valkey().hgetall(partyHereKey(partyId))).filter(([, n]) => Number(n) > 0).map(([id]) => id);
}

/** The card from the viewer's side (GET /challenges/:partyId): the challenger and everyone asked; 404 for anyone else. */
export async function challengeCard(partyId: string, viewer: User, now = new Date()): Promise<ChallengeCard> {
  const [p] = await db.select().from(parties).where(eq(parties.id, partyId));
  const rows = p ? await challengeOf(db, partyId) : null;
  if (!p || !rows) throw httpError(404, "not_found");
  const { challenge, invitees } = rows;
  const mine = invitees.find((i) => i.userId === viewer.id);
  if (!mine && challenge.challengerUserId !== viewer.id) throw httpError(404, "not_found");
  const people = new Map((await db.select().from(users).where(inArray(users.id, [challenge.challengerUserId, ...invitees.map((i) => i.userId)]))).map((u) => [u.id, toPerson(u)]));
  const lobby = challenge.windowOpensAt && p.status === "open" ? await inLobby(partyId) : [];
  const state = challengeState({
    partyStatus: p.status as "open" | "live" | "finished" | "cancelled", ending: challenge.ending ?? null, windowOpen: !!challenge.windowOpensAt,
    inviteExpiresAt: challenge.inviteExpiresAt, myAnswer: mine?.answer ?? null, now,
  });
  const iso = (d: Date | null) => d?.toISOString() ?? null;
  return {
    partyId, title: p.title, message: challenge.message, challenger: people.get(challenge.challengerUserId)!, entryKobo: p.entryKobo, state, now: now.toISOString(),
    inviteExpiresAt: challenge.inviteExpiresAt.toISOString(), joinWindowMinutes: challenge.joinWindowMinutes, joinClosesAt: iso(challenge.windowClosesAt),
    invitees: invitees.map((i) => ({ person: people.get(i.userId)!, answer: i.answer, answeredAt: iso(i.answeredAt) })),
    inLobby: lobby,
    you: { role: mine ? "invitee" : "challenger", answer: mine?.answer ?? null, canAnswer: !!mine && mine.answer === "pending" && (state === "pending" || state === "accepted") },
  };
}

/**
 * Social (row 6b) against the real database: crews (invites only from people you're connected to, roles,
 * hand-over, archive, privacy, the cap), party points (bragging-rights parties only, the daily cap), the
 * friends board, the feed's privacy, Challenge and Rematch.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  db, dmPermissionBetween, feedEvents, follows, parties, partyDays, partyInvites, partyPlayers, recordPartyFinish, setSocialConfig, sql, type Party, type User,
} from "@contestly/db";
import {
  crewInviteAnswerResponseSchema, crewInvitedResponseSchema, crewLeaveResponseSchema, crewRemoveResponseSchema, crewRoleResponseSchema, DEFAULT_SOCIAL_CONFIG, lagosDay,
} from "@contestly/shared";
import { as, makeUser, testApp } from "./harness.js";

let app: Awaited<ReturnType<typeof testApp>>["app"];
let ada: User, kemi: User, tunde: User, zee: User, stranger: User, guest: User;

const follow = (a: User, b: User) => db.insert(follows).values({ followerId: a.id, followeeId: b.id }).onConflictDoNothing();

/** A finished party written straight to the database, with these seats and ranks. */
async function finishedParty(host: User, seats: [User, number][], over: Partial<typeof parties.$inferInsert> = {}): Promise<Party> {
  const [p] = await db.insert(parties).values({
    createdByUserId: host.id, title: "Test party", brief: "general knowledge", category: "General knowledge", entryKobo: 0, maxPlayers: 10,
    funding: "pooled", split: [100], status: "finished", startsAt: new Date(), endedAt: new Date(), ...over,
  }).returning();
  for (const [u, rank] of seats) await db.insert(partyPlayers).values({ partyId: p.id, userId: u.id, rank, score: 100 - rank });
  return p;
}
const seatsOf = (seats: [User, number][]) => seats.map(([u, rank]) => ({ userId: u.id, rank, isGuest: u.isGuest, bannedAt: null }));

beforeAll(async () => {
  ({ app } = await testApp());
  ada = await makeUser("ada", { interests: ["Football", "Afrobeats"] });
  kemi = await makeUser("kemi", { interests: ["Afrobeats"] });
  tunde = await makeUser("tunde");
  zee = await makeUser("zee");
  stranger = await makeUser("stranger");
  guest = await makeUser("guest", { isGuest: true, email: null, emailVerifiedAt: null });
  for (const u of [kemi, tunde, zee]) await follow(ada, u);
  await follow(kemi, tunde);
});

afterAll(async () => {
  await setSocialConfig(DEFAULT_SOCIAL_CONFIG);
  await app.close();
  await sql.end();
});

describe("crews", () => {
  let crewId: string;

  it("can't invite someone you aren't connected to", async () => {
    const res = await app.inject({ method: "POST", url: "/crews", headers: as(ada), payload: { name: "Office quiz squad", inviteUserIds: [stranger.id] } });
    expect(res.json().error).toBe("cannot_invite");
  });

  it("starts with its creator, and invites wait for an answer", async () => {
    const res = await app.inject({ method: "POST", url: "/crews", headers: as(ada), payload: { name: "Office quiz squad", inviteUserIds: [kemi.id, tunde.id] } });
    expect(res.statusCode).toBe(201);
    crewId = crewInvitedResponseSchema.parse(res.json()).id;
    expect(res.json()).toMatchObject({ myRole: "creator", memberCount: 1, invited: 2 });
    expect(res.json().pendingInvites).toHaveLength(2);
    expect((await app.inject({ url: "/me/crew-invites", headers: as(kemi) })).json()[0].crew.id).toBe(crewId);
  });

  it("is invisible to anyone outside it, and closed to guests", async () => {
    expect((await app.inject({ url: `/crews/${crewId}`, headers: as(kemi) })).statusCode).toBe(404);
    expect((await app.inject({ url: `/crews/${crewId}/board`, headers: as(stranger) })).statusCode).toBe(404);
    expect((await app.inject({ url: "/crews", headers: as(guest) })).json().error).toBe("sign_up_required");
  });

  it("takes in whoever accepts", async () => {
    for (const u of [kemi, tunde]) {
      const answer = crewInviteAnswerResponseSchema.parse((await app.inject({ method: "POST", url: `/crews/${crewId}/invite/accept`, headers: as(u) })).json());
      expect(answer).toMatchObject({ joined: true, crew: { id: crewId, myRole: "member" } });
    }
    const detail = (await app.inject({ url: `/crews/${crewId}`, headers: as(kemi) })).json();
    expect(detail.memberCount).toBe(3);
    expect(detail.pendingInvites).toEqual([]); // members don't see invites
  });

  it("makes crewmates able to message each other directly", async () => {
    expect(await dmPermissionBetween(db, tunde, kemi)).toBe("direct"); // kemi follows tunde
    expect(await dmPermissionBetween(db, kemi, ada)).toBe("direct"); // only the crew connects them
  });

  it("lets only the creator and admins invite, and only the creator promote", async () => {
    expect((await app.inject({ method: "POST", url: `/crews/${crewId}/invites`, headers: as(kemi), payload: { userIds: [tunde.id] } })).json().error).toBe("crew_admins_only");
    expect((await app.inject({ method: "PATCH", url: `/crews/${crewId}/members/${tunde.id}`, headers: as(kemi), payload: { role: "admin" } })).json().error).toBe("creator_only");
    const promoted = crewRoleResponseSchema.parse((await app.inject({ method: "PATCH", url: `/crews/${crewId}/members/${kemi.id}`, headers: as(ada), payload: { role: "admin" } })).json());
    expect(promoted).toMatchObject({ person: { id: kemi.id }, role: "admin", crowned: false });
    await follow(kemi, zee);
    const sent = await app.inject({ method: "POST", url: `/crews/${crewId}/invites`, headers: as(kemi), payload: { userIds: [zee.id] } });
    expect(sent.statusCode).toBe(201);
    expect(crewInvitedResponseSchema.parse(sent.json())).toMatchObject({ invited: 1, myRole: "admin" });
    expect(sent.json().pendingInvites.map((p: { id: string }) => p.id)).toContain(zee.id);
  });

  it("holds to its cap, pending invites included", async () => {
    await setSocialConfig({ ...DEFAULT_SOCIAL_CONFIG, crewMaxMembers: 4 }); // 3 members + zee's pending invite
    await follow(ada, stranger);
    expect((await app.inject({ method: "POST", url: `/crews/${crewId}/invites`, headers: as(ada), payload: { userIds: [stranger.id] } })).json().error).toBe("crew_full");
    await setSocialConfig(DEFAULT_SOCIAL_CONFIG);
  });

  it("lets the creator remove someone", async () => {
    const removed = crewRemoveResponseSchema.parse((await app.inject({ method: "DELETE", url: `/crews/${crewId}/members/${tunde.id}`, headers: as(ada) })).json());
    expect(removed.crew.members.some((m) => m.person.id === tunde.id)).toBe(false);
    expect((await app.inject({ url: `/crews/${crewId}`, headers: as(tunde) })).statusCode).toBe(404);
  });

  it("hands over to the longest-standing admin when the creator leaves, and archives when the last one goes", async () => {
    await app.inject({ method: "POST", url: `/crews/${crewId}/invite/accept`, headers: as(zee) });
    const left = crewLeaveResponseSchema.parse((await app.inject({ method: "POST", url: `/crews/${crewId}/leave`, headers: as(ada) })).json());
    expect(left).toMatchObject({ left: true, archived: false, newCreator: { id: kemi.id } });
    const detail = (await app.inject({ url: `/crews/${crewId}`, headers: as(zee) })).json();
    expect(detail.members.find((m: { person: { id: string } }) => m.person.id === kemi.id).role).toBe("creator");
    await app.inject({ method: "POST", url: `/crews/${crewId}/leave`, headers: as(kemi) });
    expect(detail.members.length).toBe(2);
    expect((await app.inject({ method: "POST", url: `/crews/${crewId}/leave`, headers: as(zee) })).json()).toEqual({ left: true, archived: true, newCreator: null });
  });
});

describe("party points", () => {
  it("come from bragging-rights parties only", async () => {
    const seats: [User, number][] = [[ada, 1], [kemi, 2], [tunde, 3]];
    const staked = await finishedParty(ada, seats, { entryKobo: 10_000 });
    const free = await finishedParty(ada, seats);
    await db.transaction((tx) => recordPartyFinish(tx, staked, seatsOf(seats)));
    await db.transaction((tx) => recordPartyFinish(tx, free, seatsOf(seats)));
    const [row] = await db.select().from(partyDays).where(and(eq(partyDays.userId, ada.id), eq(partyDays.day, lagosDay())));
    expect(row).toMatchObject({ points: 50, parties: 1, wins: 1 });
  });

  it("stop at the daily cap", async () => {
    const seats: [User, number][] = [[zee, 1], [kemi, 2], [tunde, 3]];
    for (let i = 0; i < DEFAULT_SOCIAL_CONFIG.partyPointsDailyCap + 2; i++) {
      const p = await finishedParty(zee, seats);
      await db.transaction((tx) => recordPartyFinish(tx, p, seatsOf(seats)));
    }
    const [row] = await db.select().from(partyDays).where(and(eq(partyDays.userId, zee.id), eq(partyDays.day, lagosDay())));
    expect(row.parties).toBe(DEFAULT_SOCIAL_CONFIG.partyPointsDailyCap);
  });

  it("show on the friends board with the Climb's points", async () => {
    const board = (await app.inject({ url: "/leaderboards/friends", headers: as(ada) })).json();
    const me = board.rows.find((r: { isMe: boolean }) => r.isMe);
    expect(me).toMatchObject({ parties: 50, total: 50, climb: 0 });
    expect(board.rows.some((r: { person: { id: string } }) => r.person.id === stranger.id)).toBe(false);
  });
});

describe("the feed", () => {
  it("shows a private party's finish only to people who were in it", async () => {
    const p = await finishedParty(tunde, [[tunde, 1], [kemi, 2]], { visibility: "private", title: "Secret squad" });
    await db.transaction((tx) => recordPartyFinish(tx, p, seatsOf([[tunde, 1], [kemi, 2]])));
    const seen = (u: User) => app.inject({ url: "/feed", headers: as(u) }).then((r) => r.json().events.some((e: { data: { partyId?: string } }) => e.data.partyId === p.id));
    expect(await seen(kemi)).toBe(true); // kemi follows tunde and played
    expect(await seen(ada)).toBe(false); // ada follows tunde but wasn't there
  });

  it("never carries money", async () => {
    const rows = await db.select().from(feedEvents).where(eq(feedEvents.userId, ada.id));
    expect(JSON.stringify(rows.map((r) => r.data))).not.toMatch(/kobo|prize|naira|₦/i);
  });
});

describe("challenge", () => {
  it("makes a private free party, invites them and posts it in your DM", async () => {
    const res = await app.inject({ method: "POST", url: `/users/${kemi.id}/challenge`, headers: as(ada) });
    expect(res.statusCode).toBe(201);
    const [p] = await db.select().from(parties).where(eq(parties.id, res.json().partyId));
    expect(p).toMatchObject({ visibility: "private", entryKobo: 0, category: "Afrobeats" });
    expect(p.title).toBe(`${ada.displayName} vs ${kemi.displayName}`);
    expect((await db.select().from(partyInvites).where(and(eq(partyInvites.partyId, p.id), eq(partyInvites.inviteeId, kemi.id)))).length).toBe(1);
    const thread = (await app.inject({ url: `/chats/${res.json().threadId}/messages`, headers: as(kemi) })).json();
    expect(thread.messages.at(-1)).toMatchObject({ kind: "party_card", partyId: p.id });
  });

  it("is refused for guests", async () => {
    expect((await app.inject({ method: "POST", url: `/users/${guest.id}/challenge`, headers: as(ada) })).statusCode).toBe(404);
  });
});

describe("rematch", () => {
  it("is one party everyone lands in, open only to who played", async () => {
    const p = await finishedParty(ada, [[ada, 1], [kemi, 2], [tunde, 3]], { title: "Friday night" });
    expect((await app.inject({ method: "POST", url: `/parties/${p.id}/rematch`, headers: as(zee) })).json().error).toBe("not_in_party");
    const first = await app.inject({ method: "POST", url: `/parties/${p.id}/rematch`, headers: as(kemi) });
    expect(first.statusCode).toBe(201);
    const again = await app.inject({ method: "POST", url: `/parties/${p.id}/rematch`, headers: as(tunde) });
    expect(again.json()).toEqual({ partyId: first.json().partyId, created: false });
    const [r] = await db.select().from(parties).where(eq(parties.id, first.json().partyId));
    expect(r).toMatchObject({ title: "Rematch: Friday night", rematchOf: p.id, funding: "pooled" });
    const invited = await db.select({ id: partyInvites.inviteeId }).from(partyInvites).where(eq(partyInvites.partyId, r.id));
    expect(invited.map((i) => i.id).sort()).toEqual([ada.id, tunde.id].sort());
  });
});

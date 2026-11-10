/**
 * Challenges (ADR 0019) against the real database: the preset; creating one within and outside the admin's ranges;
 * who can't be challenged; accepting (the lobby and its window); the early start once everyone is in; a partial
 * start with several invitees, the challenger counted like anyone; leaving after accepting; expiry before an answer; a join window that runs out; declining; an entry charged and
 * refunded; each nudge; a rematch; and the admin config.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  adminActions, chatMessages, db, getChallengeConfig, ledger, nudges, parties, partyChallengeInvitees, partyChallenges, partyPlayers, partyThreadId, sql, type User,
} from "@contestly/db";
import { DEFAULT_CHALLENGE_CONFIG, kobo, lagosDay, partyHereKey, type NudgeKind } from "@contestly/shared";
import { valkey } from "../src/redis.js";
import { as, makeBrand, makeUser, testApp } from "./harness.js";
import { runChallengeJob } from "../../worker/src/challenges.js";
import { startOrCancel, type StartDeps } from "../../worker/src/partyStart.js";

let app: Awaited<ReturnType<typeof testApp>>["app"];
let n = 0;
const person = (p: string, extra: Partial<User> = {}) => makeUser(`ch${p}${++n}`, extra);
const call = (u: User, method: "GET" | "POST" | "PUT", url: string, payload?: object) => app.inject({ method, url, headers: as(u), payload });
const ENTRY = kobo(100);

/** A challenge body: the preset's shape with these invitees; `over` changes the party, `challenge` the challenge. */
const body = (invitees: User[], over: Record<string, unknown> = {}, challenge: Record<string, unknown> = {}) => ({
  title: "Ada vs Kemi", brief: "Afrobeats in the 2010s", entryKobo: 0, maxPlayers: 2, funding: "pooled", split: "winner", questionCount: 5, visibility: "private",
  ...over, challenge: { invitees: invitees.map((u) => u.id), inviteExpiresInMinutes: 60, joinWindowMinutes: 10, ...challenge },
});
async function challenge(from: User, invitees: User[], over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const res = await call(from, "POST", "/parties", body(invitees, over, extra));
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}
const card = async (u: User, partyId: string) => (await call(u, "GET", `/challenges/${partyId}`)).json();
const accept = (u: User, partyId: string) => call(u, "POST", `/challenges/${partyId}/accept`);
const decline = (u: User, partyId: string) => call(u, "POST", `/challenges/${partyId}/decline`);
const partyOf = async (id: string) => (await db.select().from(parties).where(eq(parties.id, id)))[0];
const seated = async (id: string) => (await db.select({ userId: partyPlayers.userId }).from(partyPlayers).where(eq(partyPlayers.partyId, id))).map((s) => s.userId).sort();
const nudgesOf = (u: User, kind: NudgeKind) => db.select().from(nudges).where(and(eq(nudges.userId, u.id), eq(nudges.kind, kind)));
const fund = (u: User, amountKobo: number) => db.transaction((tx) => ledger.post(tx, { userId: u.id, kind: "cash", amountKobo, type: "topup", idempotencyKey: `t:ch:${u.id}:${++n}` }));
const cash = async (u: User) => (await ledger.balances(u.id)).cashKobo;
/** The party chat's lines (several written in one transaction share a time, so no order is asserted). */
const partyLines = async (partyId: string) =>
  (await db.select({ text: chatMessages.text }).from(chatMessages).where(eq(chatMessages.threadId, await partyThreadId(db, partyId)))).map((l) => l.text);
/** Move a challenge's clocks into the past, as if time had passed. */
const expireInvites = (partyId: string) => db.update(partyChallenges).set({ inviteExpiresAt: new Date(Date.now() - 1000) }).where(eq(partyChallenges.partyId, partyId));
const closeWindow = async (partyId: string) => {
  const past = new Date(Date.now() - 1000);
  await db.update(partyChallenges).set({ windowClosesAt: past }).where(eq(partyChallenges.partyId, partyId));
  await db.update(parties).set({ startsAt: past }).where(eq(parties.id, partyId));
};

/** The worker's side, with the lobby's presence given by the test. */
function worker(here: User[]) {
  const emitted: unknown[] = [];
  const deps: StartDeps = {
    emit: async (ev) => emitted.push(ev), publishLine: async () => undefined, queueQuestions: async () => undefined, queueWatchdog: async () => undefined,
    inLobby: async () => new Set(here.map((u) => u.id)),
  };
  return { deps, emitted };
}
/** The room's presence as the API reads it for the card. */
const inRoom = (partyId: string, ...here: User[]) => Promise.all(here.map((u) => valkey().hset(partyHereKey(partyId), u.id, 1)));

beforeAll(async () => { ({ app } = await testApp()); });
afterAll(async () => {
  await app.close();
  await sql.end();
});

describe("the preset", () => {
  it("suggests the lanes you share, your last party's topic and their recent categories, with quick, free, private defaults; creates nothing", async () => {
    const ada = await person("ada", { interests: ["Afrobeats", "Football"] });
    const kemi = await person("kemi", { interests: ["Afrobeats", "Nollywood"] });
    const [last] = await db.insert(parties).values({ createdByUserId: ada.id, title: "Jollof wars", brief: "Who makes the best jollof", category: "Food", maxPlayers: 4, funding: "pooled", split: [100], status: "finished", startsAt: new Date(), endedAt: new Date(), questionsStatus: "ready" }).returning();
    await db.insert(partyPlayers).values([{ partyId: last.id, userId: ada.id }, { partyId: last.id, userId: kemi.id }]);
    const [theirs] = await db.insert(parties).values({ createdByUserId: kemi.id, title: "Movie night", brief: "Nollywood classics", category: "Nollywood", maxPlayers: 4, funding: "pooled", split: [100], status: "finished", startsAt: new Date(), endedAt: new Date(Date.now() - 60_000), questionsStatus: "ready" }).returning();
    await db.insert(partyPlayers).values({ partyId: theirs.id, userId: kemi.id });
    const before = (await db.select().from(parties).where(eq(parties.createdByUserId, ada.id))).length;

    const res = await call(ada, "GET", `/challenges/preset?userIds=${kemi.id}`);
    expect(res.statusCode, res.body).toBe(200);
    const preset = res.json();
    expect(preset.topics.map((t: { reason: string; label: string }) => [t.reason, t.label])).toEqual([["shared_lane", "Afrobeats"], ["last_party", "Jollof wars"], ["their_recent", "Nollywood"]]);
    expect(preset.party).toMatchObject({ title: `${ada.displayName} vs ${kemi.displayName}`, questionCount: 5, entryKobo: 0, funding: "pooled", visibility: "private", mode: "sealed", maxPlayers: 2, brief: "A head-to-head quiz on Afrobeats" });
    expect(preset.challenge).toEqual({ inviteExpiresInMinutes: 1440, joinWindowMinutes: 10 });
    expect(preset.ranges).toEqual(DEFAULT_CHALLENGE_CONFIG);
    expect(preset.invitees).toEqual([{ person: expect.objectContaining({ id: kemi.id }), canChallenge: true }]);
    expect((await db.select().from(parties).where(eq(parties.createdByUserId, ada.id))).length).toBe(before);
    // Someone who blocked you shows as not challengeable; nobody real is a 404.
    const blocker = await person("blk");
    await call(blocker, "POST", `/users/${ada.id}/block`);
    expect((await call(ada, "GET", `/challenges/preset?userIds=${blocker.id}`)).json().invitees[0].canChallenge).toBe(false);
    expect((await call(ada, "GET", `/challenges/preset?userIds=${ada.id}`)).statusCode).toBe(404);
  });
});

describe("creating a challenge", () => {
  it("within the ranges: a private sealed party, the card in their DM with the message, the challenger seated", async () => {
    const ada = await person("ada");
    const kemi = await person("kemi");
    const id = await challenge(ada, [kemi], { visibility: "public", maxPlayers: 9 }, { message: "Bet you can't beat me" });
    const p = await partyOf(id);
    const [c] = await db.select().from(partyChallenges).where(eq(partyChallenges.partyId, id));
    expect(p).toMatchObject({ visibility: "private", mode: "sealed", maxPlayers: 2 });
    expect(p.startsAt.getTime()).toBe(c.inviteExpiresAt.getTime() + 10 * 60_000);
    expect(await seated(id)).toEqual([ada.id]);
    const [invite] = await db.select().from(partyChallengeInvitees).where(eq(partyChallengeInvitees.partyId, id));
    const [line] = await db.select().from(chatMessages).where(eq(chatMessages.threadId, invite.threadId));
    expect(line).toMatchObject({ kind: "party_card", cardPartyId: id, userId: ada.id, text: "Bet you can't beat me" });
    expect(await card(kemi, id)).toMatchObject({ state: "pending", message: "Bet you can't beat me", joinClosesAt: null, you: { role: "invitee", answer: "pending", canAnswer: true } });
    expect(await card(ada, id)).toMatchObject({ state: "pending", you: { role: "challenger", canAnswer: false } });
    expect((await call(await person("x"), "GET", `/challenges/${id}`)).statusCode).toBe(404);
  });

  it("outside the ranges, or what a challenge can't be, is refused; so is the day's limit", async () => {
    const ada = await person("ada");
    const kemi = await person("kemi");
    const send = (over: Record<string, unknown>, extra: Record<string, unknown>) => call(ada, "POST", "/parties", body([kemi], over, extra));
    expect((await send({}, { inviteExpiresInMinutes: 59 })).json()).toMatchObject({ error: "challenge_out_of_range", details: { field: "inviteExpiresInMinutes", min: 60, max: 2880 } });
    expect((await send({}, { inviteExpiresInMinutes: 2881 })).json().error).toBe("challenge_out_of_range");
    expect((await send({}, { joinWindowMinutes: 4 })).json()).toMatchObject({ error: "challenge_out_of_range", details: { field: "joinWindowMinutes", min: 5, max: 60 } });
    expect((await send({}, { joinWindowMinutes: 61 })).json().error).toBe("challenge_out_of_range");
    expect((await send({ mode: "curate" }, {})).json()).toMatchObject({ error: "challenge_not_allowed", details: { reason: "curate" } });
    expect((await send({ funding: "host", hostPoolKobo: kobo(1000) }, {})).json()).toMatchObject({ error: "challenge_not_allowed", details: { reason: "stakes" } });
    expect((await send({ inviteUserIds: [kemi.id] }, {})).json()).toMatchObject({ error: "challenge_not_allowed", details: { reason: "invite_list" } });
    const owner = await person("own", { phone: `+2348${String(Date.now()).slice(-9)}`, phoneVerifiedAt: new Date() });
    const brand = await makeBrand(owner, { verified: true });
    const asBrand = await app.inject({ method: "POST", url: "/parties", headers: { ...as(owner), "x-act-as": brand.id }, payload: body([kemi]) });
    expect(asBrand.json()).toMatchObject({ error: "challenge_not_allowed", details: { reason: "as_brand" } });
    expect((await send({}, { joinWindowMinutes: 5, inviteExpiresInMinutes: 2880 })).statusCode).toBe(201);
    // The existing daily limit: at the cap, the next one is a 429.
    await valkey().set(`limit:challenge:${ada.id}:${lagosDay()}`, 10, "EX", 60);
    expect((await send({}, {})).json().error).toBe("too_many_challenges");
  });

  it("an invitee who can't be messaged refuses the whole party: blocked either way, a guest, a brand, yourself", async () => {
    const ada = await person("ada");
    const kemi = await person("kemi");
    const blocked = await person("blk");
    await call(ada, "POST", `/users/${blocked.id}/block`);
    const guest = await person("gst", { isGuest: true, email: null, emailVerifiedAt: null });
    const owner = await person("own", { phone: `+2347${String(Date.now()).slice(-9)}`, phoneVerifiedAt: new Date() });
    const brand = await makeBrand(owner);
    const before = (await db.select().from(parties).where(eq(parties.createdByUserId, ada.id))).length;
    for (const who of [blocked, guest, brand, ada]) {
      const res = await call(ada, "POST", "/parties", body([kemi, who]));
      expect([res.statusCode, res.json().error, res.json().details?.userId], who.handle).toEqual([403, "cannot_challenge", who.id]);
    }
    expect((await call(blocked, "POST", "/parties", body([ada]))).json().error).toBe("cannot_challenge");
    expect((await db.select().from(parties).where(eq(parties.createdByUserId, ada.id))).length).toBe(before);
  });
});

describe("answering", () => {
  it("accepting opens the lobby: a seat, the join window, startsAt at its end; /join is refused; a repeat is replayed", async () => {
    const ada = await person("ada");
    const kemi = await person("kemi");
    const id = await challenge(ada, [kemi], {}, { joinWindowMinutes: 15 });
    expect((await call(kemi, "POST", `/parties/${id}/join`)).json().error).toBe("challenge_accept_required");
    expect((await call(ada, "POST", `/parties/${id}/invites`, { userIds: [kemi.id] })).json().error).toBe("challenge_accept_required");
    const res = await accept(kemi, id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ answer: "accepted", replayed: false, card: { state: "accepted", you: { answer: "accepted", canAnswer: false } } });
    expect(await seated(id)).toEqual([ada.id, kemi.id].sort());
    const [c] = await db.select().from(partyChallenges).where(eq(partyChallenges.partyId, id));
    expect(c.windowClosesAt!.getTime() - c.windowOpensAt!.getTime()).toBe(15 * 60_000);
    expect((await partyOf(id)).startsAt.getTime()).toBe(c.windowClosesAt!.getTime());
    await inRoom(id, ada);
    expect(await card(ada, id)).toMatchObject({ state: "accepted", joinClosesAt: c.windowClosesAt!.toISOString(), inLobby: [ada.id] });
    expect((await accept(kemi, id)).json()).toMatchObject({ answer: "accepted", replayed: true });
    expect((await decline(kemi, id)).json()).toMatchObject({ error: "challenge_answered", details: { answer: "accepted" } });
  });

  it("starts as soon as the challenger and everyone who accepted are in the lobby", async () => {
    const ada = await person("ada");
    const kemi = await person("kemi");
    const id = await challenge(ada, [kemi]);
    await accept(kemi, id);
    expect(await runChallengeJob(worker([ada]).deps, "challenge_ready", id)).toBe("waiting");
    expect((await partyOf(id)).status).toBe("open");
    const { deps, emitted } = worker([ada, kemi]);
    expect(await runChallengeJob(deps, "challenge_ready", id)).toBe("live");
    expect((await partyOf(id)).status).toBe("live");
    expect(emitted).toContainEqual({ partyId: id, status: "live" });
    expect((await card(kemi, id)).state).toBe("live");
  });

  it("several invitees: it waits for answers, then at the window's end starts with who's in; no-shows are refunded, the unanswered expire", async () => {
    const ada = await person("ada");
    const [a, b, c, d] = [await person("a"), await person("b"), await person("c"), await person("d")];
    const id = await challenge(ada, [a, b, c, d]);
    expect((await partyOf(id)).maxPlayers).toBe(5);
    await accept(a, id);
    await accept(d, id);
    await decline(b, id);
    // c hasn't answered: everyone in the lobby isn't enough yet.
    expect(await runChallengeJob(worker([ada, a, d]).deps, "challenge_ready", id)).toBe("waiting");
    await closeWindow(id);
    expect(await startOrCancel(worker([ada, a]).deps, id)).toBe("live");
    expect(await seated(id)).toEqual([ada.id, a.id].sort());
    expect((await db.select().from(partyChallengeInvitees).where(eq(partyChallengeInvitees.partyId, id))).map((i) => [i.userId, i.answer]).sort())
      .toEqual([[a.id, "accepted"], [b.id, "declined"], [c.id, "expired"], [d.id, "expired"]].sort());
    expect(await partyLines(id)).toContain(`${d.displayName} didn't make it`);
    expect((await card(c, id)).state).toBe("expired");
    expect((await card(d, id)).state).toBe("expired");
    expect((await card(b, id)).state).toBe("declined");
    expect((await card(ada, id)).state).toBe("live");
    expect((await accept(c, id)).json().error).toBe("challenge_expired");
  });

  it("nobody answers before the invite expires: cancelled and refunded, with \"Challenge expired.\"", async () => {
    const ada = await person("ada");
    const kemi = await person("kemi");
    await fund(ada, ENTRY);
    const id = await challenge(ada, [kemi], { entryKobo: ENTRY });
    expect(await cash(ada)).toBe(0);
    // Not yet: the job leaves it alone.
    expect(await runChallengeJob(worker([]).deps, "challenge_expire", id)).toBe("kept");
    await expireInvites(id);
    const { deps, emitted } = worker([]);
    expect(await runChallengeJob(deps, "challenge_expire", id)).toBe("cancelled");
    expect(await partyOf(id)).toMatchObject({ status: "cancelled", cancelledBy: "system" });
    expect(emitted).toContainEqual({ partyId: id, status: "cancelled" });
    expect(await partyLines(id)).toContain("Challenge expired.");
    expect(await cash(ada)).toBe(ENTRY);
    expect(await card(kemi, id)).toMatchObject({ state: "expired", you: { canAnswer: false } });
    expect((await accept(kemi, id)).json().error).toBe("challenge_expired");
  });

  it("a join window that runs out with too few in the lobby: the no-show refunded, then cancelled and refunded", async () => {
    const ada = await person("ada");
    const kemi = await person("kemi");
    const id = await challenge(ada, [kemi]);
    await accept(kemi, id);
    await closeWindow(id);
    expect(await startOrCancel(worker([ada]).deps, id)).toBe("cancelled");
    expect((await partyOf(id)).status).toBe("cancelled");
    expect(await partyLines(id)).toContain("Challenge expired.");
    expect((await card(ada, id)).state).toBe("expired");
  });

  it("the challenger is just another player at the window's end: absent with two others in, it starts without them, refunded", async () => {
    const ada = await person("ada");
    const [a, b] = [await person("a"), await person("b")];
    for (const u of [ada, a, b]) await fund(u, ENTRY);
    const id = await challenge(ada, [a, b], { entryKobo: ENTRY, maxPlayers: 3 });
    await accept(a, id);
    await accept(b, id);
    await closeWindow(id);
    expect(await startOrCancel(worker([a, b]).deps, id)).toBe("live");
    expect(await seated(id)).toEqual([a.id, b.id].sort());
    expect(await cash(ada)).toBe(ENTRY);
    expect(await partyLines(id)).toContain(`${ada.displayName} didn't make it`);
  });

  it("fewer than two in the lobby at the window's end, the challenger counted: cancelled and everyone refunded", async () => {
    const ada = await person("ada");
    const [a, b] = [await person("a"), await person("b")];
    for (const u of [ada, a, b]) await fund(u, ENTRY);
    const id = await challenge(ada, [a, b], { entryKobo: ENTRY, maxPlayers: 3 });
    await accept(a, id);
    await accept(b, id);
    await closeWindow(id);
    // Two seated players present is the bar; only one is (the challenger's seat doesn't count while they're away).
    expect(await startOrCancel(worker([a]).deps, id)).toBe("cancelled");
    expect(await partyOf(id)).toMatchObject({ status: "cancelled", cancelledBy: "system" });
    expect(await partyLines(id)).toContain("Challenge expired.");
    for (const u of [ada, a, b]) expect(await cash(u)).toBe(ENTRY);
    expect((await card(a, id)).state).toBe("expired");
  });

  it("leaving after accepting: the card shows them as left, refunded, and the start goes on without them", async () => {
    const ada = await person("ada");
    const [a, b] = [await person("a"), await person("b")];
    for (const u of [ada, a, b]) await fund(u, ENTRY);
    const id = await challenge(ada, [a, b], { entryKobo: ENTRY, maxPlayers: 3 });
    await accept(a, id);
    await accept(b, id);
    expect((await call(a, "POST", `/parties/${id}/leave`)).statusCode).toBe(200);
    expect(await cash(a)).toBe(ENTRY);
    expect(await card(a, id)).toMatchObject({ state: "left", you: { answer: "left", canAnswer: false } });
    expect((await card(ada, id)).invitees.find((i: { person: { id: string } }) => i.person.id === a.id).answer).toBe("left");
    expect((await accept(a, id)).json().error).toBe("challenge_answered");
    // Everyone left to come is in: it starts now.
    expect(await runChallengeJob(worker([ada, b]).deps, "challenge_ready", id)).toBe("live");
    expect(await seated(id)).toEqual([ada.id, b.id].sort());
  });

  it("the last acceptor leaving with nobody else asked: cancelled now, everyone refunded", async () => {
    const ada = await person("ada");
    const kemi = await person("kemi");
    for (const u of [ada, kemi]) await fund(u, ENTRY);
    const id = await challenge(ada, [kemi], { entryKobo: ENTRY });
    await accept(kemi, id);
    expect((await call(kemi, "POST", `/parties/${id}/leave`)).statusCode).toBe(200);
    expect(await partyOf(id)).toMatchObject({ status: "cancelled", cancelledBy: "system" });
    expect(await partyLines(id)).toContain("Challenge expired.");
    for (const u of [ada, kemi]) expect(await cash(u)).toBe(ENTRY);
    expect((await card(kemi, id)).state).toBe("left");
    expect((await card(ada, id)).state).toBe("expired");
  });

  it("declining: \"Not this time\" on the card; the last one out cancels and refunds it", async () => {
    const ada = await person("ada");
    const kemi = await person("kemi");
    await fund(ada, ENTRY);
    const id = await challenge(ada, [kemi], { entryKobo: ENTRY });
    const res = await decline(kemi, id);
    expect(res.json()).toMatchObject({ answer: "declined", replayed: false, card: { state: "declined" } });
    const [invite] = await db.select().from(partyChallengeInvitees).where(eq(partyChallengeInvitees.partyId, id));
    const lines = await db.select().from(chatMessages).where(eq(chatMessages.threadId, invite.threadId));
    expect(lines.at(-1)).toMatchObject({ kind: "party_card", userId: kemi.id, text: "Not this time" });
    expect((await partyOf(id)).status).toBe("cancelled");
    expect(await cash(ada)).toBe(ENTRY);
    expect((await card(ada, id)).state).toBe("declined");
    expect((await decline(kemi, id)).json().replayed).toBe(true);
    expect((await accept(kemi, id)).json().error).toBe("challenge_answered");
  });
});

describe("coins", () => {
  it("an equal pooled entry: the challenger pays on send, each invitee on accept (402 without it), all refunded when it ends unplayed", async () => {
    const ada = await person("ada");
    const kemi = await person("kemi");
    const tolu = await person("tolu");
    await fund(ada, ENTRY);
    await fund(kemi, ENTRY);
    const id = await challenge(ada, [kemi, tolu], { entryKobo: ENTRY, maxPlayers: 3 });
    expect(await cash(ada)).toBe(0);
    expect((await accept(tolu, id)).statusCode).toBe(402);
    expect((await accept(kemi, id)).statusCode).toBe(200);
    expect(await cash(kemi)).toBe(0);
    expect((await card(kemi, id)).entryKobo).toBe(ENTRY);
    // The window runs out with only the challenger in: kemi is refunded as a no-show, then the party as too small.
    await closeWindow(id);
    expect(await startOrCancel(worker([ada]).deps, id)).toBe("cancelled");
    expect([await cash(ada), await cash(kemi)]).toEqual([ENTRY, ENTRY]);
  });
});

describe("nudges", () => {
  it("challenge received (push only), accepted to the challenger, and the halfway reminder to anyone not in the lobby", async () => {
    const ada = await person("ada");
    const [kemi, tolu, sade] = [await person("kemi"), await person("tolu"), await person("sade")];
    const id = await challenge(ada, [kemi, tolu, sade], {}, { message: "Your move" });
    for (const u of [kemi, tolu, sade]) {
      expect(await nudgesOf(u, "challenge_received")).toEqual([expect.objectContaining({ category: "people", title: `${ada.displayName} challenged you`, body: "Your move", deepLink: `contestly://chats/dm/${ada.handle}` })]);
    }
    await accept(kemi, id);
    await accept(sade, id);
    expect((await nudgesOf(ada, "challenge_accepted")).map((x) => (x.data as { byName: string }).byName).sort()).toEqual([kemi.displayName, sade.displayName].sort());
    expect((await nudgesOf(ada, "challenge_accepted"))[0]).toMatchObject({ body: "Join the lobby. It starts once everyone's in.", deepLink: `contestly://party/${id}/room` });
    // Halfway: ada and sade are in; kemi (accepted) and tolu (still asked) hear, once.
    expect(await runChallengeJob(worker([ada, sade]).deps, "challenge_remind", id)).toBe(2);
    await runChallengeJob(worker([ada, sade]).deps, "challenge_remind", id);
    const reminded = async (u: User) => (await nudgesOf(u, "challenge_join_reminder")).map((x) => (x.data as { accepted: boolean }).accepted);
    expect([await reminded(kemi), await reminded(tolu), await reminded(ada), await reminded(sade)]).toEqual([[true], [false], [], []]);
  });
});

describe("rematch", () => {
  it("of a challenge is a new challenge with the same settings, from whoever taps it", async () => {
    const ada = await person("ada");
    const kemi = await person("kemi");
    const id = await challenge(ada, [kemi], {}, { inviteExpiresInMinutes: 120, joinWindowMinutes: 20, message: "Again?" });
    await accept(kemi, id);
    await db.update(parties).set({ status: "finished", endedAt: new Date() }).where(eq(parties.id, id));
    const res = await call(kemi, "POST", `/parties/${id}/rematch`);
    expect(res.statusCode, res.body).toBe(201);
    const next = res.json().partyId;
    const [c] = await db.select().from(partyChallenges).where(eq(partyChallenges.partyId, next));
    expect(c).toMatchObject({ challengerUserId: kemi.id, joinWindowMinutes: 20, message: "Again?" });
    expect(Math.round((c.inviteExpiresAt.getTime() - c.createdAt.getTime()) / 60_000)).toBe(120);
    expect((await db.select().from(partyChallengeInvitees).where(eq(partyChallengeInvitees.partyId, next))).map((i) => i.userId)).toEqual([ada.id]);
  });
});

describe("admin config", () => {
  it("sets the ranges and defaults, logged with a reason; the challenger picks within them", async () => {
    const admin = await person("adm", { isAdmin: true });
    const ada = await person("ada");
    const kemi = await person("kemi");
    const before = await getChallengeConfig();
    const narrower = { ...before, joinWindowMinutes: { min: 5, max: 30, default: 15 } };
    try {
      expect((await call(admin, "PUT", "/admin/challenges/config", { config: narrower, reason: "Shorter lobbies" })).json()).toEqual(narrower);
      expect((await call(admin, "PUT", "/admin/challenges/config", { config: { ...before, joinWindowMinutes: { min: 5, max: 30, default: 31 } }, reason: "Bad" })).statusCode).toBe(400);
      expect((await call(ada, "POST", "/parties", body([kemi], {}, { joinWindowMinutes: 31 }))).json()).toMatchObject({ error: "challenge_out_of_range", details: { max: 30 } });
      expect((await call(ada, "GET", `/challenges/preset?userIds=${kemi.id}`)).json().challenge.joinWindowMinutes).toBe(15);
      const [logged] = await db.select().from(adminActions).where(and(eq(adminActions.adminUserId, admin.id), eq(adminActions.action, "config.challenges")));
      expect(logged).toMatchObject({ reason: "Shorter lobbies", after: narrower });
    } finally {
      await call(admin, "PUT", "/admin/challenges/config", { config: before, reason: "Put back after the test" });
    }
  });
});

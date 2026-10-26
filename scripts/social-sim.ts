/**
 * Social sim (row 6b), three fresh people against the running stack:
 *
 * 1. A bragging-rights party played to the end: party points for everyone, finishes in the feed, profiles
 *    with real stats, head-to-head and the DM rule opened by playing together.
 * 2. The friends board (Climb + party points).
 * 3. Rematch: one party for everyone who taps it. Challenge: a private party for two, posted in your DM.
 * 4. A crew: create, invite, accept, crew chat live in the inbox, the crew board, a crew party that invites
 *    the crew, a Climb run that sets a crew record, roles, and the creator leaving.
 * 5. Week close: last week's crew champion wears the crown.
 *
 * TEST-ONLY: the Climb "perfect player" reads round answers from Postgres, and last week's party points are
 * written straight to the database to have a week to close. Run with the stack up: npm run sim:social
 */
import { randomBytes, randomUUID } from "node:crypto";
import { Client, type Room } from "colyseus.js";
import { and, eq } from "drizzle-orm";
import { climbWeekResults, crews, db, partyDays } from "@contestly/db";
import { climbQueue, partyQueue } from "@contestly/queue";
import { INBOX_ROOM, MSG, PARTY_ROOM, addDays, lagosDay, weekOf } from "@contestly/shared";
import { RT, api, call, failureCount, inMinutes, nextClimbRound, ok, rightClimbAnswer, sleep, waitFor, wrongClimbAnswer } from "./sim-lib.js";

const tag = randomBytes(2).toString("hex");
const [A, B, C] = ["ada", "bayo", "chi"].map((n) => `ss${tag}_${n}`);
const ids = new Map<string, string>();
for (const [h, lanes] of [[A, ["Afrobeats", "Football"]], [B, ["Football"]], [C, ["Nollywood"]]] as const) {
  await api(h, "POST", "/me", { displayName: h.split("_")[1], handle: h, interests: lanes });
  ids.set(h, (await api(h, "GET", "/me")).id);
}
const id = (h: string) => ids.get(h)!;

/** Play a free party to the end with everyone in the room, answering nothing (ranks still come out). */
async function playParty(partyId: string, players: string[]) {
  const rooms: Room[] = [];
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  for (const h of players) {
    const room = await new Client(RT).joinOrCreate(PARTY_ROOM, { partyId, devUser: h });
    for (const t of [MSG.phase, MSG.question, MSG.reveal, MSG.standings, MSG.presence, MSG.chatMessage, MSG.questionsStatus, MSG.questionVoided, MSG.error]) room.onMessage(t, () => {});
    room.onMessage(MSG.finalStandings, () => resolveDone());
    rooms.push(room);
  }
  await (await partyQueue().getJob(`start-${partyId}`))?.promote();
  await Promise.race([done, sleep(120_000)]);
  for (const r of rooms) await r.leave().catch(() => {});
  return waitFor(async () => (await api(players[0], "GET", `/parties/${partyId}`)).status === "finished" || null, { tries: 60, everyMs: 500 });
}

const freeParty = (title: string, extra: Record<string, unknown> = {}) => ({
  title, brief: "Nigerian general knowledge: cities, food, music", entryKobo: 0, maxPlayers: 5, funding: "pooled", split: "winner",
  startsAt: inMinutes(30), questionCount: 3, secondsPerQuestion: 5, visibility: "private", ...extra,
});
const waitForSet = (h: string, partyId: string) => waitFor(async () => (await api(h, "GET", `/parties/${partyId}`)).questions.status === "ready" || null, { tries: 120, everyMs: 500 });

// ---- 1. a bragging-rights party ------------------------------------------------------------

console.log("\n1. A bragging-rights party");
ok((await api(B, "GET", `/users/${A}`)).canMessage === "request", "strangers start as a message request");
const party = await api(A, "POST", "/parties", freeParty(`Social sim ${tag}`));
for (const h of [B, C]) await api(h, "POST", `/parties/${party.id}/join`);
await waitForSet(A, party.id);
ok(!!(await playParty(party.id, [A, B, C])), "the party is played to the end and settled");
const today = lagosDay();
const points = await db.select().from(partyDays).where(eq(partyDays.day, today));
const mine = (h: string) => points.find((p) => p.userId === id(h));
ok([A, B, C].every((h) => (mine(h)?.points ?? 0) >= 10) && points.filter((p) => [A, B, C].map(id).includes(p.userId)).reduce((n, p) => n + p.wins, 0) === 1, "everyone earned party points, one of them a win");

await api(B, "POST", `/users/${id(A)}/follow`);
await api(B, "POST", `/users/${id(C)}/follow`);
const profile = await api(B, "GET", `/users/${A}`);
ok(profile.stats.parties === 1 && profile.headToHead?.played === 1, "A's profile shows the party and B's head-to-head");
ok(profile.canMessage === "direct", "playing a party together opens messages");
ok(profile.mutuals.count === 0 && profile.streak.best >= 0 && typeof profile.climb.bestRunPoints === "number", "the profile carries Climb bests, streaks and mutuals");
const feed = await api(B, "GET", "/feed");
ok(feed.events.some((e: any) => e.kind === "party_finished" && e.person.id === id(A) && e.data.partyId === party.id), "B's feed shows A finishing the party");
ok(!JSON.stringify(feed).match(/kobo|prize|₦/i), "and says nothing about money");
ok((await api(B, "GET", `/users/${A}/activity`)).events.length >= 1, "A's activity tab has it too");

// ---- 2. the friends board ------------------------------------------------------------------

console.log("\n2. Friends board");
const board = await api(B, "GET", "/leaderboards/friends");
const handlesOnBoard = board.rows.map((r: any) => r.person.handle);
ok([A, B, C].every((h) => handlesOnBoard.includes(h)), "you and the people you follow, with points");
ok(board.rows.every((r: any) => r.total === r.climb + r.parties) && board.me?.isMe, "each total is Climb plus party points, your row marked");
ok((await api(B, "GET", "/leaderboards/friends?period=all")).period === "all", "and all time");

// ---- 3. rematch and challenge --------------------------------------------------------------

console.log("\n3. Rematch and challenge");
const rematch = await api(B, "POST", `/parties/${party.id}/rematch`);
const again = await api(C, "POST", `/parties/${party.id}/rematch`);
ok(rematch.created && !again.created && again.partyId === rematch.partyId, "everyone who taps Rematch lands in the same party");
const aParties = await api(A, "GET", "/me/parties");
ok(aParties.invited.some((p: any) => p.id === rematch.partyId), "the other players are invited to it");
const oldChat = await api(A, "GET", `/parties/${party.id}`);
ok(oldChat.chat.some((m: any) => m.kind === "party_card" && m.partyId === rematch.partyId), "the old party's chat points at it");

const challenge = await api(C, "POST", `/users/${id(A)}/challenge`);
const dms = await api(A, "GET", "/chats");
ok(dms.some((t: any) => t.id === challenge.threadId && t.lastMessage?.kind === "party_card"), "a challenge lands in the DM as a party card");
const challenged = await api(A, "GET", `/parties/${challenge.partyId}`);
ok(challenged.title === `chi vs ada` && challenged.visibility === "private" && challenged.entryKobo === 0, "it's a private, free party for the two of you");

// ---- 4. a crew -----------------------------------------------------------------------------

console.log("\n4. A crew");
const crew = await api(A, "POST", "/crews", { name: `Squad ${tag}`, emoji: "🦁", inviteUserIds: [id(B), id(C)] });
ok(crew.myRole === "creator" && crew.pendingInvites.length === 2, "A starts a crew and asks B and C");
ok((await call(B, "GET", `/crews/${crew.id}`)).status === 404, "it's invisible to B until they accept");
for (const h of [B, C]) await api(h, "POST", `/crews/${crew.id}/invite/accept`);
const detail = await api(B, "GET", `/crews/${crew.id}`);
ok(detail.memberCount === 3 && detail.members.map((m: any) => m.role).sort().join() === "creator,member,member", "both accepted");

const inboxA = await new Client(RT).joinOrCreate(INBOX_ROOM, { userId: id(A), devUser: A });
const inboxB = await new Client(RT).joinOrCreate(INBOX_ROOM, { userId: id(B), devUser: B });
const updatesA: any[] = [];
inboxA.onMessage(MSG.inbox, (u) => updatesA.push(u));
for (const r of [inboxA, inboxB]) for (const t of [MSG.chatMessage, MSG.error]) r.onMessage(t, () => {});
inboxB.onMessage(MSG.inbox, () => {});
const acked = new Promise<any>((r) => inboxB.onMessage(MSG.chatAck, r));
inboxB.send(MSG.chat, { threadId: detail.threadId, clientMsgId: randomUUID(), text: `9pm crew party, @${A} you in?` });
ok(!!(await acked)?.message, "B writes in the crew chat");
ok(!!(await waitFor(async () => updatesA.find((u) => u.threadId === detail.threadId) ?? null, { tries: 20, everyMs: 200 })), "A's inbox hears it live");
const crewList = await api(A, "GET", "/crews");
const row = crewList.find((c: any) => c.id === crew.id);
ok(row && row.unread >= 1 && row.lastMessage && row.leader !== undefined, "Chats › Crews shows the crew with its last line, unread and who leads");

const crewBoard = await api(C, "GET", `/crews/${crew.id}/board`);
ok(crewBoard.rows.length === 3 && crewBoard.rows.every((r: any) => r.parties > 0), "the crew board counts everyone's party points");

const crewParty = await api(A, "POST", "/parties", freeParty(`Crew night ${tag}`, { crewId: crew.id }));
const bInvites = await api(B, "GET", "/me/parties");
ok(bInvites.invited.some((p: any) => p.id === crewParty.id), "a crew party invites the crew");
const crewChat = await api(B, "GET", `/chats/${detail.threadId}/messages`);
ok(crewChat.messages.some((m: any) => m.kind === "party_card" && m.partyId === crewParty.id), "and lands in the crew chat");

// A Climb run: two stages cleared, then a miss. Nobody in the crew has climbed yet, so it's a crew record.
let state = await api(B, "POST", "/climb/runs");
for (;;) {
  state = await nextClimbRound(B, state);
  if (state.run.status !== "active") break;
  const answer = state.round.stage <= 2 ? await rightClimbAnswer(state.round.id) : wrongClimbAnswer;
  const res = await api(B, "POST", `/climb/runs/${state.run.id}/answer`, { roundId: state.round.id, answer });
  if (res.nextOpensAt === null) break;
  state = { run: res.run, round: null, nextOpensAt: res.nextOpensAt };
}
const record = await waitFor(async () => (await api(A, "GET", `/chats/${detail.threadId}/messages`)).messages.find((m: any) => m.kind === "system" && /New crew record/.test(m.text)) ?? null, { tries: 10 });
ok(!!record, `a crew record goes in the crew chat ("${record?.text}")`);
const records = (await api(A, "GET", `/crews/${crew.id}`)).records;
ok(records.bestClimb?.person.id === id(B) && records.bestClimb.stagesCleared === 2, "and on the crew's records");
ok((await api(A, "GET", "/feed")).events.length >= 0 && (await api(C, "GET", `/users/${B}/activity`)).events.some((e: any) => e.kind === "climb_best"), "a personal best shows in their activity");

ok((await call(C, "POST", `/crews/${crew.id}/invites`, { userIds: [id(A)] })).body.error === "crew_admins_only", "members can't invite");
await api(A, "PATCH", `/crews/${crew.id}/members/${id(C)}`, { role: "admin" });
const afterLeave = await api(A, "POST", `/crews/${crew.id}/leave`);
const handedOver = await api(B, "GET", `/crews/${crew.id}`);
ok(!afterLeave.archived && handedOver.members.find((m: any) => m.person.id === id(C))?.role === "creator", "when the creator leaves, the admin takes over");

// ---- 5. week close --------------------------------------------------------------------------

console.log("\n5. Week close");
const lastWeekDay = addDays(weekOf(today), -3);
// The crew has to have existed last week for it to have a last week (test-only backdating).
await db.update(crews).set({ createdAt: new Date(`${addDays(weekOf(today), -7)}T12:00:00Z`) }).where(eq(crews.id, crew.id));
await db.insert(partyDays).values({ userId: id(B), day: lastWeekDay, week: weekOf(lastWeekDay), points: 120, parties: 3, wins: 2 }).onConflictDoNothing();
await db.insert(partyDays).values({ userId: id(C), day: lastWeekDay, week: weekOf(lastWeekDay), points: 40, parties: 2, wins: 0 }).onConflictDoNothing();
await climbQueue().add("week_close", { kind: "week_close" });
const closed = await waitFor(async () => (await db.select().from(climbWeekResults).where(and(eq(climbWeekResults.scope, "crew"), eq(climbWeekResults.scopeId, crew.id))))[0] ?? null, { tries: 30 });
ok(!!closed, "the worker closes last week for the crew");
const crowned = await api(C, "GET", `/crews/${crew.id}`);
ok(crowned.champion?.id === id(B) && crowned.members.find((m: any) => m.person.id === id(B))?.crowned, "last week's champion wears the crown");
ok((await api(C, "GET", `/crews/${crew.id}/board`)).rows.find((r: any) => r.person.id === id(B))?.crowned, "on the board too");

for (const r of [inboxA, inboxB]) await r.leave().catch(() => {});
console.log(failureCount() ? `\n${failureCount()} check(s) failed` : "\nall social checks passed");
process.exit(failureCount() ? 1 : 0);

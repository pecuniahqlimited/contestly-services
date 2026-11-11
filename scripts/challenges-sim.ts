/**
 * Challenges sim (ADR 0019), fresh people against the running stack:
 *
 * 1. Ada challenges Kemi and Tolu from the preset, with a message: the card in each DM, pending. Kemi accepts (Ada
 *    hears), both go into the lobby, and it waits for Tolu; Tolu declines ("Not this time") and it starts at once,
 *    is played to the end, and the head-to-head counts it. Kemi's rematch is a new challenge to Ada, same settings.
 * 2. Coins, nobody answers: the challenger's entry is taken on send and comes back when the invite expires.
 * 3. Coins, a join window that runs out: Kemi pays on accept, the halfway reminder reaches whoever isn't in the
 *    lobby, then nobody comes and both entries come back.
 * 4. Outside the admin's ranges: refused.
 *
 * TEST-ONLY: an invite's expiry and a window's end are reached by moving their times in Postgres and promoting the
 * worker's delayed jobs; the nudges are read from Postgres. Run with the stack up: npm run sim:challenges
 */
import { randomBytes } from "node:crypto";
import { Client, type Room } from "colyseus.js";
import { and, eq } from "drizzle-orm";
import { db, nudges, partyChallenges } from "@contestly/db";
import { partyQueue } from "@contestly/queue";
import { MSG, PARTY_ROOM, type NudgeKind } from "@contestly/shared";
import { RT, api, call, failureCount, ok, sendChallenge, sleep, waitFor, waitForProgress, walletTotal } from "./sim-lib.js";

const tag = randomBytes(2).toString("hex");
const [ADA, KEMI, TOLU] = ["ada", "kemi", "tolu"].map((n) => `cs${tag}_${n}`);
const ids = new Map<string, string>();
for (const [h, lanes] of [[ADA, ["Afrobeats", "Football"]], [KEMI, ["Afrobeats"]], [TOLU, ["Nollywood"]]] as const) {
  await api(h, "POST", "/me", { displayName: h.split("_")[1], handle: h, interests: lanes });
  ids.set(h, (await api(h, "GET", "/me")).id);
}
const id = (h: string) => ids.get(h)!;
const jobs = partyQueue();
const promote = async (jobId: string) => (await jobs.getJob(jobId))?.promote();
const card = (h: string, partyId: string) => api(h, "GET", `/challenges/${partyId}`);
const nudged = async (h: string, kind: NudgeKind, partyId: string) =>
  (await db.select().from(nudges).where(and(eq(nudges.userId, id(h)), eq(nudges.kind, kind), eq(nudges.refId, partyId)))).length;
/** Every DM preview the person has, conversations and requests (a stranger's challenge arrives as a request). */
const previews = async (h: string) => [...await api(h, "GET", "/chats"), ...await api(h, "GET", "/chats/requests")].map((t: any) => t.lastMessage).filter(Boolean);
const statusOf = async (h: string, partyId: string) => (await api(h, "GET", `/parties/${partyId}`)).status;
const ENTRY_NAIRA = 100;

/** Into the lobby, listening for the end of the game. */
async function enterLobby(h: string, partyId: string, onEnd: () => void): Promise<Room> {
  const room = await new Client(RT).joinOrCreate(PARTY_ROOM, { partyId, devUser: h });
  for (const t of [MSG.phase, MSG.question, MSG.reveal, MSG.standings, MSG.presence, MSG.chatMessage, MSG.questionsStatus, MSG.questionVoided, MSG.seats, MSG.error]) room.onMessage(t, () => {});
  room.onMessage(MSG.finalStandings, onEnd);
  return room;
}

// ---- 1. a challenge played through ---------------------------------------------------------

console.log("\n1. A challenge, played through");
ok((await api(ADA, "GET", `/challenges/preset?userIds=${id(KEMI)}`)).topics[0]?.label === "Afrobeats", "the preset for Kemi suggests the lane they share");
const preset = await api(ADA, "GET", `/challenges/preset?userIds=${id(KEMI)},${id(TOLU)}`);
ok(preset.invitees.every((i: any) => i.canChallenge), "for Kemi and Tolu: both can be challenged");
ok(preset.party.questionCount === 5 && preset.party.entryKobo === 0 && preset.party.mode === "sealed" && preset.challenge.joinWindowMinutes === 10, "quick, free, sealed, the default window");
const sent = await sendChallenge(ADA, [id(KEMI), id(TOLU)], { challenge: { message: `Think you know Afrobeats? ${tag}` } });
ok(sent.status === 201, "Ada sends it");
const partyId: string = sent.body.id;
for (const h of [KEMI, TOLU]) {
  ok((await previews(h)).some((m: any) => m.kind === "party_card" && m.text?.includes(tag)), `the card with the message is in ${h.split("_")[1]}'s DMs (a request: they're strangers)`);
  ok((await card(h, partyId)).state === "pending", "pending, with time left");
}
ok((await call(KEMI, "POST", `/parties/${partyId}/join`)).body.error === "challenge_accept_required", "it's joined by accepting, not /join");
const accepted = await api(KEMI, "POST", `/challenges/${partyId}/accept`);
ok(accepted.card.state === "accepted" && !!accepted.card.joinClosesAt, "Kemi accepts: the lobby opens and its countdown starts");
ok(!!(await waitFor(async () => (await nudged(ADA, "challenge_accepted", partyId)) > 0)), "Ada hears Kemi accepted");
await waitFor(async () => (await api(ADA, "GET", `/parties/${partyId}`)).questions.status === "ready" || null, { tries: 120 });
let finished = 0;
const rooms = [await enterLobby(ADA, partyId, () => finished++), await enterLobby(KEMI, partyId, () => finished++)];
ok(!!(await waitFor(async () => (await card(ADA, partyId)).inLobby.length === 2)), "the card shows who's in the lobby");
await sleep(1500);
ok((await statusOf(ADA, partyId)) === "open", "both in, but Tolu hasn't answered: it waits");
const declined = await api(TOLU, "POST", `/challenges/${partyId}/decline`);
ok(declined.card.state === "declined", "Tolu declines: \"Not this time\"");
ok((await previews(ADA)).some((m: any) => m.kind === "party_card" && m.text === "Not this time" && m.author?.handle === TOLU), "Ada sees \"Not this time\" from Tolu in the DM");
ok(!!(await waitFor(async () => (await statusOf(ADA, partyId)) !== "open")), "everyone left is in: it starts at once");
ok(!!(await waitFor(async () => finished === 2, { tries: 240 })), "played to the end");
for (const r of rooms) await r.leave().catch(() => {});
ok(!!(await waitForProgress(partyId)), "settled");
ok((await api(KEMI, "GET", `/users/${ADA}`)).headToHead?.played === 1, "the head-to-head counts it");
ok((await card(KEMI, partyId)).state === "finished", "the card says it's done");
const rematch = await api(KEMI, "POST", `/parties/${partyId}/rematch`);
const again = await card(ADA, rematch.partyId);
ok(rematch.created && again.challenger.id === id(KEMI) && again.state === "pending" && again.message?.includes(tag) && again.invitees.map((i: any) => i.person.id).join() === id(ADA), "Kemi's rematch is a new challenge to Ada, same message");
await api(KEMI, "POST", `/parties/${rematch.partyId}/cancel`, {});

// ---- 2. coins, nobody answers --------------------------------------------------------------

console.log("\n2. Coins: nobody answers");
await api(ADA, "POST", "/wallet/dev-topup", { nairaAmount: 1_000 });
const before = await walletTotal(ADA);
const staked = (await sendChallenge(ADA, [id(TOLU)], { party: { entryKobo: ENTRY_NAIRA * 100 } })).body.id as string;
ok((await walletTotal(ADA)) === before - ENTRY_NAIRA * 100, "the challenger's entry is taken on send");
await db.update(partyChallenges).set({ inviteExpiresAt: new Date(Date.now() - 1000) }).where(eq(partyChallenges.partyId, staked));
await promote(`challenge-expire-${staked}`);
ok(!!(await waitFor(async () => (await statusOf(ADA, staked)) === "cancelled")), "the invite expires: cancelled");
ok((await walletTotal(ADA)) === before, "and the entry is back");
ok((await card(ADA, staked)).state === "expired" && (await api(ADA, "GET", `/parties/${staked}`)).chat.some((m: any) => m.text === "Challenge expired."), "the card and the chat say \"Challenge expired.\"");
ok((await card(TOLU, staked)).state === "no_answer", "Tolu's card: they didn't answer in time");

// ---- 3. coins, a join window that runs out --------------------------------------------------

console.log("\n3. Coins: the join window runs out");
await api(KEMI, "POST", "/wallet/dev-topup", { nairaAmount: 1_000 });
const [adaBefore, kemiBefore] = [await walletTotal(ADA), await walletTotal(KEMI)];
const windowed = (await sendChallenge(ADA, [id(KEMI)], { party: { entryKobo: ENTRY_NAIRA * 100 } })).body.id as string;
await api(KEMI, "POST", `/challenges/${windowed}/accept`);
ok((await walletTotal(KEMI)) === kemiBefore - ENTRY_NAIRA * 100, "Kemi pays the same entry on accept");
await promote(`challenge-remind-${windowed}`);
ok(!!(await waitFor(async () => (await nudged(KEMI, "challenge_join_reminder", windowed)) > 0 && (await nudged(ADA, "challenge_join_reminder", windowed)) > 0)), "halfway: both hear the lobby is closing");
await promote(`challenge-start-${windowed}`);
ok(!!(await waitFor(async () => (await statusOf(ADA, windowed)) === "cancelled")), "nobody came: cancelled at the window's end");
ok((await walletTotal(ADA)) === adaBefore && (await walletTotal(KEMI)) === kemiBefore, "both entries are back");
ok((await card(KEMI, windowed)).state === "no_show" && (await card(ADA, windowed)).state === "expired", "Kemi's card says no-show; Ada's, that it expired");

// ---- 4. the ranges ---------------------------------------------------------------------------

console.log("\n4. The admin's ranges");
const tooLong = await sendChallenge(ADA, [id(KEMI)], { challenge: { joinWindowMinutes: preset.ranges.joinWindowMinutes.max + 1 } });
ok(tooLong.status === 422 && tooLong.body.error === "challenge_out_of_range", "a window past the admin's range is refused");

console.log(failureCount() ? `\n${failureCount()} check(s) failed` : "\nall challenges checks passed");
process.exit(failureCount() ? 1 : 0);

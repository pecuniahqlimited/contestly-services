/**
 * Chat sim (row 6a), three fresh people against the running stack:
 *
 * 1. Messages: a stranger's DM is a request (a few text lines, then it waits; no voice), the recipient sees it
 *    in Requests and live in their inbox, accepts, and it opens. A repeated client message id posts once.
 * 2. Voice: an upload URL, the bytes straight to object storage, the line with its duration, playback by the
 *    other side, and the transcript in the moderation queue (worker, mock transcriber).
 * 3. Unread and read, history pages, @mentions resolved and profanity masked.
 * 4. Party chat: open in the lobby, refused during a question, open on standings; from Chats › Parties it's
 *    refused while live and open after; Chats › Parties shows the thread with unread lines.
 * 5. The send rate limit.
 *
 * TEST-ONLY. Run with the stack up (npm run infra:up && npm run dev): npm run sim:chat
 */
import { randomBytes, randomUUID } from "node:crypto";
import { Client, type Room } from "colyseus.js";
import { eq } from "drizzle-orm";
import { db, moderationItems } from "@contestly/db";
import { partyQueue } from "@contestly/queue";
import { DEFAULT_CHAT_CONFIG, INBOX_ROOM, MSG, PARTY_ROOM } from "@contestly/shared";
import { RT, api, call, failureCount, inMinutes, ok, sleep, waitFor } from "./sim-lib.js";

const tag = randomBytes(2).toString("hex");
const [A, B, C] = ["ada", "bayo", "chi"].map((n) => `cs${tag}_${n}`);
const ids = new Map<string, string>();
for (const h of [A, B, C]) {
  await api(h, "POST", "/me", { displayName: h.split("_")[1], handle: h });
  ids.set(h, (await api(h, "GET", "/me")).id);
}

type Ack = { clientMsgId: string; duplicate: boolean; message: any };
type Refused = { error: string; clientMsgId?: string; retryAfter?: number };

/** A room that resolves each send with its ack or its refusal, matched by client message id. */
function composer(room: Room) {
  const waiting = new Map<string, (r: Ack | Refused) => void>();
  room.onMessage(MSG.chatAck, (a: Ack) => waiting.get(a.clientMsgId)?.(a));
  room.onMessage(MSG.error, (e: Refused) => e.clientMsgId && waiting.get(e.clientMsgId)?.(e));
  return (body: Record<string, unknown>, clientMsgId = randomUUID()) =>
    new Promise<Ack | Refused>((resolve) => {
      waiting.set(clientMsgId, resolve);
      room.send(MSG.chat, { clientMsgId, ...body });
      setTimeout(() => resolve({ error: "no reply" }), 5000);
    });
}
const acked = (r: Ack | Refused): r is Ack => "message" in r;
/** One person's sends share a burst window (DEFAULT_CHAT_CONFIG): let it pass between sections. */
const cooldown = () => sleep((DEFAULT_CHAT_CONFIG.burstSeconds + 1) * 1000);

async function inbox(handle: string) {
  const room = await new Client(RT).joinOrCreate(INBOX_ROOM, { userId: ids.get(handle), devUser: handle });
  const updates: any[] = [];
  const lines: any[] = [];
  room.onMessage(MSG.inbox, (u) => updates.push(u));
  room.onMessage(MSG.chatMessage, (m) => lines.push(m));
  return { room, send: composer(room), updates, lines };
}

const inboxes = { [A]: await inbox(A), [B]: await inbox(B), [C]: await inbox(C) };

// ---- 1. a message request ------------------------------------------------------------------

console.log("\n1. Messages");
const refusedForGuestless = await call(A, "POST", `/dm/${ids.get(A)}`);
ok(refusedForGuestless.body.error === "cannot_message_self", "nobody can message themselves");
const ab = await api(A, "POST", `/dm/${ids.get(B)}`);
ok(ab.permission === "request" && ab.request === "sent", "a stranger's DM is a message request");
const sendAB = (body: Record<string, unknown>, id?: string) => inboxes[A].send({ threadId: ab.threadId, ...body }, id);
for (let i = 1; i <= 3; i++) ok(acked(await sendAB({ text: `hi ${i}, saw you on the board` })), `request line ${i} kept`);
const fourth = await sendAB({ text: "hello??" });
ok(!acked(fourth) && fourth.error === "request_pending", "the 4th line waits for the recipient (request_pending)");
ok(!!(await waitFor(async () => inboxes[B].updates.filter((u) => u.threadId === ab.threadId).length >= 3 || null, { tries: 20, everyMs: 200 })), "the recipient's inbox hears each line live");
const voiceInRequest = await call(A, "POST", `/chats/${ab.threadId}/voice`, { durationMs: 2000, contentType: "audio/mp4", bytes: 16 });
ok(voiceInRequest.body.error === "voice_after_accept", "no voice notes inside a request");
const requests = await api(B, "GET", "/chats/requests");
ok(requests.some((t: any) => t.id === ab.threadId && t.request === "received"), "the request is in the recipient's Requests");
ok((await api(B, "GET", "/chats/unread")).requests === 1, "the badge counts one request");
ok((await api(B, "POST", `/chats/${ab.threadId}/request/accept`)).state === "active", "the recipient accepts");
ok(acked(await sendAB({ text: "thanks for accepting" })), "after accepting, the conversation is open");

inboxes[B].room.send(MSG.watch, { threadId: ab.threadId });
await sleep(300);
const sameId = randomUUID();
const first = await sendAB({ text: "this goes once" }, sameId);
const again = await sendAB({ text: "this goes once" }, sameId);
ok(acked(first) && acked(again) && again.duplicate && again.message.id === first.message.id, "a repeated client message id gets the first line back");
await sleep(500);
ok(inboxes[B].lines.filter((m) => m.clientMsgId === sameId).length === 1, "and the other side sees it once");

// ---- 2. a voice note -----------------------------------------------------------------------

console.log("\n2. Voice");
await cooldown();
await api(C, "POST", `/users/${ids.get(A)}/follow`); // C opts in to A: A → C is direct
const ac = await api(A, "POST", `/dm/${ids.get(C)}`);
ok(ac.permission === "direct", "someone who follows you can be messaged directly");
const audio = randomBytes(2048);
const up = await api(A, "POST", `/chats/${ac.threadId}/voice`, { durationMs: 4200, contentType: "audio/mp4", bytes: audio.length });
const sendAC = (body: Record<string, unknown>) => inboxes[A].send({ threadId: ac.threadId, ...body });
const early = await sendAC({ voiceNoteId: up.voiceNoteId });
ok(!acked(early) && early.error === "voice_not_uploaded", "a voice line before the upload is refused");
const put = await fetch(up.upload.url, { method: "PUT", headers: up.upload.headers, body: audio });
ok(put.ok, "the bytes go straight to object storage");
const voiceLine = await sendAC({ voiceNoteId: up.voiceNoteId });
ok(acked(voiceLine) && voiceLine.message.kind === "voice" && voiceLine.message.voice.durationMs === 4200, "the voice line carries its duration");
const play = await api(C, "GET", `/voice-notes/${up.voiceNoteId}`);
const heard = new Uint8Array(await (await fetch(play.url)).arrayBuffer());
ok(heard.length === audio.length && heard.every((b, i) => b === audio[i]), "the other side plays it back from a signed URL");
ok((await call(B, "GET", `/voice-notes/${up.voiceNoteId}`)).status === 404, "and nobody outside the thread can");
const reused = await sendAC({ voiceNoteId: up.voiceNoteId });
ok(!acked(reused) && reused.error === "voice_note_invalid", "a voice note is sent once");
const transcript = await waitFor(async () => (await db.select().from(moderationItems).where(eq(moderationItems.refId, up.voiceNoteId)))[0], { tries: 40, everyMs: 250 });
ok(!!transcript?.transcript && transcript.status === "pending", "the worker transcribes it into the moderation queue");

// ---- 3. unread, history, mentions -----------------------------------------------------------

console.log("\n3. Unread, history, mentions");
await cooldown();
const tagged = await sendAC({ text: `@${C} @${B} that question was shit` });
ok(acked(tagged) && tagged.message.text.endsWith("s***"), "profanity is masked");
ok(acked(tagged) && tagged.message.mentions.includes(C) && tagged.message.mentions.includes(B), "@mentions resolve to real handles");
ok((await api(C, "GET", "/chats/unread")).messages >= 2, "the other side has unread lines");
const row = (await api(C, "GET", "/chats")).find((t: any) => t.id === ac.threadId);
ok(row?.lastMessage?.text?.endsWith("s***") && row.unread >= 2, "Messages shows the last line and the unread count");
await api(C, "POST", `/chats/${ac.threadId}/read`);
ok((await api(C, "GET", "/chats/unread")).messages === 0, "reading clears it");
const page1 = await api(B, "GET", `/chats/${ab.threadId}/messages?limit=2`);
const page2 = await api(B, "GET", `/chats/${ab.threadId}/messages?limit=2&before=${page1.before}`);
ok(page1.messages.length === 2 && page2.messages.length === 2 && page2.messages[1].createdAt <= page1.messages[0].createdAt, "history pages back, oldest first within a page");

// ---- 4. party chat ---------------------------------------------------------------------------

console.log("\n4. Party chat");
const party = await api(A, "POST", "/parties", {
  title: `Chat sim ${tag}`, brief: "Nigerian general knowledge — cities, food, music", entryKobo: 0, maxPlayers: 3, funding: "pooled", split: "winner",
  startsAt: inMinutes(30), questionCount: 3, secondsPerQuestion: 5, visibility: "private",
});
for (const h of [B, C]) await api(h, "POST", `/parties/${party.id}/join`);
await waitFor(async () => (await api(A, "GET", `/parties/${party.id}`)).questions.status === "ready" || null, { tries: 120, everyMs: 500 });
const detail = await api(B, "GET", `/parties/${party.id}`);
ok(!!detail.threadId && detail.chat.some((m: any) => m.kind === "system" && m.text.endsWith("joined")), "party detail carries its thread and the system lines");

const seen = { [A]: [] as any[], [B]: [] as any[], [C]: [] as any[] };
const rooms: Record<string, Room> = {};
const sends: Record<string, ReturnType<typeof composer>> = {};
let standings = 0;
let resolveDone!: () => void;
const done = new Promise<void>((r) => (resolveDone = r));
const results: Record<string, Ack | Refused> = {};
for (const h of [A, B, C]) {
  const room = await new Client(RT).joinOrCreate(PARTY_ROOM, { partyId: party.id, devUser: h });
  rooms[h] = room;
  const send = (sends[h] = composer(room));
  room.onMessage(MSG.chatMessage, (m) => seen[h].push(m));
  for (const t of [MSG.phase, MSG.reveal, MSG.presence, MSG.questionsStatus, MSG.questionVoided]) room.onMessage(t, () => {});
  room.onMessage(MSG.question, async (q: any) => {
    if (h === B && q.idx === 0) results.duringQuestion = await send({ text: "is it Lagos?" });
    if (h === B && q.idx === 0) results.inboxWhileLive = await inboxes[B].send({ threadId: detail.threadId, text: "sneaking in from Chats" });
  });
  room.onMessage(MSG.standings, async () => {
    if (h === C && ++standings === 1) results.onStandings = await send({ sticker: "🔥" });
  });
  room.onMessage(MSG.finalStandings, () => h === A && resolveDone());
}
results.lobby = await sends[A]({ text: "Lobby's open, who's ready?" });
await (await partyQueue().getJob(`start-${party.id}`))?.promote();
await Promise.race([done, sleep(120_000)]);
ok(acked(results.lobby), "lobby chat is open");
ok(!acked(results.duringQuestion) && results.duringQuestion.error === "chat_closed", "chat is refused while a question is up");
ok(!acked(results.inboxWhileLive) && results.inboxWhileLive.error === "join_the_round", "and from Chats › Parties while the party is live");
ok(acked(results.onStandings), "chat is open on the standings beat");
await sleep(500);
ok(seen[A].some((m) => m.sticker === "🔥") && seen[B].some((m) => m.text === "Lobby's open, who's ready?"), "everyone in the room gets each line");
for (const r of Object.values(rooms)) await r.leave().catch(() => {});

await waitFor(async () => (await api(A, "GET", `/parties/${party.id}`)).status === "finished" || null, { tries: 60, everyMs: 500 });
const after = await inboxes[A].send({ threadId: detail.threadId, text: "gg all, rematch soon" });
ok(acked(after), "after the party, its chat is open from Chats › Parties");
const mine = await api(B, "GET", "/me/parties");
const card = mine.recent.find((p: any) => p.id === party.id);
ok(card?.threadId === detail.threadId && card.lastLine?.text === "gg all, rematch soon" && card.unread >= 1, "Chats › Parties shows the thread, its last line and unread");

// ---- 5. the rate limit -----------------------------------------------------------------------

console.log("\n5. Rate limit");
await cooldown();
const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => sendAC({ text: `spam ${i}` })));
const limited = burst.filter((r) => !acked(r) && r.error === "rate_limited") as Refused[];
ok(limited.length > 0 && limited.every((r) => (r.retryAfter ?? 0) > 0), `a burst past the limit is refused with retryAfter (${limited.length} of 12)`);

for (const i of Object.values(inboxes)) await i.room.leave().catch(() => {});
console.log(failureCount() ? `\n${failureCount()} check(s) failed` : "\nall chat checks passed");
process.exit(failureCount() ? 1 : 0);

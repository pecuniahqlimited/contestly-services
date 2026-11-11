/**
 * Trust and safety sim (row 11, ADR 0014), fresh people against the running stack:
 *
 * 1. Block: silent, mutual in effect. No DM or Challenge either way; in a shared public party each one's lines
 *    never reach the other's socket, while everyone else hears both. A mute taken mid-party works at once.
 * 2. Report: a line reported by enough people is held, leaves every screen (MSG.chatHidden) and history; the
 *    queue shows it with its snapshot and context; an admin removes it and warns its author, who sees the
 *    notice; reporters hear "action taken".
 * 3. Ban: the banned screen's category, the worker cancels and refunds their hosted open party and refunds their
 *    seat in another; the wallet takes no entry. A suspension that runs out is lifted by the worker's sweep.
 * 4. Names: a slur in a handle or a party title is refused; a milder word in a name is masked.
 *
 * TEST-ONLY. Run with the stack up (npm run infra:up && npm run dev): npm run sim:safety
 */
import { randomBytes, randomUUID } from "node:crypto";
import { Client, type Room } from "colyseus.js";
import { eq } from "drizzle-orm";
import { db, users } from "@contestly/db";
import { DEFAULT_SAFETY_CONFIG, MSG, PARTY_ROOM, kobo } from "@contestly/shared";
import { putBack, RT, api, call, failureCount, inMinutes, makeContacts, ok, sendChallenge, sleep, waitFor, walletTotal } from "./sim-lib.js";

const tag = randomBytes(2).toString("hex");
const handle = (n: string) => `ss${tag}_${n}`;
const [HOST, A, B, C, D, E, F, ADMIN] = ["host", "ada", "bayo", "chi", "dayo", "emeka", "funke", "admin"].map(handle);
const ids = new Map<string, string>();
for (const h of [HOST, A, B, C, D, E, F, ADMIN]) {
  await api(h, "POST", "/me", { displayName: h.split("_")[1], handle: h });
  ids.set(h, (await api(h, "GET", "/me")).id);
}
const id = (h: string) => ids.get(h)!;
const freeParty = (host: string, title: string, extra: Record<string, unknown> = {}) => api(host, "POST", "/parties", {
  title, brief: "Nigerian general knowledge", entryKobo: 0, maxPlayers: 8, funding: "pooled", split: "winner", startsAt: inMinutes(30), questionCount: 3, secondsPerQuestion: 5, ...extra,
});

// ---- 1. block and mute ---------------------------------------------------------------------

await makeContacts(A, B);
ok((await call(B, "POST", `/users/${id(A)}/block`)).body.blocked === true, "bayo blocks ada");
ok((await call(A, "GET", "/me/blocks")).body.blocks.length === 0, "ada isn't told (her block list is empty)");
ok((await call(A, "POST", `/dm/${id(B)}`)).body.error === "cannot_message", "ada can't message bayo, contacts or not");
ok((await call(B, "POST", `/dm/${id(A)}`)).body.error === "cannot_message", "and bayo can't message ada");
ok((await sendChallenge(A, [id(B)])).body.error === "cannot_challenge", "no Challenge either");
ok((await call(B, "GET", `/users/${A}`)).body.blockedByYou === true, "bayo's view of ada's profile says blocked");

const created = await freeParty(HOST, `Safety sim ${tag}`);
for (const h of [A, B, C, D]) await api(h, "POST", `/parties/${created.id}/join`);
const shared = await api(HOST, "GET", `/parties/${created.id}`);
const heard: Record<string, string[]> = {};
const hidden: Record<string, string[]> = {};
const rooms: Record<string, Room> = {};
for (const h of [HOST, A, B, C, D]) {
  heard[h] = [];
  hidden[h] = [];
  const room = await new Client(RT).joinOrCreate(PARTY_ROOM, { partyId: shared.id, devUser: h });
  room.onMessage(MSG.chatMessage, (m: { text: string | null; id: string }) => heard[h].push(m.text ?? ""));
  room.onMessage(MSG.chatHidden, (m: { messageId: string }) => hidden[h].push(m.messageId));
  for (const t of [MSG.chatAck, MSG.phase, MSG.presence, MSG.seats, MSG.questionsStatus, MSG.error, MSG.question, MSG.reveal, MSG.standings]) room.onMessage(t, () => {});
  rooms[h] = room;
}
const say = (h: string, text: string) => rooms[h].send(MSG.chat, { clientMsgId: randomUUID(), text });
say(A, "ada says hi");
say(B, "bayo says hi");
await sleep(1500);
ok(!heard[B].includes("ada says hi") && heard[B].includes("bayo says hi"), "in the shared party, bayo's socket never gets ada's line");
ok(!heard[A].includes("bayo says hi") && heard[A].includes("ada says hi"), "and ada's never gets bayo's");
ok(heard[C].includes("ada says hi") && heard[C].includes("bayo says hi"), "chi hears both");

await api(C, "POST", `/users/${id(A)}/mute`);
await sleep(300);
say(A, "ada again");
await sleep(1500);
ok(!heard[C].includes("ada again") && heard[D].includes("ada again"), "chi mutes ada mid-party: her next line skips chi only");

// ---- 2. report, hold, the queue ------------------------------------------------------------

say(B, "bayo crosses a line");
const line = await waitFor(async () => {
  const page = await api(HOST, "GET", `/chats/${shared.threadId}/messages?limit=50`);
  return page.messages.find((m: { text: string }) => m.text === "bayo crosses a line");
});
ok(!!line, "the line is in history");
const reporters = [HOST, C, D].slice(0, DEFAULT_SAFETY_CONFIG.holdReporters);
let first: { body: any } | undefined;
for (const r of reporters) {
  const res = await call(r, "POST", "/reports", { target: { type: "message", id: line.id }, reason: "harassment" });
  first ??= res;
}
ok(first?.body.offerBlock?.id === id(B), "a report offers to block its author");
await sleep(1500);
ok(hidden[HOST].includes(line.id) && hidden[C].includes(line.id), `${reporters.length} reporters: the line is held and every screen is told to drop it`);
const after = await api(HOST, "GET", `/chats/${shared.threadId}/messages?limit=50`);
ok(!after.messages.some((m: { id: string }) => m.id === line.id), "and it's gone from history");

const queue = await api(ADMIN, "GET", "/admin/moderation?type=party_message&limit=100");
const queued = queue.items.find((i: { refId: string }) => i.refId === line.id);
ok(!!queued?.heldAt && queued.reportCount === reporters.length && queued.snapshot.text === "bayo crosses a line", "the queue has it, held, with its snapshot and reporter count");
const detail = await api(ADMIN, "GET", `/admin/moderation/${queued.id}`);
ok(detail.context.some((c: { text: string }) => c.text === "ada says hi"), "the item shows the chat around it");
await api(ADMIN, "POST", `/admin/moderation/${queued.id}/actions`, { action: "remove", reason: "sim: harassment" });
await api(ADMIN, "POST", `/admin/moderation/${queued.id}/actions`, { action: "warn", reason: "sim: first warning" });
const warned = await api(B, "GET", "/me/notices");
ok(warned.notices.some((n: { kind: string; category: string }) => n.kind === "warning" && n.category === "harassment"), "bayo sees a warning with the category");
const told = await api(C, "GET", "/me/notices");
ok(told.notices.some((n: { outcome: string }) => n.outcome === "action_taken"), "a reporter hears action was taken, nothing more");
for (const r of Object.values(rooms)) await r.leave().catch(() => {});

// ---- 3. ban and suspension -----------------------------------------------------------------

await api(E, "POST", "/wallet/dev-topup", { nairaAmount: 1000 });
await api(F, "POST", "/wallet/dev-topup", { nairaAmount: 1000 });
const staked = await freeParty(E, `Emeka's staked ${tag}`, { entryKobo: kobo(100), maxPlayers: 4 });
await api(F, "POST", `/parties/${staked.id}/join`);
const elsewhere = await freeParty(HOST, `Host's staked ${tag}`, { entryKobo: kobo(100), maxPlayers: 4 });
await api(E, "POST", `/parties/${elsewhere.id}/join`);
const [fBefore, eBefore] = [await walletTotal(F), await walletTotal(E)];

await api(ADMIN, "POST", `/admin/users/${id(E)}/ban`, { reason: "sim: scamming", category: "spam_scam" });
const screen = await call(E, "GET", "/me");
ok(screen.status === 403 && screen.body.error === "account_banned" && screen.body.details.category === "spam_scam" && screen.body.details.until === null, "the banned screen gets the category, no end date");
const cancelled = await waitFor(async () => ((await api(HOST, "GET", `/parties/${staked.id}`)).status === "cancelled" ? true : null), { tries: 40, everyMs: 500 });
ok(!!cancelled, "the worker cancels their hosted open party");
ok((await walletTotal(F)) === fBefore + kobo(100), "and its player's entry comes back");
const left = await waitFor(async () => ((await api(HOST, "GET", `/parties/${elsewhere.id}`)).players.some((p: { id: string }) => p.id === id(E)) ? null : true), { tries: 40, everyMs: 500 });
ok(!!left, "their seat in someone else's open party is freed");
await api(ADMIN, "POST", `/admin/users/${id(E)}/unban`, { reason: "sim: done" });
ok((await walletTotal(E)) === eBefore + kobo(200), "both their entries came back (their own party's and the seat); nothing was confiscated");

await api(ADMIN, "POST", `/admin/users/${id(D)}/suspend`, { reason: "sim: cool off", hours: 1, category: "harassment" });
const suspended = await call(D, "GET", "/me");
ok(suspended.status === 403 && Date.parse(suspended.body.details.until) > Date.now(), "a suspension shows when it ends");
ok((await call(D, "POST", `/parties/${elsewhere.id}/join`)).status === 403, "and they can't join or pay in");
await db.update(users).set({ bannedUntil: new Date(Date.now() - 1000) }).where(eq(users.id, id(D)));
ok((await call(D, "GET", "/me")).status === 200, "past its end it stops counting at once");
const lifted = await waitFor(async () => ((await db.select({ b: users.bannedAt }).from(users).where(eq(users.id, id(D))))[0].b === null ? true : null), { tries: 90, everyMs: 1000 });
ok(!!lifted, "and the worker's sweep lifts it");

// ---- 4. names ------------------------------------------------------------------------------

ok((await call(F, "POST", "/me", { displayName: "Funke", handle: `nyamiri_${tag}` })).body.error === "name_not_allowed", "a slur in a handle is refused");
ok((await call(F, "POST", "/parties", { title: "Shege quiz", brief: "anything", entryKobo: 0, maxPlayers: 4, funding: "pooled", split: "winner" })).body.error === "name_not_allowed", "and in a party title");
ok((await api(F, "POST", "/me", { displayName: "Mumu Funke", handle: F })).displayName === "M*** Funke", "a milder word in a name is masked");

const failed = failureCount();
console.log(failed ? `\n${failed} check(s) failed` : "\nsafety sim passed");
// Admin config this sim changed (the AI routing, if it wasn't on the sims' profile) goes back as it was.
await putBack();
process.exit(failed ? 1 : 0);

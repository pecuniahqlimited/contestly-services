/**
 * Trust and safety (row 11, ADR 0014) against the real database: each block effect (DMs, mentions, invites,
 * Challenge, follower asks, your people, mutuals, the friends board, suggested corners, corner posts, nudges,
 * party chat filtered per viewer), mute, a report on every target type with its snapshot, the automatic holds
 * and their reversal, every moderation action and the reporters' notes, the ban (wallet frozen, hosted party
 * refunded, seat refunded, withdrawal held), a suspension running out, and the name filter.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import {
  adminActions, adminAlerts, chatMessages, contactMatches, corners, db, follows, joinPartyThread, ledger, liftExpiredSuspensions, moderationItems,
  nudge, nudges, openDm, parties, partyInvites, partyPlayers, paymentSettings, payouts, playedWith, postMessage, sql, takeSeat, threadById, users, voiceNotes,
  withdrawBlockReason, yourPeople, type User,
} from "@contestly/db";
import { addBankAccount, createTopup, requestPayout, resolveAccount, type KeyValue, type PaymentsDeps } from "@contestly/payments";
import { DEFAULT_CHAT_CONFIG, DEFAULT_SAFETY_CONFIG, kobo, type ChatMessage, type ReportBody } from "@contestly/shared";
import { applyBanEffects } from "../../worker/src/banEffects.js";
import { suggestedCorners } from "../src/corners.js";
import { as, makeUser, tag, testApp } from "./harness.js";

let app: Awaited<ReturnType<typeof testApp>>["app"];
let admin: User;
let n = 0;
const person = (name: string, extra: Partial<typeof users.$inferInsert> = {}) => makeUser(`${name}${++n}`, extra);
const chatDeps = { cfg: DEFAULT_CHAT_CONFIG, voiceUploaded: async () => true };
const say = async (sender: User, threadId: string, text: string, extra: { voiceNoteId?: string } = {}) =>
  (await postMessage({ thread: (await threadById(threadId))!, sender, clientMsgId: randomUUID(), text, ...extra }, chatDeps)).message;
const refusal = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);
const block = (by: User, them: User) => app.inject({ method: "POST", url: `/users/${them.id}/block`, headers: as(by) });
const report = (by: User, body: ReportBody) => app.inject({ method: "POST", url: "/reports", headers: as(by), payload: body });
const history = async (viewer: User, threadId: string) =>
  ((await app.inject({ url: `/chats/${threadId}/messages?limit=50`, headers: as(viewer) })).json().messages as ChatMessage[]).map((m) => m.text);
const contacts = (a: User, b: User) => db.insert(contactMatches).values({ userId: a.id, contactUserId: b.id }).onConflictDoNothing();
const inHour = () => new Date(Date.now() + 3_600_000);

async function party(host: User, opts: { entryKobo?: number; visibility?: "public" | "private" } = {}) {
  const [p] = await db.insert(parties).values({
    createdByUserId: host.id, title: "Safety test", brief: "general knowledge", category: "General knowledge", entryKobo: opts.entryKobo ?? 0,
    maxPlayers: 10, funding: "pooled", split: [100], status: "open", startsAt: inHour(), questionsStatus: "ready", visibility: opts.visibility ?? "public",
  }).returning();
  await joinPartyThread(db, p.id, host.id);
  return p;
}
const fund = (u: User, kind: "cash" | "bonus", amountKobo: number) =>
  db.transaction((tx) => ledger.post(tx, { userId: u.id, kind, amountKobo, type: "topup", idempotencyKey: `t:safety:${tag}:${u.id}:${kind}:${randomUUID()}` }));
async function seat(p: typeof parties.$inferSelect, u: User) {
  await db.transaction(async (tx) => { await tx.select().from(parties).where(eq(parties.id, p.id)).for("update"); await takeSeat(tx, p, u.id, p.entryKobo); });
  return joinPartyThread(db, p.id, u.id);
}
const unlockedCorner = async (owner: User) =>
  (await db.insert(corners).values({ ownerUserId: owner.id, name: `${owner.displayName}'s corner`, status: "unlocked", unlockedAt: new Date() }).returning())[0];
const item = async (kind: string, refId: string) => (await db.select().from(moderationItems).where(and(eq(moderationItems.kind, kind), eq(moderationItems.refId, refId))))[0];
const act = (itemId: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url: `/admin/moderation/${itemId}/actions`, headers: as(admin), payload });
const reload = async (u: User) => (await db.select().from(users).where(eq(users.id, u.id)))[0];

beforeAll(async () => {
  ({ app } = await testApp());
  admin = await makeUser("safeadmin", { isAdmin: true });
});
afterAll(async () => {
  await app.close();
  await sql.end();
});

// ---- block ---------------------------------------------------------------------------------

describe("a block", () => {
  let ada: User, kemi: User, zee: User;
  beforeAll(async () => {
    ada = await person("bada");
    kemi = await person("bkemi");
    zee = await person("bzee");
    for (const [a, b] of [[ada, kemi], [ada, zee], [kemi, zee]] as const) await contacts(a, b);
  });

  it("is silent, listed in /me/blocks, shown on the profile, and undone by unblocking", async () => {
    const res = await block(ada, kemi);
    expect(res.json()).toEqual({ blocked: true });
    expect((await block(ada, kemi)).json()).toEqual({ blocked: true }); // twice is a no-op
    expect((await app.inject({ url: "/me/blocks", headers: as(ada) })).json().blocks.map((b: { person: { id: string } }) => b.person.id)).toEqual([kemi.id]);
    expect((await app.inject({ url: "/me/blocks", headers: as(kemi) })).json().blocks).toEqual([]); // they aren't told
    expect((await app.inject({ url: `/users/${kemi.handle}`, headers: as(ada) })).json()).toMatchObject({ blockedByYou: true, mutedByYou: false, canMessage: "refused" });
    expect((await app.inject({ url: `/users/${ada.handle}`, headers: as(kemi) })).json()).toMatchObject({ blockedByYou: false, canMessage: "refused" });
    expect((await block(ada, ada)).json().error).toBe("cannot_block_self");
  });

  it("stops DMs and requests both ways, and takes the thread out of both people's Chats", async () => {
    const thread = await openDm(zee, ada); // made before the block between zee and ada
    await say(zee, thread.threadId, "hi ada");
    await block(zee, ada);
    expect(await refusal(openDm(ada, zee))).toBe("cannot_message");
    expect(await refusal(openDm(zee, ada))).toBe("cannot_message");
    expect(await refusal(say(ada, thread.threadId, "hello?"))).toBe("cannot_message");
    for (const u of [ada, zee]) expect((await app.inject({ url: "/chats", headers: as(u) })).json().some((t: { id: string }) => t.id === thread.threadId)).toBe(false);
    await app.inject({ method: "DELETE", url: `/users/${ada.id}/block`, headers: as(zee) });
    expect(await refusal(openDm(ada, zee))).toBe("ok");
  });

  it("means they can't tag each other: the mention isn't resolved, so no mention nudge", async () => {
    const p = await party(zee);
    const t = await seat(p, ada);
    await seat(p, kemi);
    const line = await say(kemi, t, `@${ada.handle} and @${zee.handle} good luck`);
    expect(line.mentions).toEqual([zee.handle]);
  });

  it("refuses party and crew invites and Challenges, and dismisses pending invites between them", async () => {
    const p = await party(zee);
    const pending = await party(ada);
    await db.insert(partyInvites).values({ partyId: pending.id, inviteeId: zee.id, inviterId: ada.id });
    await seat(p, kemi);
    await db.insert(playedWith).values({ userA: [kemi.id, ada.id].sort()[0], userB: [kemi.id, ada.id].sort()[1], parties: 1, lastPlayedAt: new Date() }).onConflictDoNothing();
    expect((await app.inject({ method: "POST", url: `/parties/${p.id}/invites`, headers: as(kemi), payload: { userIds: [ada.id] } })).json().error).toBe("cannot_invite");
    const crew = (await app.inject({ method: "POST", url: "/crews", headers: as(kemi), payload: { name: "Quiz crew", inviteUserIds: [ada.id] } })).json();
    expect(crew.error).toBe("cannot_invite");
    expect((await app.inject({ method: "POST", url: `/users/${ada.id}/challenge`, headers: as(kemi), payload: {} })).json().error).toBe("cannot_challenge");
    await block(zee, ada);
    const [inv] = await db.select().from(partyInvites).where(and(eq(partyInvites.partyId, pending.id), eq(partyInvites.inviteeId, zee.id)));
    expect(inv.status).toBe("dismissed");
    await app.inject({ method: "DELETE", url: `/users/${ada.id}/block`, headers: as(zee) });
  });

  it("leaves them out of your people, mutuals, the friends board and suggested corners", async () => {
    expect((await yourPeople(ada.id)).has(kemi.id)).toBe(false);
    expect((await yourPeople(kemi.id)).has(ada.id)).toBe(false);
    expect((await yourPeople(ada.id)).has(zee.id)).toBe(true);
    // kemi is one of zee's people, but no longer ada's: never one of ada and zee's mutuals.
    const zeeProfile = (await app.inject({ url: `/users/${zee.handle}`, headers: as(ada) })).json();
    expect(zeeProfile.mutuals.faces.map((f: { id: string }) => f.id)).not.toContain(kemi.id);
    expect((await yourPeople(zee.id)).has(kemi.id)).toBe(true);
    const board = (await app.inject({ url: "/leaderboards/friends", headers: as(ada) })).json();
    expect(JSON.stringify(board)).not.toContain(kemi.id);
    const c = await unlockedCorner(kemi);
    // The whole pool, not the app's page of it, so the corner's absence means something.
    const suggested = async (u: User) => (await suggestedCorners(await reload(u), 10_000)).corners.some((s) => s.corner.id === c.id);
    expect(await suggested(ada)).toBe(false);
    expect(await suggested(zee)).toBe(true);
  });

  it("stops the blocked person reacting and replying on the blocker's corner posts, and hides their replies from each other", async () => {
    const host = await person("bhost");
    const fan = await person("bfan");
    const c = await unlockedCorner(host);
    await db.insert(follows).values([{ followerId: fan.id, cornerId: c.id }, { followerId: zee.id, cornerId: c.id }]);
    const post = (await app.inject({ method: "POST", url: `/corners/${c.id}/posts`, headers: as(host), payload: { text: "Friday quiz at 8" } })).json();
    const replied = await app.inject({ method: "POST", url: `/corner-posts/${post.id}/replies`, headers: as(fan), payload: { text: "I'm in", clientMsgId: randomUUID() } });
    expect(replied.statusCode).toBe(201);
    await block(host, fan);
    expect((await app.inject({ method: "PUT", url: `/corner-posts/${post.id}/reaction`, headers: as(fan), payload: { emoji: "🔥" } })).json().error).toBe("not_found");
    expect((await app.inject({ method: "POST", url: `/corner-posts/${post.id}/replies`, headers: as(fan), payload: { text: "again", clientMsgId: randomUUID() } })).json().error).toBe("not_found");
    const replies = (who: User) => app.inject({ url: `/corner-posts/${post.id}/replies`, headers: as(who) }).then((r) => r.json().replies.map((x: { text: string }) => x.text));
    expect(await replies(host)).toEqual([]);
    expect(await replies(zee)).toEqual(["I'm in"]);
  });

  it("keeps follower asks and nudges about one from the other", async () => {
    const out = await nudge(db, { userId: ada.id, kind: "rival", data: { by: "climb", rivalHandle: kemi.handle, rivalName: kemi.displayName, stage: 3 }, about: [kemi.id] });
    expect(out).toBe("skipped_hidden");
    const [row] = await db.select().from(nudges).where(eq(nudges.userId, ada.id)).orderBy(desc(nudges.createdAt)).limit(1);
    expect(row).toMatchObject({ status: "skipped", skipReason: "blocked" });
    expect(await nudge(db, { userId: zee.id, kind: "rival", data: { by: "climb", rivalHandle: kemi.handle, rivalName: kemi.displayName, stage: 3 }, about: [kemi.id] })).toBe("recorded");
  });

  it("in a shared public party: both stay seated, and each one's lines are filtered out of the other's history", async () => {
    const host = await person("bphost");
    const p = await party(host);
    const t = await seat(p, ada);
    await seat(p, kemi);
    await say(ada, t, "ada: hello room");
    await say(kemi, t, "kemi: hello room");
    await say(host, t, "host: welcome");
    expect(await history(ada, t)).toEqual(["ada: hello room", "host: welcome"]);
    expect(await history(kemi, t)).toEqual(["kemi: hello room", "host: welcome"]);
    expect(await history(host, t)).toEqual(["ada: hello room", "kemi: hello room", "host: welcome"]);
  });
});

// ---- mute ----------------------------------------------------------------------------------

describe("a mute", () => {
  it("hides their lines and nudges about them for you only, and nothing else", async () => {
    const [me, loud, other] = [await person("mme"), await person("mloud"), await person("mother")];
    await contacts(me, loud);
    expect((await app.inject({ method: "POST", url: `/users/${loud.id}/mute`, headers: as(me) })).json()).toEqual({ muted: true });
    const host = await person("mhost");
    const p = await party(host);
    const t = await seat(p, me);
    await seat(p, loud);
    await seat(p, other);
    await say(loud, t, "LOUD");
    expect(await history(me, t)).toEqual([]);
    expect(await history(other, t)).toEqual(["LOUD"]);
    expect(await nudge(db, { userId: me.id, kind: "rival", data: { by: "climb", rivalHandle: loud.handle, rivalName: loud.displayName, stage: 2 }, about: [loud.id] })).toBe("skipped_hidden");
    // Nothing else changes: still one of my people, still direct to message.
    expect((await yourPeople(me.id)).has(loud.id)).toBe(true);
    expect((await openDm(me, loud)).permission).toBe("direct");
    expect((await app.inject({ url: `/users/${loud.handle}`, headers: as(me) })).json()).toMatchObject({ mutedByYou: true, blockedByYou: false });
    await app.inject({ method: "DELETE", url: `/users/${loud.id}/mute`, headers: as(me) });
    expect(await history(me, t)).toEqual(["LOUD"]);
  });
});

// ---- reports -------------------------------------------------------------------------------

describe("reports", () => {
  let author: User, reporter: User, host: User;
  beforeAll(async () => {
    author = await person("rauthor", { bio: "I quiz" });
    reporter = await person("rrep");
    host = await person("rhost");
  });

  it("a person: snapshot of their profile; a second report is the first back; offers to block", async () => {
    const res = await report(reporter, { target: { type: "user", id: author.id }, reason: "impersonation" });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ replayed: false, offerBlock: { id: author.id, handle: author.handle } });
    const again = await report(reporter, { target: { type: "user", id: author.id }, reason: "harassment" });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ replayed: true, reportId: res.json().reportId });
    expect(await item("user", author.id)).toMatchObject({ userId: author.id, reportCount: 1, status: "open", snapshot: { handle: author.handle, bio: "I quiz" } });
    expect((await report(author, { target: { type: "user", id: author.id }, reason: "spam_scam" })).json().error).toBe("cannot_report_self");
    await block(reporter, author);
    expect((await report(reporter, { target: { type: "user", id: author.id }, reason: "hate" })).json().offerBlock).toBeNull();
    await app.inject({ method: "DELETE", url: `/users/${author.id}/block`, headers: as(reporter) });
  });

  it("party, DM and crew lines, each filed by its thread, kept as they were", async () => {
    const p = await party(host);
    const t = await seat(p, author);
    await seat(p, reporter);
    const partyLine = await say(author, t, "party line");
    await contacts(author, reporter);
    const dm = await openDm(author, reporter);
    const dmLine = await say(author, dm.threadId, "dm line");
    await contacts(author, host);
    const crew = (await app.inject({ method: "POST", url: "/crews", headers: as(author), payload: { name: "Snapshot crew", inviteUserIds: [host.id] } })).json();
    await app.inject({ method: "POST", url: `/crews/${crew.id}/invite/accept`, headers: as(host) });
    const crewThread = crew.threadId as string;
    const crewLine = await say(author, crewThread, "crew line");
    for (const [line, by] of [[partyLine, reporter], [dmLine, reporter], [crewLine, host]] as const) {
      const res = await report(by, { target: { type: "message", id: line.id }, reason: "harassment" });
      expect(res.statusCode, res.body).toBe(201);
    }
    expect(await item("party_message", partyLine.id)).toMatchObject({ threadId: t, snapshot: { text: "party line", threadKind: "party", messageId: partyLine.id } });
    expect(await item("dm_message", dmLine.id)).toMatchObject({ snapshot: { text: "dm line", threadKind: "dm" } });
    expect(await item("crew_message", crewLine.id)).toMatchObject({ snapshot: { text: "crew line", threadKind: "crew" } });
    // Someone outside a DM can't see it, so can't report it.
    expect((await report(host, { target: { type: "message", id: dmLine.id }, reason: "harassment" })).json().error).toBe("not_found");
  });

  it("a corner post (kept after the host deletes it) and a reply", async () => {
    const c = await unlockedCorner(author);
    await db.insert(follows).values({ followerId: host.id, cornerId: c.id });
    const post = (await app.inject({ method: "POST", url: `/corners/${c.id}/posts`, headers: as(author), payload: { text: "buy my course" } })).json();
    expect((await report(reporter, { target: { type: "corner_post", id: post.id }, reason: "spam_scam" })).statusCode).toBe(201);
    await app.inject({ method: "DELETE", url: `/corner-posts/${post.id}`, headers: as(author) });
    expect(await item("corner_post", post.id)).toMatchObject({ userId: author.id, snapshot: { text: "buy my course", cornerId: c.id } });
    const post2 = (await app.inject({ method: "POST", url: `/corners/${c.id}/posts`, headers: as(author), payload: { text: "quiz tonight" } })).json();
    const reply = (await app.inject({ method: "POST", url: `/corner-posts/${post2.id}/replies`, headers: as(host), payload: { text: "you lot are rubbish", clientMsgId: randomUUID() } })).json().reply;
    expect((await report(reporter, { target: { type: "corner_reply", id: reply.id }, reason: "harassment" })).statusCode).toBe(201);
    expect(await item("corner_reply", reply.id)).toMatchObject({ userId: host.id, snapshot: { text: "you lot are rubbish", postId: post2.id } });
  });

  it("a party (title and cover), and a private one only by those in it", async () => {
    const p = await party(author);
    await db.update(parties).set({ title: "Rude title", coverEmoji: "🤬" }).where(eq(parties.id, p.id));
    expect((await report(reporter, { target: { type: "party", id: p.id }, reason: "hate" })).statusCode).toBe(201);
    expect(await item("party", p.id)).toMatchObject({ userId: author.id, snapshot: { title: "Rude title", coverEmoji: "🤬" } });
    const hidden = await party(author, { visibility: "private" });
    expect((await report(reporter, { target: { type: "party", id: hidden.id }, reason: "hate" })).json().error).toBe("not_found");
  });

  it("a voice note: by its id or its line, the same item as its transcript", async () => {
    const p = await party(host);
    const t = await seat(p, author);
    await seat(p, reporter);
    const [note] = await db.insert(voiceNotes).values({ threadId: t, userId: author.id, objectKey: `voice/${t}/${randomUUID()}`, contentType: "audio/mp4", bytes: 1000, durationMs: 3000 }).returning();
    const line = await say(author, t, "", { voiceNoteId: note.id });
    await db.insert(moderationItems).values({ kind: "voice_note", refId: note.id, userId: author.id, threadId: t, transcript: "mock transcript", provider: "mock" }); // what the worker writes
    expect((await report(reporter, { target: { type: "message", id: line.id }, reason: "harassment" })).statusCode).toBe(201);
    expect((await report(host, { target: { type: "voice_note", id: note.id }, reason: "harassment" })).statusCode).toBe(201);
    const it = await item("voice_note", note.id);
    expect(it).toMatchObject({ transcript: "mock transcript", reportCount: 2, snapshot: { voiceNoteId: note.id, messageId: line.id } });
    const detail = (await app.inject({ url: `/admin/moderation/${it.id}`, headers: as(admin) })).json();
    expect(detail.voice).toMatchObject({ transcript: "mock transcript", provider: "mock" });
    expect(detail.voice.audioUrl).toContain(note.objectKey);
    expect(detail.context.find((c: { reported: boolean }) => c.reported).id).toBe(line.id);
  });

  it("are limited per user", async () => {
    const { app: tight } = await testApp({ limits: { ...app.limits, reportsPerHour: 2 } });
    const me = await person("rlimit");
    const targets = [await person("rl1"), await person("rl2"), await person("rl3")];
    const codes = [];
    for (const t of targets) codes.push((await tight.inject({ method: "POST", url: "/reports", headers: as(me), payload: { target: { type: "user", id: t.id }, reason: "spam_scam" } })).statusCode);
    expect(codes).toEqual([201, 201, 429]);
    await tight.close();
  });
});

// ---- holds ---------------------------------------------------------------------------------

describe("automatic holds", () => {
  it("hide a line for everyone once enough distinct people report it, logged and alerted; an admin releases it", async () => {
    const host = await person("hhost");
    const troll = await person("htroll");
    const p = await party(host);
    const t = await seat(p, troll);
    const reporters = [];
    for (let i = 0; i < DEFAULT_SAFETY_CONFIG.holdReporters; i++) { const r = await person(`hrep${i}`); await seat(p, r); reporters.push(r); }
    const line = await say(troll, t, "nasty line");
    for (const r of reporters.slice(0, -1)) await report(r, { target: { type: "message", id: line.id }, reason: "hate" });
    expect(await history(host, t)).toContain("nasty line");
    await report(reporters.at(-1)!, { target: { type: "message", id: line.id }, reason: "hate" });
    const held = await item("party_message", line.id);
    expect(held.heldAt).not.toBeNull();
    expect(await history(host, t)).not.toContain("nasty line");
    expect((await db.select().from(chatMessages).where(eq(chatMessages.id, line.id)))[0].hiddenAt).not.toBeNull();
    expect(await db.select().from(adminActions).where(and(eq(adminActions.targetId, held.id), eq(adminActions.action, "moderation.auto_hold")))).toHaveLength(1);
    expect((await db.select().from(adminAlerts).where(eq(adminAlerts.refId, held.id)))[0]).toMatchObject({ kind: "safety.content_held", severity: "warning" });

    const released = await app.inject({ method: "POST", url: `/admin/moderation/${held.id}/release`, headers: as(admin), payload: { reason: "it's a quote from the question" } });
    expect(released.json().item).toMatchObject({ heldAt: null, status: "open" });
    expect(await history(host, t)).toContain("nasty line");
  });

  it("hide a party's title and cover, and put them back on release", async () => {
    const host = await person("hphost");
    const p = await party(host);
    const reporters = await Promise.all(Array.from({ length: DEFAULT_SAFETY_CONFIG.holdReporters }, (_, i) => person(`hprep${i}`)));
    for (const r of reporters) await report(r, { target: { type: "party", id: p.id }, reason: "hate" });
    expect((await db.select().from(parties).where(eq(parties.id, p.id)))[0].title).toBe("Party under review");
    const held = await item("party", p.id);
    await app.inject({ method: "POST", url: `/admin/moderation/${held.id}/release`, headers: as(admin), payload: { reason: "the title is fine" } });
    expect((await db.select().from(parties).where(eq(parties.id, p.id)))[0].title).toBe("Safety test");
  });

  it("time a person out of chat once enough distinct people report their things in the window; an admin lifts it", async () => {
    const troll = await person("ttroll");
    const reporters = await Promise.all(Array.from({ length: DEFAULT_SAFETY_CONFIG.userTimeoutReporters }, (_, i) => person(`trep${i}`)));
    for (const r of reporters) await report(r, { target: { type: "user", id: troll.id }, reason: "harassment" });
    const timedOut = await reload(troll);
    expect(timedOut.chatTimeoutUntil!.getTime()).toBeGreaterThan(Date.now() + (DEFAULT_SAFETY_CONFIG.autoTimeoutHours - 1) * 3_600_000);
    expect(await db.select().from(adminActions).where(and(eq(adminActions.targetId, troll.id), eq(adminActions.action, "user.auto_chat_timeout")))).toHaveLength(1);
    expect((await db.select().from(adminAlerts).where(and(eq(adminAlerts.refId, troll.id), eq(adminAlerts.kind, "safety.user_timed_out")))).length).toBe(1);
    const p = await party(reporters[0]);
    const t = await seat(p, troll);
    expect(await refusal(say(timedOut, t, "let me talk"))).toBe("chat_timeout");
    await app.inject({ method: "POST", url: `/admin/users/${troll.id}/chat-timeout/lift`, headers: as(admin), payload: { reason: "reports were a pile-on" } });
    expect(await refusal(say(timedOut, t, "thanks"))).toBe("ok");
  });
});

// ---- moderation actions --------------------------------------------------------------------

describe("the moderation queue", () => {
  const reported = async (name: string, reasons: ReportBody["reason"][] = ["harassment"]) => {
    const subject = await person(`q${name}`);
    const host = await person(`qh${name}`);
    const p = await party(host);
    const t = await seat(p, subject);
    const line = await say(subject, t, `${name} said something`);
    const reps = [];
    for (const reason of reasons) { const r = await person(`qr${name}`); await seat(p, r); await report(r, { target: { type: "message", id: line.id }, reason }); reps.push(r); }
    return { subject, host, line, t, reps, item: await item("party_message", line.id) };
  };
  const notices = async (u: User) => (await app.inject({ url: "/me/notices", headers: as(u) })).json().notices as { id: string; kind: string; category: string | null; outcome: string | null }[];

  it("lists most-reported first, filtered by kind, reason and status, with the reasons counted", async () => {
    const two = await reported("list2", ["spam_scam", "spam_scam"]);
    const one = await reported("list1", ["cheating"]);
    const page = (await app.inject({ url: "/admin/moderation?type=party_message&limit=100", headers: as(admin) })).json();
    const ids = page.items.map((i: { id: string }) => i.id);
    expect(ids.indexOf(two.item.id)).toBeLessThan(ids.indexOf(one.item.id));
    expect(page.items.find((i: { id: string }) => i.id === two.item.id).reasons).toEqual([{ reason: "spam_scam", count: 2 }]);
    const byReason = (await app.inject({ url: "/admin/moderation?reason=cheating&limit=100", headers: as(admin) })).json().items.map((i: { id: string }) => i.id);
    expect(byReason).toContain(one.item.id);
    expect(byReason).not.toContain(two.item.id);
    expect((await app.inject({ url: "/admin/moderation", headers: as(two.subject) })).json().error).toBe("admin_only");
  });

  it("shows the context and the subject's history", async () => {
    const r = await reported("ctx");
    await say(r.host, r.t, "after it");
    await report(r.reps[0], { target: { type: "user", id: r.subject.id }, reason: "harassment" });
    const d = (await app.inject({ url: `/admin/moderation/${r.item.id}`, headers: as(admin) })).json();
    expect(d.context.map((c: { text: string }) => c.text)).toEqual(["ctx said something", "after it"]);
    expect(d.history.items.map((i: { kind: string }) => i.kind)).toEqual(["user"]);
    expect(d.reports).toHaveLength(1);
    expect(d.subjectState).toMatchObject({ bannedAt: null, chatTimeoutUntil: null });
  });

  it("dismiss: closed, a hold released, reporters hear 'reviewed'", async () => {
    const r = await reported("dismiss");
    const res = await act(r.item.id, { action: "dismiss", reason: "banter between friends" });
    expect(res.json().item).toMatchObject({ status: "dismissed", resolution: "dismiss" });
    expect(await notices(r.reps[0])).toMatchObject([{ kind: "report_outcome", outcome: "reviewed", category: null }]);
    expect(await db.select().from(adminActions).where(and(eq(adminActions.targetId, r.item.id), eq(adminActions.action, "moderation.dismiss")))).toHaveLength(1);
  });

  it("remove: hidden for good, 'action taken', and a deleted line can still be reviewed", async () => {
    const r = await reported("remove");
    await act(r.item.id, { action: "remove", reason: "hate speech" });
    expect(await history(r.host, r.t)).not.toContain("remove said something");
    expect((await app.inject({ url: `/admin/moderation/${r.item.id}`, headers: as(admin) })).json().item.snapshot.text).toBe("remove said something");
    const [note] = await notices(r.reps[0]);
    expect(note).toMatchObject({ outcome: "action_taken" });
    expect((await app.inject({ method: "POST", url: `/me/notices/${note.id}/seen`, headers: as(r.reps[0]) })).json()).toEqual({ ok: true });
    expect(await notices(r.reps[0])).toEqual([]);
  });

  it("warn: the subject gets a notice with the category, never the note", async () => {
    const r = await reported("warn", ["spam_scam"]);
    await act(r.item.id, { action: "warn", reason: "first time, posting links" });
    expect(await notices(r.subject)).toMatchObject([{ kind: "warning", category: "spam_scam", outcome: null }]);
  });

  it("chat timeout: no sending in party chat, DMs, crews or corner replies until it runs out", async () => {
    const r = await reported("timeout");
    const res = await act(r.item.id, { action: "chat_timeout", reason: "cool off", hours: 2 });
    expect(res.statusCode, res.body).toBe(200);
    const u = await reload(r.subject);
    expect(u.chatTimeoutUntil!.getTime()).toBeGreaterThan(Date.now() + 3_500_000);
    expect(await refusal(say(u, r.t, "still here"))).toBe("chat_timeout");
    const c = await unlockedCorner(r.host);
    await db.insert(follows).values({ followerId: u.id, cornerId: c.id });
    const post = (await app.inject({ method: "POST", url: `/corners/${c.id}/posts`, headers: as(r.host), payload: { text: "hello" } })).json();
    const reply = await app.inject({ method: "POST", url: `/corner-posts/${post.id}/replies`, headers: as(u), payload: { text: "hi", clientMsgId: randomUUID() } });
    expect(reply.json()).toMatchObject({ error: "chat_timeout", details: { until: u.chatTimeoutUntil!.toISOString() } });
    expect((await act(r.item.id, { action: "chat_timeout", reason: "no hours given" })).statusCode).toBe(400);
  });

  it("suspend: a ban until then, with the category on the banned screen; it runs out and lifts", async () => {
    const r = await reported("suspend", ["cheating"]);
    const res = await act(r.item.id, { action: "suspend", reason: "answer sharing", hours: 24 });
    expect(res.json()).toMatchObject({ item: { status: "actioned", resolution: "suspend" }, banRequestId: null });
    const me = await app.inject({ url: "/me", headers: as(r.subject) });
    expect(me.statusCode).toBe(403);
    expect(me.json()).toMatchObject({ error: "account_banned", details: { category: "cheating" } });
    expect(Date.parse(me.json().details.until)).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    // It ran out: it stops counting at once, and the sweep lifts it, logged.
    await db.update(users).set({ bannedUntil: new Date(Date.now() - 1000) }).where(eq(users.id, r.subject.id));
    expect((await app.inject({ url: "/me", headers: as(r.subject) })).statusCode).toBe(200);
    expect(await liftExpiredSuspensions()).toContain(r.subject.id);
    expect(await reload(r.subject)).toMatchObject({ bannedAt: null, bannedUntil: null, banCategory: null });
    expect(await db.select().from(adminActions).where(and(eq(adminActions.targetId, r.subject.id), eq(adminActions.action, "user.suspension_ended")))).toHaveLength(1);
  });

  it("ban: for good, until an admin unbans; reporters hear 'action taken'", async () => {
    const r = await reported("ban", ["hate"]);
    await act(r.item.id, { action: "ban", reason: "slurs in chat" });
    expect(await reload(r.subject)).toMatchObject({ banCategory: "hate", bannedUntil: null });
    expect((await app.inject({ url: "/me", headers: as(r.subject) })).json()).toEqual({ error: "account_banned", details: { category: "hate", until: null } });
    expect(await notices(r.reps[0])).toMatchObject([{ outcome: "action_taken" }]);
    await app.inject({ method: "POST", url: `/admin/users/${r.subject.id}/unban`, headers: as(admin), payload: { reason: "appeal upheld" } });
    expect((await app.inject({ url: "/me", headers: as(r.subject) })).statusCode).toBe(200);
  });
});

// ---- ban and the wallet --------------------------------------------------------------------

describe("a ban's effects", () => {
  const store = new Map<string, string>();
  const kv: KeyValue = { get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v); }, del: async (k) => { store.delete(k); } };
  const payDeps: PaymentsDeps = { async enqueue() {} };
  const banDeps = { announceCancelled: async () => {}, publishLine: async () => {}, emitSeats: async () => {} };

  beforeAll(async () => {
    const [cur] = await db.select().from(paymentSettings).orderBy(desc(paymentSettings.version)).limit(1);
    await db.insert(paymentSettings).values({ collections: cur?.collections ?? "mock", payouts: cur?.payouts ?? "mock", topupsPaused: false, payoutsPaused: false, changedBy: "admin", createdByUserId: admin.id, reason: "safety test" });
  });

  it("freezes the wallet, cancels and refunds their hosted open party, refunds their seat elsewhere, holds their withdrawal", async () => {
    const banned = await person("wban", { phone: `+23481${randomUUID().replace(/\D/g, "").slice(0, 8)}`, phoneVerifiedAt: new Date() });
    await fund(banned, "cash", kobo(20_000));
    await fund(banned, "bonus", kobo(50));
    const r = await resolveAccount(banned.id, { bankCode: "001", accountNumber: `02${String(Date.now()).slice(-8)}` }, kv);
    const account = await addBankAccount(banned.id, { resolveToken: r.resolveToken, accountName: r.accountName }, kv);
    const { payout } = await requestPayout(banned, { amountKobo: kobo(1500), bankAccountId: account.id, clientRequestId: randomUUID() }, payDeps);
    expect(payout.status).toBe("requested");

    // Their own staked party with a guest who paid, and a seat (bonus then cash) in someone else's.
    const player = await person("wplayer");
    await fund(player, "cash", kobo(500));
    const hosted = await party(banned, { entryKobo: kobo(200) });
    await seat(hosted, player);
    const other = await person("wother");
    const elsewhere = await party(other, { entryKobo: kobo(100) });
    await seat(elsewhere, banned);
    const before = await ledger.balances(banned.id);

    const res = await app.inject({ method: "POST", url: `/admin/users/${banned.id}/ban`, headers: as(admin), payload: { reason: "scamming players", category: "spam_scam" } });
    expect(res.statusCode, res.body).toBe(200);
    const out = await applyBanEffects(banDeps, banned.id);
    expect(out).toEqual({ cancelled: 1, seatsFreed: 1, withdrawalsHeld: 1 });

    expect((await db.select().from(parties).where(eq(parties.id, hosted.id)))[0]).toMatchObject({ status: "cancelled", cancelledBy: "admin" });
    expect((await ledger.balances(player.id)).cashKobo).toBe(kobo(500));
    expect(await db.select().from(partyPlayers).where(and(eq(partyPlayers.partyId, elsewhere.id), eq(partyPlayers.userId, banned.id)))).toEqual([]);
    const afterBal = await ledger.balances(banned.id);
    expect(afterBal.bonusKobo + afterBal.cashKobo).toBe(before.bonusKobo + before.cashKobo + kobo(100)); // the seat came back; nothing confiscated
    expect((await db.select().from(payouts).where(eq(payouts.id, payout.id)))[0]).toMatchObject({ status: "awaiting_approval", holdReason: "blocked:frozen" });

    const u = await reload(banned);
    expect(withdrawBlockReason(u, { owedKobo: 0 })).toBe("frozen");
    expect(await refusal(createTopup(u, kobo(1000), { returnUrl: "https://x.invalid" }))).toBe("wallet_frozen");
    const third = await party(other);
    expect(await refusal(seat(third, u))).toBe("wallet_frozen");
    // Run again: nothing moves.
    expect(await applyBanEffects(banDeps, banned.id)).toEqual({ cancelled: 0, seatsFreed: 0, withdrawalsHeld: 0 });

    // Unbanned: the wallet opens; the held withdrawal stays with a payments admin.
    await app.inject({ method: "POST", url: `/admin/users/${banned.id}/unban`, headers: as(admin), payload: { reason: "mistaken identity" } });
    expect(withdrawBlockReason(await reload(banned), { owedKobo: 0 })).toBeNull();
    expect((await db.select().from(payouts).where(eq(payouts.id, payout.id)))[0].status).toBe("awaiting_approval");
  });

  it("a suspension does the same, and lifting it unfreezes", async () => {
    const s = await person("wsusp");
    const other = await person("wsother");
    const elsewhere = await party(other);
    await seat(elsewhere, s);
    const res = await app.inject({ method: "POST", url: `/admin/users/${s.id}/suspend`, headers: as(admin), payload: { reason: "cooling off", hours: 48, category: "harassment" } });
    expect(res.json().user).toMatchObject({ banCategory: "harassment" });
    expect((await applyBanEffects(banDeps, s.id)).seatsFreed).toBe(1);
    expect(withdrawBlockReason({ ...(await reload(s)), phoneVerifiedAt: new Date() }, { owedKobo: 0 })).toBe("frozen");
    await app.inject({ method: "POST", url: `/admin/users/${s.id}/unsuspend`, headers: as(admin), payload: { reason: "spoke to them" } });
    expect(await reload(s)).toMatchObject({ bannedAt: null, bannedUntil: null });
    expect((await db.select().from(adminActions).where(and(eq(adminActions.targetId, s.id), eq(adminActions.action, "user.unsuspend")))).length).toBe(1);
  });
});

// ---- names ---------------------------------------------------------------------------------

describe("the name filter", () => {
  it("refuses slurs in handles, names, party titles, crew names and corner names; masks milder words", async () => {
    const u = await person("nfilter");
    const me = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/me", headers: as(u), payload: { displayName: "Tolu", handle: `nf${tag}`, ...payload } });
    expect((await me({ handle: `nyamiri${tag}` })).json()).toMatchObject({ error: "name_not_allowed", details: { field: "handle" } });
    expect((await me({ handle: `mumu_${tag}` })).json().error).toBe("name_not_allowed");
    expect((await me({ displayName: "omo ale" })).json().error).toBe("name_not_allowed");
    const masked = (await me({ displayName: "Mumu Tolu", bio: "no werey here" })).json();
    expect(masked).toMatchObject({ displayName: "M*** Tolu", bio: "no w**** here" });
    const created = await app.inject({ method: "POST", url: "/parties", headers: as(u), payload: { title: "Shege night", brief: "general knowledge", maxPlayers: 4, entryKobo: 0, funding: "pooled", split: "winner" } });
    expect(created.json().error).toBe("name_not_allowed");
    expect((await app.inject({ method: "POST", url: "/crews", headers: as(u), payload: { name: "Nyamiri squad" } })).json().error).toBe("name_not_allowed");
    const c = await unlockedCorner(u);
    expect((await app.inject({ method: "PATCH", url: "/me/corner", headers: as(u), payload: { name: "ashawo corner" } })).json().error).toBe("name_not_allowed");
    expect((await app.inject({ method: "PATCH", url: "/me/corner", headers: as(u), payload: { bio: "mumu questions only" } })).statusCode).toBe(200);
    expect((await db.select().from(corners).where(eq(corners.id, c.id)))[0].bio).toBe("m*** questions only");
  });
});

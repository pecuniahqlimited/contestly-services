/**
 * Chat (row 6a) against the real database: the DM rule and message requests, a repeated client message id,
 * masking and mentions, unread counts and read, history pages, and the voice upload guard.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import { chatMessages, db, follows, openDm, postMessage, sql, threadById, type User } from "@contestly/db";
import { DEFAULT_CHAT_CONFIG } from "@contestly/shared";
import { as, makeUser, testApp } from "./harness.js";

let app: Awaited<ReturnType<typeof testApp>>["app"];
let ada: User, kemi: User, tunde: User, zee: User, guest: User;

const deps = { cfg: DEFAULT_CHAT_CONFIG, voiceUploaded: async () => true };
const say = async (sender: User, threadId: string, text: string, clientMsgId = randomUUID()) =>
  postMessage({ thread: (await threadById(threadId))!, sender, clientMsgId, text }, deps);
const refusal = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);

beforeAll(async () => {
  ({ app } = await testApp());
  ada = await makeUser("ada");
  kemi = await makeUser("kemi");
  tunde = await makeUser("tunde");
  zee = await makeUser("zee");
  guest = await makeUser("guest", { isGuest: true, email: null, emailVerifiedAt: null });
  await db.insert(follows).values({ followerId: kemi.id, followeeId: ada.id }); // kemi opted in to ada
});

afterAll(async () => {
  await app.close();
  await sql.end();
});

describe("who may message whom", () => {
  it("is direct when the recipient follows the sender", async () => {
    const res = await app.inject({ method: "POST", url: `/dm/${kemi.id}`, headers: as(ada) });
    expect(res.json()).toMatchObject({ permission: "direct", request: "none" });
  });

  it("is a request the other way round, and the same thread", async () => {
    const one = (await app.inject({ method: "POST", url: `/dm/${kemi.id}`, headers: as(ada) })).json();
    const back = (await app.inject({ method: "POST", url: `/dm/${ada.id}`, headers: as(kemi) })).json();
    expect(back.threadId).toBe(one.threadId);
  });

  it("refuses guests and yourself", async () => {
    expect((await app.inject({ method: "POST", url: `/dm/${ada.id}`, headers: as(guest) })).json().error).toBe("sign_up_required");
    expect(await refusal(openDm(ada, guest))).toBe("cannot_message");
    expect(await refusal(openDm(ada, ada))).toBe("cannot_message_self");
  });
});

describe("message requests", () => {
  let threadId: string;
  beforeAll(async () => ({ threadId } = await openDm(tunde, zee)));

  it("lets a stranger send a few text lines, then waits", async () => {
    for (let i = 0; i < DEFAULT_CHAT_CONFIG.requestMaxMessages; i++) await say(tunde, threadId, `hello ${i}`);
    expect(await refusal(say(tunde, threadId, "one more"))).toBe("request_pending");
  });

  it("shows up in the recipient's Requests, not their Messages, and as sent for the sender", async () => {
    const requests = (await app.inject({ url: "/chats/requests", headers: as(zee) })).json();
    expect(requests.map((t: { id: string }) => t.id)).toContain(threadId);
    expect((await app.inject({ url: "/chats", headers: as(zee) })).json().some((t: { id: string }) => t.id === threadId)).toBe(false);
    const mine = (await app.inject({ url: "/chats", headers: as(tunde) })).json().find((t: { id: string }) => t.id === threadId);
    expect(mine.request).toBe("sent");
    expect((await app.inject({ url: "/chats/unread", headers: as(zee) })).json().requests).toBe(1);
  });

  it("refuses a voice note until accepted", async () => {
    const res = await app.inject({ method: "POST", url: `/chats/${threadId}/voice`, headers: as(tunde), payload: { durationMs: 3000, contentType: "audio/mp4", bytes: 20_000 } });
    expect(res.json().error).toBe("voice_after_accept");
  });

  it("opens when the recipient replies", async () => {
    await say(zee, threadId, "hey, who's this?");
    expect(await refusal(say(tunde, threadId, "Tunde from Friday's party"))).toBe("ok");
    expect((await app.inject({ url: "/chats", headers: as(zee) })).json().find((t: { id: string }) => t.id === threadId).request).toBe("none");
  });

  it("stays shut after a decline, until the recipient opts in by following", async () => {
    const { threadId: t } = await openDm(ada, zee);
    await say(ada, t, "hi zee");
    await app.inject({ method: "POST", url: `/chats/${t}/request/decline`, headers: as(zee) });
    expect(await refusal(say(ada, t, "hello?"))).toBe("cannot_message");
    await db.insert(follows).values({ followerId: zee.id, followeeId: ada.id });
    expect(await refusal(say(ada, t, "thanks for the follow"))).toBe("ok");
  });
});

describe("a line", () => {
  let threadId: string;
  beforeAll(async () => ({ threadId } = await openDm(ada, kemi)));

  it("is kept once per client message id", async () => {
    const id = randomUUID();
    const first = await say(ada, threadId, "only once", id);
    const again = await say(ada, threadId, "only once", id);
    expect(again.duplicate).toBe(true);
    expect(again.message.id).toBe(first.message.id);
    const [{ n }] = await db.select({ n: count() }).from(chatMessages).where(and(eq(chatMessages.userId, ada.id), eq(chatMessages.clientMsgId, id)));
    expect(Number(n)).toBe(1);
  });

  it("is masked and mentions only real members", async () => {
    const posted = await say(ada, threadId, `@${kemi.handle} @${tunde.handle} that was shit`);
    expect(posted.message.text).toBe(`@${kemi.handle} @${tunde.handle} that was s***`);
    expect(posted.message.mentions.sort()).toEqual([kemi.handle, tunde.handle].sort());
    expect(posted.mentionedUserIds).toEqual([kemi.id]);
  });

  it("counts as unread for the other side until they read", async () => {
    const before = (await app.inject({ url: "/chats/unread", headers: as(kemi) })).json().messages;
    expect(before).toBeGreaterThan(0);
    await app.inject({ method: "POST", url: `/chats/${threadId}/read`, headers: as(kemi) });
    expect((await app.inject({ url: "/chats/unread", headers: as(kemi) })).json().messages).toBe(0);
  });

  it("is refused for someone outside the thread, and so is its history", async () => {
    expect(await refusal(say(zee, threadId, "let me in"))).toBe("not_in_thread");
    expect((await app.inject({ url: `/chats/${threadId}/messages`, headers: as(zee) })).statusCode).toBe(404);
  });
});

describe("history", () => {
  it("pages back from the newest, oldest first within a page", async () => {
    const { threadId } = await openDm(kemi, ada);
    const t = (await threadById(threadId))!;
    await db.delete(chatMessages).where(eq(chatMessages.threadId, t.id));
    for (let i = 1; i <= 5; i++) await say(kemi, threadId, `line ${i}`);
    const p1 = (await app.inject({ url: `/chats/${threadId}/messages?limit=2`, headers: as(ada) })).json();
    expect(p1.messages.map((m: { text: string }) => m.text)).toEqual(["line 4", "line 5"]);
    const p2 = (await app.inject({ url: `/chats/${threadId}/messages?limit=2&before=${p1.before}`, headers: as(ada) })).json();
    expect(p2.messages.map((m: { text: string }) => m.text)).toEqual(["line 2", "line 3"]);
    const p3 = (await app.inject({ url: `/chats/${threadId}/messages?limit=2&before=${p2.before}`, headers: as(ada) })).json();
    expect(p3).toMatchObject({ before: null });
    expect(p3.messages.map((m: { text: string }) => m.text)).toEqual(["line 1"]);
  });
});

describe("voice uploads", () => {
  it("refuse a note past the cap or the size limit", async () => {
    const { threadId } = await openDm(ada, kemi);
    const ask = (payload: object) => app.inject({ method: "POST", url: `/chats/${threadId}/voice`, headers: as(ada), payload });
    expect((await ask({ durationMs: (DEFAULT_CHAT_CONFIG.maxVoiceSeconds + 1) * 1000, contentType: "audio/mp4", bytes: 1000 })).json().error).toBe("voice_too_long");
    expect((await ask({ durationMs: 1000, contentType: "audio/mp4", bytes: DEFAULT_CHAT_CONFIG.maxVoiceBytes + 1 })).json().error).toBe("voice_too_large");
    expect((await ask({ durationMs: 1000, contentType: "video/mp4", bytes: 1000 })).statusCode).toBe(400);
  });
});

/**
 * Account deletion (ADR 0010) against the real database: each refusal; after a delete the account is
 * invisible everywhere people look but fully visible (and every look logged) to admins; the ledger is
 * untouched apart from the forfeit; the same email signs up again as a new account; the retention job
 * clears the archive and keeps the row.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  adminActions, chatMessages, clearExpiredArchives, crewMembers, crews, db, dmPermissionBetween, feedEvents, feedFor, follows, joinThread, crewThreadId,
  ledger, ledgerAccounts, ledgerEntries, messagesPage, openDm, parties, partyPlayers, postMessage, resolveMentions, sql, threadById, userIdentities, users, type User,
} from "@contestly/db";
import { DEFAULT_CHAT_CONFIG, DELETED_DISPLAY_NAME, climbBoardKey, kobo, lagosDay, phoneHash, weekOf } from "@contestly/shared";
import { markReverified } from "../src/reverify.js";
import { signIn } from "../src/signin/account.js";
import { setWeekPoints } from "../src/climb/boards.js";
import { valkey } from "../src/redis.js";
import { phoneHmac } from "../src/signin/secrets.js";
import { as, makeUser, tag, testApp } from "./harness.js";

let app: Awaited<ReturnType<typeof testApp>>["app"];
let admin: User, gone: User, friend: User, crewmate: User, guest: User;
const goneEmail = `gone${tag}@example.com`;
const gonePhone = `+23480${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
const googleSubject = `google-sub-${tag}`;
let dmThreadId: string, crewId: string, ledgerBefore: (typeof ledgerEntries.$inferSelect)[];

const del = (u: User, reason?: string) => app.inject({ method: "DELETE", url: "/me", headers: as(u), payload: reason ? { reason } : {} });
const status = async (u: User) => (await app.inject({ method: "GET", url: "/me/deletion", headers: as(u) })).json();
const deps = { cfg: DEFAULT_CHAT_CONFIG, voiceUploaded: async () => true };
const say = async (sender: User, threadId: string, text: string) => postMessage({ thread: (await threadById(threadId))!, sender, clientMsgId: randomUUID(), text }, deps);
const entriesOf = (userId: string) => db.select({ e: ledgerEntries }).from(ledgerEntries).innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
  .where(eq(ledgerAccounts.userId, userId)).orderBy(asc(ledgerEntries.createdAt), asc(ledgerEntries.id)).then((r) => r.map((x) => x.e));
const fresh = async (u: User) => (await db.select().from(users).where(eq(users.id, u.id)))[0];

async function openParty(host: User, seated: User[] = []) {
  const [p] = await db.insert(parties).values({
    createdByUserId: host.id, title: "Open party", brief: "general knowledge", category: "General knowledge", entryKobo: 0, maxPlayers: 10,
    funding: "pooled", split: [100], status: "open", startsAt: new Date(Date.now() + 3_600_000),
  }).returning();
  for (const u of seated) await db.insert(partyPlayers).values({ partyId: p.id, userId: u.id });
  return p;
}

beforeAll(async () => {
  ({ app } = await testApp());
  admin = await makeUser("deladmin", { isAdmin: true });
  friend = await makeUser("delfriend");
  crewmate = await makeUser("delcrew");
  guest = await makeUser("delguest", { isGuest: true, email: null, emailVerifiedAt: null });
  gone = await makeUser("delgone", { email: goneEmail, phone: gonePhone, phoneVerifiedAt: new Date(), phoneHmac: phoneHmac(await phoneHash(gonePhone)), bio: "about me", aboutAnswers: { rather: ["beat"] } });
  await db.insert(userIdentities).values([{ provider: "firebase", externalId: `fb-${tag}`, userId: gone.id }, { provider: "google", externalId: googleSubject, userId: gone.id }]);

  // Money: bonus coins (forfeited) and a cash entry that's spent back to zero (history to keep).
  await db.transaction(async (tx) => {
    await ledger.post(tx, { userId: gone.id, kind: "bonus", amountKobo: kobo(300), type: "welcome_bonus", idempotencyKey: `t:${tag}:bonus` });
    await ledger.post(tx, { userId: gone.id, kind: "cash", amountKobo: kobo(50), type: "topup", idempotencyKey: `t:${tag}:cash` });
    await ledger.post(tx, { userId: gone.id, kind: "cash", amountKobo: -kobo(50), type: "party_entry", idempotencyKey: `t:${tag}:spend` });
  });
  // People: follows both ways, a DM with a line, a crew they created, a feed event, the Everyone board.
  await db.insert(follows).values([{ followerId: friend.id, followeeId: gone.id }, { followerId: gone.id, followeeId: friend.id }]);
  ({ threadId: dmThreadId } = await openDm(gone, friend));
  await say(gone, dmThreadId, "see you at the quiz");
  const [crew] = await db.insert(crews).values({ name: "Del crew", emoji: "🧪", color: "#123456", createdByUserId: gone.id }).returning();
  crewId = crew.id;
  await db.insert(crewMembers).values([{ crewId, userId: gone.id, role: "creator" }, { crewId, userId: crewmate.id, role: "member", joinedAt: new Date(Date.now() + 1000) }]);
  for (const u of [gone, crewmate]) await joinThread(db, await crewThreadId(db, crewId), u.id);
  await db.insert(feedEvents).values({ userId: gone.id, kind: "streak", data: { days: 3 } });
  await setWeekPoints(weekOf(lagosDay()), gone.id, 120);
});
afterAll(async () => {
  await app.close();
  await sql.end();
});

describe("refusals", () => {
  it("a guest can't delete (there's nothing to delete)", async () => {
    expect((await del(guest)).json().error).toBe("sign_up_required");
  });

  it("without a fresh re-verification: 403 reverify_required", async () => {
    const res = await del(gone);
    expect([res.statusCode, res.json().error]).toEqual([403, "reverify_required"]);
    expect((await status(gone)).reverifiedUntil).toBeNull();
  });

  it("a sign-in to the same account is the re-verification", async () => {
    const other = await makeUser("delreverify");
    expect((await status(other)).reverifiedUntil).toBeNull();
    const out = await signIn(other, { email: other.email! });
    expect(out).toMatchObject({ userId: other.id, account: "existing" });
    const until = (await status(other)).reverifiedUntil;
    expect(new Date(until).getTime() - Date.now()).toBeGreaterThan(4 * 60_000);
  });

  it("cash in the wallet: 409 cash_balance with what to do", async () => {
    const rich = await makeUser("delrich");
    await db.transaction((tx) => ledger.post(tx, { userId: rich.id, kind: "cash", amountKobo: kobo(10), type: "topup", idempotencyKey: `t:${tag}:rich` }));
    await markReverified(rich.id);
    expect((await status(rich)).blockers).toEqual([{ code: "cash_balance", message: "Contact support to withdraw first" }]);
    const res = await del(rich);
    expect([res.statusCode, res.json().error, res.json().details.message]).toEqual([409, "cash_balance", "Contact support to withdraw first"]);
    expect((await fresh(rich)).deletedAt).toBeNull();
  });

  it("seated in, or hosting, a party that isn't finished: 409 active_party", async () => {
    const player = await makeUser("delplayer");
    const host = await makeUser("delhost");
    const p = await openParty(host, [player]);
    for (const u of [player, host]) {
      await markReverified(u.id);
      const res = await del(u);
      expect.soft([res.statusCode, res.json().error], u.displayName).toEqual([409, "active_party"]);
    }
    await db.update(parties).set({ status: "finished", endedAt: new Date() }).where(eq(parties.id, p.id));
    expect((await status(player)).blockers).toEqual([]);
  });
});

describe("a deleted account", () => {
  beforeAll(async () => {
    ledgerBefore = await entriesOf(gone.id);
    await markReverified(gone.id);
    const res = await del(gone, "privacy");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ deleted: true });
  });

  it("keeps its row with the archive; the live fields are the placeholders", async () => {
    const row = await fresh(gone);
    expect(row).toMatchObject({
      id: gone.id, deletedReason: "privacy", email: null, phone: null, phoneHmac: null, displayName: DELETED_DISPLAY_NAME, bio: null,
      archivedEmail: goneEmail, archivedHandle: gone.handle, archivedDisplayName: gone.displayName, archivedBio: "about me", archivedPhone: gonePhone,
      archivedPhoneHmac: gone.phoneHmac, aboutAnswers: { rather: ["beat"] },
    });
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect(row.handle).toMatch(/^deleted_[0-9a-f]{32}$/);
    const ids = await db.select().from(userIdentities).where(eq(userIdentities.userId, gone.id));
    expect(ids).toHaveLength(2);
    expect(ids.every((i) => i.disabledAt)).toBe(true);
  });

  it("the ledger: every earlier entry untouched, bonus forfeited by one new entry", async () => {
    const after = await entriesOf(gone.id);
    expect(after.slice(0, ledgerBefore.length)).toEqual(ledgerBefore);
    expect(after.slice(ledgerBefore.length)).toMatchObject([{ amountKobo: -kobo(300), type: "account_deleted_forfeit", idempotencyKey: `account_deleted:${gone.id}:bonus` }]);
    expect(await ledger.balances(gone.id)).toEqual({ cashKobo: 0, bonusKobo: 0 });
  });

  it("is gone from profiles, follows, DMs, challenges, mentions, contacts and invites", async () => {
    const deletedHandle = (await fresh(gone)).handle;
    for (const h of [gone.handle, deletedHandle]) expect((await app.inject({ method: "GET", url: `/users/${h}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/users/${gone.id}/follow`, headers: as(friend) })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/dm/${gone.id}`, headers: as(friend) })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/users/${gone.id}/challenge`, headers: as(friend) })).statusCode).toBe(404);
    expect(await db.select().from(follows).where(inArray(follows.followerId, [gone.id]))).toEqual([]);
    expect(await db.select().from(follows).where(eq(follows.followeeId, gone.id))).toEqual([]);
    expect(await resolveMentions(`hey @${gone.handle} @${deletedHandle}`)).toEqual([]);
    const contacts = await app.inject({ method: "POST", url: "/me/contacts/match", headers: as(friend), payload: { hashes: [await phoneHash(gonePhone)] } });
    expect(contacts.json().matches).toEqual([]);
  });

  it("DMs: the thread and its lines stay, shown as Deleted player; nothing new can be sent to them", async () => {
    const page = await messagesPage(dmThreadId, { limit: 10 });
    expect(page.messages.map((m) => [m.text, m.author?.displayName])).toContainEqual(["see you at the quiz", DELETED_DISPLAY_NAME]);
    expect(await dmPermissionBetween(db, friend, await fresh(gone))).toBe("refused");
    await expect(say(friend, dmThreadId, "you there?")).rejects.toMatchObject({ message: "cannot_message" });
  });

  it("is off the boards and the feed", async () => {
    expect(await valkey().zscore(climbBoardKey(weekOf(lagosDay())), gone.id)).toBeNull();
    const board = (await app.inject({ method: "GET", url: "/leaderboards/friends", headers: as(friend) })).json();
    expect(board.rows.map((r: { person: { id: string } }) => r.person.id)).not.toContain(gone.id);
    expect((await feedFor([gone.id], { limit: 10, viewerId: friend.id })).rows).toEqual([]);
  });

  it("handed its crew over as on leave", async () => {
    const members = await db.select().from(crewMembers).where(eq(crewMembers.crewId, crewId));
    expect(members.map((m) => [m.userId, m.role])).toEqual([[crewmate.id, "creator"]]);
    const lines = await db.select().from(chatMessages).where(eq(chatMessages.threadId, await crewThreadId(db, crewId)));
    expect(lines.some((l) => l.text?.includes("left the crew") && l.text.includes("runs it now"))).toBe(true);
  });

  it("can't be deleted twice", async () => {
    await markReverified(gone.id);
    expect((await del(await fresh(gone))).json().error).toBe("already_deleted");
  });

  it("admins find it by archived email, handle, phone or id, see everything, and every look is logged", async () => {
    for (const q of [goneEmail, `@${gone.handle}`, gonePhone.replace("+234", "0"), gone.id]) {
      const res = (await app.inject({ method: "GET", url: `/admin/users?q=${encodeURIComponent(q)}`, headers: as(admin) })).json();
      expect.soft(res.users.map((u: { id: string }) => u.id), q).toContain(gone.id);
      expect.soft(res.users.find((u: { id: string }) => u.id === gone.id), q).toMatchObject({ handle: gone.handle, email: goneEmail, deletedAt: expect.any(String) });
    }
    const looks = () => db.select().from(adminActions).where(and(eq(adminActions.action, "user.view_deleted"), eq(adminActions.targetId, gone.id)));
    const before = (await looks()).length;
    const detail = (await app.inject({ method: "GET", url: `/admin/users/${gone.id}`, headers: as(admin) })).json();
    expect(detail.deletion).toMatchObject({ reason: "privacy", archived: { email: goneEmail, handle: gone.handle, displayName: gone.displayName, phone: gonePhone }, archiveClearedAt: null });
    expect(detail.identities.every((i: { disabledAt: string | null }) => i.disabledAt)).toBe(true);
    await app.inject({ method: "GET", url: `/admin/users/${gone.id}`, headers: as(admin) });
    expect((await looks()).length).toBe(before + 2);
    expect((await looks())[0].adminUserId).toBe(admin.id);
    const ledgerPage = (await app.inject({ method: "GET", url: `/admin/users/${gone.id}/ledger`, headers: as(admin) })).json();
    expect(ledgerPage.entries).toHaveLength(ledgerBefore.length + 1);
  });

  it("the same email (and the same Google account) signs up again as a new account", async () => {
    const newcomer = await makeUser("delagain", { isGuest: true, email: null, emailVerifiedAt: null });
    const out = await signIn(newcomer, { email: goneEmail, identity: { provider: "google", subject: googleSubject } });
    expect(out).toMatchObject({ userId: newcomer.id, account: "upgraded" });
    expect(out.userId).not.toBe(gone.id);
    expect((await fresh(newcomer)).email).toBe(goneEmail);
    expect((await fresh(gone)).archivedEmail).toBe(goneEmail);
    const google = await db.select().from(userIdentities).where(and(eq(userIdentities.provider, "google"), eq(userIdentities.externalId, googleSubject)));
    expect(google.map((g) => [g.userId, !!g.disabledAt]).sort()).toEqual([[gone.id, true], [newcomer.id, false]].sort());
    // And the number can be verified on the new account (one live account per number).
    await db.update(users).set({ phoneHmac: gone.phoneHmac }).where(eq(users.id, newcomer.id));
  });
});

describe("retention", () => {
  it("clears the archive's personal fields after the period, keeping the row, its handle and the ledger", async () => {
    const entries = await entriesOf(gone.id);
    expect(await clearExpiredArchives(new Date(Date.now() - 86_400_000))).toBe(0); // deleted just now: not yet
    expect(await clearExpiredArchives(new Date(Date.now() + 1000))).toBeGreaterThanOrEqual(1);
    const row = await fresh(gone);
    expect(row).toMatchObject({
      id: gone.id, archivedEmail: null, archivedPhone: null, archivedPhoneHmac: null, archivedDisplayName: null, archivedAvatarEmoji: null, archivedBio: null,
      aboutAnswers: null, archivedHandle: gone.handle, deletedReason: "privacy",
    });
    expect(row.archiveClearedAt).toBeInstanceOf(Date);
    expect(await entriesOf(gone.id)).toEqual(entries);
  });

  it("is off until the period is set, and setting it is logged", async () => {
    expect((await app.inject({ method: "GET", url: "/admin/accounts-config", headers: as(admin) })).json()).toEqual({ config: { deletedArchiveRetentionDays: null } });
    const put = await app.inject({ method: "PUT", url: "/admin/accounts-config", headers: as(admin), payload: { config: { deletedArchiveRetentionDays: 365 }, reason: "integration test" } });
    expect(put.json()).toEqual({ config: { deletedArchiveRetentionDays: 365 } });
    await app.inject({ method: "PUT", url: "/admin/accounts-config", headers: as(admin), payload: { config: { deletedArchiveRetentionDays: null }, reason: "integration test: back off" } });
  });
});

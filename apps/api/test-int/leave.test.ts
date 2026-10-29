/**
 * Leaving a party (POST /parties/:id/leave) against the real database: free and staked parties, the
 * refund leg by leg, replays and races, the lock and the host rule, rejoining (a new entry, its own keys),
 * the lobby event, and account deletion once the party is left.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import {
  adminCancelParty, chatMembers, db, ledger, ledgerAccounts, ledgerEntries, parties, partyLeaves, partyPlayers, partyThreadId, sql, takeSeat, type User,
} from "@contestly/db";
import { PARTY_EVENTS_CHANNEL, kobo, leavePartyResponseSchema } from "@contestly/shared";
import { markReverified } from "../src/reverify.js";
import { valkey } from "../src/redis.js";
import { as, makeUser, testApp } from "./harness.js";

let app: Awaited<ReturnType<typeof testApp>>["app"];
const ENTRY = kobo(100);
const leave = (u: User, partyId: string) => app.inject({ method: "POST", url: `/parties/${partyId}/leave`, headers: as(u) });
const join = (u: User, partyId: string) => app.inject({ method: "POST", url: `/parties/${partyId}/join`, headers: as(u) });
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000);

/** A party hosted (and, like a sealed host, sat in) by `host`. */
async function party(host: User, opts: { entryKobo?: number; startsAt?: Date; status?: "open" | "live" | "finished" | "cancelled" } = {}) {
  const [p] = await db.insert(parties).values({
    createdByUserId: host.id, title: "Leave test", brief: "general knowledge", category: "General knowledge", entryKobo: opts.entryKobo ?? 0,
    maxPlayers: 10, funding: "pooled", split: [100], status: opts.status ?? "open", startsAt: opts.startsAt ?? inMinutes(60), questionsStatus: "ready",
  }).returning();
  await db.transaction(async (tx) => {
    if (p.entryKobo) await ledger.post(tx, { userId: host.id, kind: "cash", amountKobo: p.entryKobo, type: "topup", idempotencyKey: `t:leave:host:${p.id}` });
    await takeSeat(tx, p, host.id, p.entryKobo);
  });
  return p;
}
const fund = (u: User, kind: "bonus" | "cash", amountKobo: number, key: string) =>
  db.transaction((tx) => ledger.post(tx, { userId: u.id, kind, amountKobo, type: "topup", idempotencyKey: `t:leave:${key}:${u.id}` }));
const entriesFor = (userId: string, partyId: string) => db.select({ e: ledgerEntries, kind: ledgerAccounts.kind }).from(ledgerEntries)
  .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
  .where(and(eq(ledgerAccounts.userId, userId), eq(ledgerEntries.refId, partyId))).then((r) => r.map(({ e, kind }) => ({ kind, type: e.type, amountKobo: Number(e.amountKobo), key: e.idempotencyKey })));
const seatOf = async (u: User, partyId: string) => (await db.select().from(partyPlayers).where(and(eq(partyPlayers.partyId, partyId), eq(partyPlayers.userId, u.id))))[0];

beforeAll(async () => { ({ app } = await testApp()); });
afterAll(async () => {
  await app.close();
  await sql.end();
});

describe("leaving a party", () => {
  it("a free party: a guest leaves, the seat is freed, the chat is left, the lobby hears it", async () => {
    const host = await makeUser("lvhost1");
    const guest = await makeUser("lvguest", { isGuest: true, email: null, emailVerifiedAt: null });
    const p = await party(host);
    expect((await join(guest, p.id)).statusCode).toBe(201);
    const sub = valkey().duplicate();
    const heard: unknown[] = [];
    await sub.subscribe(PARTY_EVENTS_CHANNEL);
    sub.on("message", (_c, m) => heard.push(JSON.parse(m)));

    const res = await leave(guest, p.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(leavePartyResponseSchema.parse(res.json())).toEqual({ left: true, replayed: false, refund: { toBonusKobo: 0, toCashKobo: 0 }, potKobo: 0, seats: { taken: 1, max: 10 } });
    expect(await seatOf(guest, p.id)).toBeUndefined();
    const thread = await partyThreadId(db, p.id);
    expect(await db.select().from(chatMembers).where(and(eq(chatMembers.threadId, thread), eq(chatMembers.userId, guest.id)))).toEqual([]);
    await expect.poll(() => heard).toContainEqual({ partyId: p.id, status: "player_left", userId: guest.id, seats: { taken: 1, max: 10 } });
    await sub.quit();
  });

  it("a staked party paid from bonus and cash: each comes back to where it was taken from, and the pot shrinks", async () => {
    const host = await makeUser("lvhost2");
    const ada = await makeUser("lvada");
    const p = await party(host, { entryKobo: ENTRY });
    await fund(ada, "bonus", kobo(60), "bonus");
    await fund(ada, "cash", kobo(500), "cash");
    const joined = (await join(ada, p.id)).json();
    expect(joined).toMatchObject({ paid: { fromBonus: kobo(60), fromCash: kobo(40) }, potKobo: 2 * ENTRY });
    const seat = await seatOf(ada, p.id);
    expect(await ledger.balances(ada.id)).toEqual({ bonusKobo: 0, cashKobo: kobo(460) });

    const res = (await leave(ada, p.id)).json();
    expect(res).toEqual({ left: true, replayed: false, refund: { toBonusKobo: kobo(60), toCashKobo: kobo(40) }, potKobo: ENTRY, seats: { taken: 1, max: 10 } });
    expect(await ledger.balances(ada.id)).toEqual({ bonusKobo: kobo(60), cashKobo: kobo(500) });
    expect((await entriesFor(ada.id, p.id)).sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { kind: "bonus", type: "party_entry", amountKobo: -kobo(60), key: `party_entry:${seat.id}:bonus` },
      { kind: "cash", type: "party_entry", amountKobo: -kobo(40), key: `party_entry:${seat.id}:cash` },
      { kind: "bonus", type: "party_leave_refund", amountKobo: kobo(60), key: `party_leave_refund:${seat.id}:bonus` },
      { kind: "cash", type: "party_leave_refund", amountKobo: kobo(40), key: `party_leave_refund:${seat.id}:cash` },
    ]);
    const [record] = await db.select().from(partyLeaves).where(eq(partyLeaves.entryId, seat.id));
    expect(record).toMatchObject({ partyId: p.id, userId: ada.id, refundedBonusKobo: kobo(60), refundedCashKobo: kobo(40) });

    // Leaving again is a no-op that answers the same.
    const again = (await leave(ada, p.id)).json();
    expect(again).toEqual({ ...res, replayed: true });
    expect(await entriesFor(ada.id, p.id)).toHaveLength(4);
    expect(await ledger.balances(ada.id)).toEqual({ bonusKobo: kobo(60), cashKobo: kobo(500) });
  });

  it("two leaves at once on the same entry: one refund, both answered 200", async () => {
    const host = await makeUser("lvhost3");
    const kemi = await makeUser("lvkemi");
    const p = await party(host, { entryKobo: ENTRY });
    await fund(kemi, "cash", ENTRY, "race");
    await join(kemi, p.id);
    const [a, b] = await Promise.all([leave(kemi, p.id), leave(kemi, p.id)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect([a.json().replayed, b.json().replayed].sort()).toEqual([false, true]);
    expect((await entriesFor(kemi.id, p.id)).filter((e) => e.type === "party_leave_refund")).toHaveLength(1);
    expect(await ledger.balances(kemi.id)).toEqual({ bonusKobo: 0, cashKobo: ENTRY });
  });

  it("leaving and rejoining charges a new entry; neither refund shares a key with the other", async () => {
    const host = await makeUser("lvhost4");
    const zee = await makeUser("lvzee");
    const p = await party(host, { entryKobo: ENTRY });
    await fund(zee, "cash", 2 * ENTRY, "rejoin");
    await join(zee, p.id);
    const first = await seatOf(zee, p.id);
    await leave(zee, p.id);
    expect((await join(zee, p.id)).json()).toMatchObject({ paid: { fromBonus: 0, fromCash: ENTRY } });
    const second = await seatOf(zee, p.id);
    expect(second.id).not.toBe(first.id);
    expect(await ledger.balances(zee.id)).toEqual({ bonusKobo: 0, cashKobo: ENTRY });
    expect((await leave(zee, p.id)).json()).toMatchObject({ replayed: false, refund: { toCashKobo: ENTRY } });
    const keys = (await entriesFor(zee.id, p.id)).map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual([`party_entry:${first.id}:cash`, `party_entry:${second.id}:cash`, `party_leave_refund:${first.id}:cash`, `party_leave_refund:${second.id}:cash`].sort());
    expect(await ledger.balances(zee.id)).toEqual({ bonusKobo: 0, cashKobo: 2 * ENTRY });

    // And a cancel after a rejoin refunds only the entry still seated.
    await join(zee, p.id);
    await db.transaction((tx) => adminCancelParty(tx, p.id));
    expect(await ledger.balances(zee.id)).toEqual({ bonusKobo: 0, cashKobo: 2 * ENTRY });
  });

  it("is refused inside the lock, once live, once over, for the host, and for someone who never joined", async () => {
    const host = await makeUser("lvhost5");
    const tunde = await makeUser("lvtunde");
    const soon = await party(host, { startsAt: inMinutes(1) });
    await db.transaction((tx) => takeSeat(tx, soon, tunde.id, 0));
    const live = await party(host, { status: "live" });
    await db.transaction((tx) => takeSeat(tx, live, tunde.id, 0));
    const over = await party(host, { status: "finished" });
    await db.transaction((tx) => takeSeat(tx, over, tunde.id, 0));
    const cancelled = await party(host, { status: "cancelled" });
    await db.transaction((tx) => takeSeat(tx, cancelled, tunde.id, 0));
    const open = await party(host);
    for (const [p, error] of [[soon, "party_locked"], [live, "party_locked"], [over, "party_closed"], [cancelled, "party_closed"]] as const) {
      const res = await leave(tunde, p.id);
      expect.soft([res.statusCode, res.json().error], error).toEqual([409, error]);
      expect(await seatOf(tunde, p.id)).toBeDefined();
    }
    expect((await leave(host, open.id)).json().error).toBe("host_must_cancel");
    expect(await seatOf(host, open.id)).toBeDefined();
    expect((await leave(tunde, open.id)).json().error).toBe("not_in_party");
  });
});

describe("account deletion and leaving", () => {
  it("the blocker lists each party and what to do; after leaving, the delete goes through", async () => {
    const host = await makeUser("lvhost6");
    const seun = await makeUser("lvseun");
    const later = await party(host);
    const soon = await party(host, { startsAt: inMinutes(1) });
    await join(seun, later.id);
    await db.transaction((tx) => takeSeat(tx, soon, seun.id, 0));
    await markReverified(seun.id);

    const blocked = await app.inject({ method: "DELETE", url: "/me", headers: as(seun), payload: {} });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: "active_party", details: { message: "A party you're in starts soon. Try again once it's over" } });
    expect(blocked.json().details.parties.map((p: { id: string; action: string }) => [p.id, p.action]).sort()).toEqual([[later.id, "leave"], [soon.id, "starts_soon"]].sort());

    // The one starting soon goes ahead without them (as the start job would); the other they leave.
    await db.update(parties).set({ status: "finished", endedAt: new Date() }).where(eq(parties.id, soon.id));
    const status = (await app.inject({ method: "GET", url: "/me/deletion", headers: as(seun) })).json();
    expect(status.blockers).toEqual([{ code: "active_party", message: "Leave or cancel your open parties first", parties: [expect.objectContaining({ id: later.id, action: "leave" })] }]);
    expect((await leave(seun, later.id)).statusCode).toBe(200);
    const deleted = await app.inject({ method: "DELETE", url: "/me", headers: as(seun), payload: {} });
    expect([deleted.statusCode, deleted.body]).toEqual([200, JSON.stringify({ deleted: true })]);
  });

  it("a host's own open party says cancel", async () => {
    const host = await makeUser("lvhost7");
    await party(host);
    const status = (await app.inject({ method: "GET", url: "/me/deletion", headers: as(host) })).json();
    expect(status.blockers[0].parties).toEqual([expect.objectContaining({ action: "cancel" })]);
  });
});

// Seats from before each had its own key are refunded under the key they were charged with.
describe("seats from before leaving existed", () => {
  it("leaving refunds an old seat's entry under its per-party key", async () => {
    const host = await makeUser("lvhost8");
    const old = await makeUser("lvold");
    const [p] = await db.insert(parties).values({ createdByUserId: host.id, title: "Old seat", category: "General knowledge", entryKobo: ENTRY, maxPlayers: 4, funding: "pooled", split: [100], startsAt: inMinutes(60) }).returning();
    await db.transaction(async (tx) => {
      await ledger.post(tx, { userId: old.id, kind: "cash", amountKobo: ENTRY, type: "topup", idempotencyKey: `t:leave:old:${p.id}` });
      await ledger.charge(tx, { userId: old.id, amountKobo: ENTRY, type: "party_entry", refType: "party", refId: p.id, idempotencyKey: `party_entry:${p.id}:${old.id}` });
      await tx.insert(partyPlayers).values({ partyId: p.id, userId: old.id });
    });
    expect((await leave(old, p.id)).json()).toMatchObject({ refund: { toCashKobo: ENTRY } });
    expect(await ledger.balances(old.id)).toEqual({ bonusKobo: 0, cashKobo: ENTRY });
    const keys = await db.select({ k: ledgerEntries.idempotencyKey }).from(ledgerEntries).where(and(like(ledgerEntries.idempotencyKey, `%${p.id}%`), inArray(ledgerEntries.type, ["party_entry"])));
    expect(keys.map((k) => k.k)).toEqual([`party_entry:${p.id}:${old.id}:cash`]);
  });
});

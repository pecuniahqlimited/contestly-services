/**
 * The host cancels their own party (POST /parties/:id/cancel) against the real database: every seat
 * refunded the way it was paid (bonus and cash), the host's prize released, inside the leave lock too;
 * live, over and other people refused; a retry answers the same; the room and the chat hear it; the host
 * can then delete their account. Also: joining tells the lobby the seat count.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminCancelParty, chatMembers, db, joinPartyThread, ledger, ledgerAccounts, ledgerEntries, messagesPage, parties, partyThreadId, sql, takeSeat, type User } from "@contestly/db";
import { PARTY_EVENTS_CHANNEL, hostCancelResponseSchema, kobo } from "@contestly/shared";
import { markReverified } from "../src/reverify.js";
import { valkey } from "../src/redis.js";
import { as, makeUser, testApp } from "./harness.js";

let app: Awaited<ReturnType<typeof testApp>>["app"];
const ENTRY = kobo(100);
const cancel = (u: User, partyId: string, payload: object = {}) => app.inject({ method: "POST", url: `/parties/${partyId}/cancel`, headers: as(u), payload });
const join = (u: User, partyId: string) => app.inject({ method: "POST", url: `/parties/${partyId}/join`, headers: as(u) });
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000);
const fund = (u: User, kind: "bonus" | "cash", amountKobo: number, key: string) =>
  db.transaction((tx) => ledger.post(tx, { userId: u.id, kind, amountKobo, type: "topup", idempotencyKey: `t:cancel:${key}:${u.id}` }));
const refundsTo = (userId: string, partyId: string) => db.select({ kind: ledgerAccounts.kind, amountKobo: ledgerEntries.amountKobo }).from(ledgerEntries)
  .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
  .where(and(eq(ledgerAccounts.userId, userId), eq(ledgerEntries.refId, partyId), eq(ledgerEntries.type, "party_refund")));

/** A sealed party: the host sits in it, pays their own entry and is in its chat, as POST /parties does. */
async function party(host: User, opts: { entryKobo?: number; startsAt?: Date; status?: "open" | "live" | "finished" } = {}) {
  const [p] = await db.insert(parties).values({
    createdByUserId: host.id, title: "Cancel test", brief: "general knowledge", category: "General knowledge", entryKobo: opts.entryKobo ?? 0,
    maxPlayers: 10, funding: "pooled", split: [100], status: opts.status ?? "open", startsAt: opts.startsAt ?? inMinutes(60), questionsStatus: "ready",
  }).returning();
  if (p.entryKobo) await fund(host, "cash", p.entryKobo, `host:${p.id}`);
  await db.transaction(async (tx) => {
    await takeSeat(tx, p, host.id, p.entryKobo);
    await joinPartyThread(tx, p.id, host.id);
  });
  return p;
}
async function listen() {
  const sub = valkey().duplicate();
  const heard: any[] = [];
  await sub.subscribe(PARTY_EVENTS_CHANNEL);
  sub.on("message", (_c, m) => heard.push(JSON.parse(m)));
  return { heard, stop: () => sub.quit() };
}

beforeAll(async () => { ({ app } = await testApp()); });
afterAll(async () => {
  await app.close();
  await sql.end();
});

describe("the host cancels", () => {
  it("a staked party: every seat back the way it was paid, the chat and the room told, who and why kept", async () => {
    const host = await makeUser("cxhost1");
    const [ada, kemi, zee] = await Promise.all(["cxada", "cxkemi", "cxzee"].map((n) => makeUser(n)));
    const p = await party(host, { entryKobo: ENTRY });
    await fund(ada, "bonus", kobo(30), "b"); await fund(ada, "cash", kobo(200), "c"); // 30 bonus + 70 cash
    await fund(kemi, "bonus", kobo(500), "b"); // all bonus
    await fund(zee, "cash", ENTRY, "c"); // all cash
    for (const u of [ada, kemi, zee]) expect((await join(u, p.id)).statusCode).toBe(201);
    const before = await Promise.all([host, ada, kemi, zee].map((u) => ledger.balances(u.id)));
    const room = await listen();

    const res = await cancel(host, p.id, { reason: "double-booked" });
    expect(res.statusCode, res.body).toBe(200);
    expect(hostCancelResponseSchema.parse(res.json())).toEqual({
      cancelled: true, replayed: false, refunded: { seats: 4, toBonusKobo: kobo(30) + ENTRY, toCashKobo: kobo(70) + ENTRY + ENTRY, prizeReleasedKobo: 0 },
    });
    expect(await ledger.balances(ada.id)).toEqual({ bonusKobo: kobo(30), cashKobo: kobo(200) });
    expect(await ledger.balances(kemi.id)).toEqual({ bonusKobo: kobo(500), cashKobo: 0 });
    expect(await ledger.balances(zee.id)).toEqual({ bonusKobo: 0, cashKobo: ENTRY });
    expect(await ledger.balances(host.id)).toEqual({ bonusKobo: before[0].bonusKobo, cashKobo: before[0].cashKobo + ENTRY });
    expect((await refundsTo(ada.id, p.id)).map((r) => [r.kind, Number(r.amountKobo)]).sort()).toEqual([["bonus", kobo(30)], ["cash", kobo(70)]]);

    const [row] = await db.select().from(parties).where(eq(parties.id, p.id));
    expect(row).toMatchObject({ status: "cancelled", cancelledBy: "host", cancelledByUserId: host.id, cancelReason: "double-booked" });
    expect(row.endedAt).toBeInstanceOf(Date);
    const message = "The host cancelled this party. Your entry is back in your wallet.";
    await expect.poll(() => room.heard).toContainEqual({ partyId: p.id, status: "cancelled", by: "host", message });
    await room.stop();
    // The chat says so and stays readable to everyone who was in it.
    const thread = await partyThreadId(db, p.id);
    expect((await messagesPage(thread, { limit: 5 })).messages.map((m) => m.text)).toContain(message);
    expect((await db.select().from(chatMembers).where(eq(chatMembers.threadId, thread))).map((m) => m.userId).sort()).toEqual([host.id, ada.id, kemi.id, zee.id].sort());

    // Cancelling again is a no-op that answers the same.
    const again = await cancel(host, p.id);
    expect(again.json()).toEqual({ ...res.json(), replayed: true });
    expect(await refundsTo(ada.id, p.id)).toHaveLength(2);
    expect(await ledger.balances(ada.id)).toEqual({ bonusKobo: kobo(30), cashKobo: kobo(200) });
  });

  it("a free party: no wallet line; a host's cash prize is released to them", async () => {
    const host = await makeUser("cxhost2");
    const free = await party(host);
    const room = await listen();
    expect((await cancel(host, free.id)).json().refunded).toEqual({ seats: 1, toBonusKobo: 0, toCashKobo: 0, prizeReleasedKobo: 0 });
    await expect.poll(() => room.heard).toContainEqual({ partyId: free.id, status: "cancelled", by: "host", message: "The host cancelled this party." });
    await room.stop();

    const [prize] = await db.insert(parties).values({ createdByUserId: host.id, title: "Prize", category: "General knowledge", maxPlayers: 10, funding: "host", hostPoolKobo: kobo(1000), split: [100], startsAt: inMinutes(60) }).returning();
    await fund(host, "cash", kobo(1000), `prize:${prize.id}`);
    await db.transaction((tx) => ledger.hold(tx, { userId: host.id, amountKobo: kobo(1000), type: "party_fund", refType: "party", refId: prize.id, idempotencyKey: `party_fund:${prize.id}` }));
    const before = await ledger.balances(host.id);
    expect((await cancel(host, prize.id)).json().refunded).toEqual({ seats: 0, toBonusKobo: 0, toCashKobo: 0, prizeReleasedKobo: kobo(1000) });
    expect(await ledger.balances(host.id)).toEqual({ ...before, cashKobo: before.cashKobo + kobo(1000) });
  });

  it("works inside the 2-minute lock; refused once live, once over, for anyone else", async () => {
    const host = await makeUser("cxhost3");
    const other = await makeUser("cxother");
    const soon = await party(host, { startsAt: inMinutes(1) });
    expect((await cancel(host, soon.id)).statusCode).toBe(200);
    const live = await party(host, { status: "live" });
    expect([(await cancel(host, live.id)).statusCode, (await cancel(host, live.id)).json().error]).toEqual([409, "party_live"]);
    const over = await party(host, { status: "finished" });
    expect((await cancel(host, over.id)).json().error).toBe("party_closed");
    const byAdmin = await party(host);
    await db.transaction((tx) => adminCancelParty(tx, byAdmin.id));
    expect((await cancel(host, byAdmin.id)).json().error).toBe("party_closed"); // not the host's cancel to replay
    expect((await db.select().from(parties).where(eq(parties.id, byAdmin.id)))[0].cancelledBy).toBe("admin");
    const open = await party(host);
    await join(other, open.id);
    const res = await cancel(other, open.id);
    expect([res.statusCode, res.json().error]).toEqual([403, "not_host"]);
    expect((await db.select().from(parties).where(eq(parties.id, open.id)))[0].status).toBe("open");
  });

  it("then the host can delete their account", async () => {
    const host = await makeUser("cxhost4");
    const p = await party(host);
    await markReverified(host.id);
    const blocked = await app.inject({ method: "DELETE", url: "/me", headers: as(host), payload: {} });
    expect(blocked.json()).toMatchObject({ error: "active_party", details: { message: "Leave or cancel your open parties first", parties: [{ id: p.id, action: "cancel" }] } });
    expect((await cancel(host, p.id)).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: "/me", headers: as(host), payload: {} })).json()).toEqual({ deleted: true });
  });
});

describe("the seat count on join", () => {
  it("joining tells the lobby the new count", async () => {
    const host = await makeUser("cxhost5");
    const seun = await makeUser("cxseun");
    const p = await party(host);
    const room = await listen();
    expect((await join(seun, p.id)).statusCode).toBe(201);
    await expect.poll(() => room.heard).toContainEqual({ partyId: p.id, status: "player_joined", userId: seun.id, seats: { taken: 2, max: 10 } });
    // A replayed join changes nothing and says nothing.
    room.heard.length = 0;
    await join(seun, p.id);
    await new Promise((r) => setTimeout(r, 200));
    expect(room.heard.filter((e) => e.partyId === p.id)).toEqual([]);
    await room.stop();
  });
});

/**
 * The worker's stall check (apps/worker/src/partyStart.ts sweepStalled) against the real database: a live
 * party whose room isn't moving is re-kicked once, then cancelled by the system with every seat refunded
 * the way it was paid, and never settled; a healthy one, or one that comes back after the re-kick, is left
 * alone. Also: Colyseus's Redis presence resubscribes after its Valkey connection drops, so the room hears
 * party:events again.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { RedisPresence } from "colyseus";
import { db, getPartyConfig, ledger, markRoundProgress, parties, sql, takeSeat, type User } from "@contestly/db";
import { REDIS_URL } from "@contestly/queue";
import { DEFAULT_PARTY_CONFIG, kobo, stallThresholdSeconds, type ChatMessage } from "@contestly/shared";
import { STALLED_MESSAGE, sweepStalled } from "../../worker/src/partyStart.js";
import { valkey } from "../src/redis.js";
import { makeUser } from "./harness.js";

const ENTRY = kobo(100);
const QUESTION_SECONDS = 10;
const events: { partyId: string; status: string }[] = [];
const lines: ChatMessage[] = [];
const deps = { emit: async (ev: { partyId: string; status: string }) => events.push(ev), publishLine: async (l: ChatMessage) => lines.push(l) };
const at = (base: Date, seconds: number) => new Date(base.getTime() + seconds * 1000);

/** A live party with seats paid from bonus and cash; liveAt is when it went live. */
async function liveParty(liveAt: Date, players: User[]) {
  const [p] = await db.insert(parties).values({
    createdByUserId: players[0].id, title: `Stall ${randomUUID().slice(0, 6)}`, category: "General knowledge", entryKobo: ENTRY, maxPlayers: 10,
    funding: "pooled", split: [100], status: "live", startsAt: liveAt, liveAt, questionsStatus: "ready", questionSeconds: QUESTION_SECONDS,
  }).returning();
  for (const [i, u] of players.entries()) {
    await db.transaction(async (tx) => {
      if (i % 2 === 0) await ledger.post(tx, { userId: u.id, kind: "bonus", amountKobo: kobo(40), type: "topup", idempotencyKey: `t:stall:b:${p.id}:${u.id}` });
      await ledger.post(tx, { userId: u.id, kind: "cash", amountKobo: ENTRY, type: "topup", idempotencyKey: `t:stall:c:${p.id}:${u.id}` });
      await takeSeat(tx, p, u.id, ENTRY);
    });
  }
  return p;
}
const row = async (id: string) => (await db.select().from(parties).where(eq(parties.id, id)))[0];
const mine = (out: { id: string }[], id: string) => out.filter((o) => o.id === id);

afterAll(async () => { await sql.end(); });

describe("stalled live parties", () => {
  it("re-kicked once, then cancelled with every seat refunded the way it was paid", async () => {
    const cfg = await getPartyConfig();
    const thresholdS = stallThresholdSeconds(QUESTION_SECONDS, cfg);
    const players = await Promise.all(["stA", "stB", "stC"].map((n) => makeUser(n)));
    const liveAt = new Date(Date.now() - 60_000);
    const p = await liveParty(liveAt, players);
    const before = await Promise.all(players.map((u) => ledger.balances(u.id)));

    // Inside the threshold: nothing.
    expect(mine(await sweepStalled(deps, at(liveAt, thresholdS - 1)), p.id)).toEqual([]);

    // Past it: the start is republished, once.
    const kickAt = at(liveAt, thresholdS + 5);
    expect(mine(await sweepStalled(deps, kickAt), p.id)).toEqual([{ id: p.id, title: p.title, stalledMs: (thresholdS + 5) * 1000, outcome: "rekicked" }]);
    expect(events).toContainEqual({ partyId: p.id, status: "live" });
    expect((await row(p.id)).stallRekickedAt).toEqual(kickAt);
    expect(mine(await sweepStalled(deps, at(kickAt, 10)), p.id)).toEqual([]); // the re-kick gets its chance

    // Still nothing a threshold later: cancelled by the system, everyone back where they started.
    const endAt = at(kickAt, thresholdS);
    expect(mine(await sweepStalled(deps, endAt), p.id)).toMatchObject([{ id: p.id, outcome: "cancelled" }]);
    const ended = await row(p.id);
    expect(ended).toMatchObject({ status: "cancelled", cancelledBy: "system" });
    // Seats 0 and 2 paid ₦40 bonus + ₦60 cash, seat 1 ₦100 cash: each gets back exactly that.
    expect(await Promise.all(players.map((u) => ledger.balances(u.id)))).toEqual([
      { bonusKobo: kobo(40), cashKobo: ENTRY }, { bonusKobo: 0, cashKobo: ENTRY }, { bonusKobo: kobo(40), cashKobo: ENTRY },
    ]);
    expect(before).toEqual([{ bonusKobo: 0, cashKobo: kobo(40) }, { bonusKobo: 0, cashKobo: 0 }, { bonusKobo: 0, cashKobo: kobo(40) }]);
    expect(events).toContainEqual({ partyId: p.id, status: "cancelled" });
    expect(lines.some((l) => l.text === STALLED_MESSAGE)).toBe(true);
    // Done: later sweeps leave it alone.
    expect(mine(await sweepStalled(deps, at(endAt, 600)), p.id)).toEqual([]);
  });

  it("a healthy party, opening questions, is left alone", async () => {
    const players = await Promise.all(["stD", "stE"].map((n) => makeUser(n)));
    const liveAt = new Date(Date.now() - 10 * 60_000);
    const p = await liveParty(liveAt, players);
    const now = new Date();
    await markRoundProgress(p.id, at(now, -5));
    expect(mine(await sweepStalled(deps, now), p.id)).toEqual([]);
    expect(await row(p.id)).toMatchObject({ status: "live", stallRekickedAt: null });
  });

  it("one that comes back after the re-kick isn't cancelled, and a later stall starts over with a re-kick", async () => {
    const thresholdS = stallThresholdSeconds(QUESTION_SECONDS, DEFAULT_PARTY_CONFIG);
    const players = await Promise.all(["stF", "stG"].map((n) => makeUser(n)));
    const liveAt = new Date(Date.now() - 60 * 60_000);
    const p = await liveParty(liveAt, players);
    const kickAt = at(liveAt, thresholdS + 1);
    expect(mine(await sweepStalled(deps, kickAt), p.id)[0]?.outcome).toBe("rekicked");
    await markRoundProgress(p.id, at(kickAt, 3)); // the room picked it up
    expect(mine(await sweepStalled(deps, at(kickAt, thresholdS + 1)), p.id)).toEqual([]);
    expect((await row(p.id)).status).toBe("live");
    // It stalls again much later: a fresh re-kick, not a cancel.
    expect(mine(await sweepStalled(deps, at(kickAt, 3 + thresholdS + 1)), p.id)[0]?.outcome).toBe("rekicked");
    expect((await row(p.id)).status).toBe("live");
  });

  it("while its set is still being sealed, it waits for the generation timeout, not the round threshold", async () => {
    const players = await Promise.all(["stH", "stI"].map((n) => makeUser(n)));
    const liveAt = new Date(Date.now() - 60_000);
    const p = await liveParty(liveAt, players);
    await db.update(parties).set({ questionsStatus: "generating" }).where(eq(parties.id, p.id));
    expect(mine(await sweepStalled(deps, at(liveAt, stallThresholdSeconds(QUESTION_SECONDS, DEFAULT_PARTY_CONFIG) + 5)), p.id)).toEqual([]);
  });
});

describe("realtime's subscription to party:events", () => {
  it("comes back by itself after the Valkey connection drops", async () => {
    const presence = new RedisPresence(REDIS_URL);
    const sub = (presence as unknown as { sub: { client(cmd: "ID"): Promise<number> } }).sub;
    const id = await sub.client("ID"); // before subscribing (a subscribed connection takes only pub/sub commands)
    const channel = `test:party-events:${randomUUID()}`;
    const heard: unknown[] = [];
    await presence.subscribe(channel, (m: unknown) => heard.push(m));
    await valkey().publish(channel, JSON.stringify({ n: 1 }));
    await expect.poll(() => heard.length).toBe(1);

    await valkey().client("KILL", "ID", String(id)); // the connection drops, as on a Valkey restart or network blip
    await expect.poll(async () => {
      await valkey().publish(channel, JSON.stringify({ n: 2 }));
      return heard.length > 1;
    }, { timeout: 10_000, interval: 250 }).toBe(true);
    presence.shutdown();
  });
});

/**
 * The heartbeat watchdog (apps/worker/src/watchdog.ts) against the real database: a missed heartbeat is looked at
 * again, two in a row re-kick the room once, and only a room still silent and not moving after that is refunded.
 * A room that comes back, or whose rounds still progress without a heartbeat, is never refunded.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, ledger, parties, partyQuestions, sql, takeSeat, type User } from "@contestly/db";
import { kobo, type ChatMessage } from "@contestly/shared";
import { INTERRUPTED_MESSAGE } from "../../worker/src/partyStart.js";
import { watchdogLink, type WatchdogDeps, type WatchState } from "../../worker/src/watchdog.js";
import { makeUser } from "./harness.js";

const ENTRY = kobo(100);
const events: { partyId: string; status: string }[] = [];
const lines: ChatMessage[] = [];
const nexts: string[] = [];
const alive = new Set<string>();
const remembered = new Map<string, WatchState>();
const deps: WatchdogDeps = {
  emit: async (ev) => events.push(ev), publishLine: async (l) => lines.push(l), settle: async () => false,
  roomAlive: async (id) => alive.has(id),
  next: async (id) => nexts.push(id),
  memory: { get: async (id) => remembered.get(id) ?? null, set: async (id, s) => remembered.set(id, s), clear: async (id) => remembered.delete(id) },
};
const at = (seconds: number) => new Date(Date.now() + seconds * 1000);

/** A live party mid-set (one question played, one to go), its players' entries paid in cash. */
async function liveParty(players: User[]) {
  const liveAt = new Date(Date.now() - 60_000);
  const [p] = await db.insert(parties).values({
    createdByUserId: players[0].id, title: `Watchdog ${randomUUID().slice(0, 6)}`, category: "General knowledge", entryKobo: ENTRY, maxPlayers: 10,
    funding: "pooled", split: [100], status: "live", startsAt: liveAt, liveAt, questionsStatus: "ready", questionSeconds: 10,
  }).returning();
  for (const u of players) {
    await db.transaction(async (tx) => {
      await ledger.post(tx, { userId: u.id, kind: "cash", amountKobo: ENTRY, type: "topup", idempotencyKey: `t:wd:${p.id}:${u.id}` });
      await takeSeat(tx, p, u.id, ENTRY);
    });
  }
  for (const [idx, status] of (["played", "pending"] as const).entries()) {
    await db.insert(partyQuestions).values({ partyId: p.id, idx, format: "pick_one", payload: { question: `q${idx}`, options: ["a", "b"], correctIndex: 0 }, seconds: 10, status });
  }
  return p;
}
const row = async (id: string) => (await db.select().from(parties).where(eq(parties.id, id)))[0];
const players = (tag: string) => Promise.all(["a", "b"].map((n) => makeUser(`wd${tag}${n}`)));

afterAll(async () => { await sql.end(); });

describe("the heartbeat watchdog", () => {
  it("a single missed heartbeat: looked at again, nothing refunded; a heartbeat back starts the count again", async () => {
    const p = await liveParty(await players("one"));
    expect(await watchdogLink(deps, p.id, "link1", at(0))).toBe("missed");
    expect(nexts.filter((id) => id === p.id)).toHaveLength(1);
    expect(events.filter((e) => e.partyId === p.id)).toEqual([]);
    alive.add(p.id);
    expect(await watchdogLink(deps, p.id, "link2", at(30))).toBe("alive");
    expect(remembered.has(p.id)).toBe(false);
    alive.delete(p.id);
    // Not two in a row: one more miss is a first miss again, not a re-kick.
    expect(await watchdogLink(deps, p.id, "link3", at(60))).toBe("missed");
    expect(await row(p.id)).toMatchObject({ status: "live", stallRekickedAt: null });
  });

  it("two in a row re-kick the room once (logged on the party); a room that comes back is never refunded", async () => {
    const [a, b] = await players("back");
    const p = await liveParty([a, b]);
    expect(await watchdogLink(deps, p.id, "link4", at(0))).toBe("missed");
    const kickAt = at(30);
    expect(await watchdogLink(deps, p.id, "link5", kickAt)).toBe("rekicked");
    expect(events).toContainEqual({ partyId: p.id, status: "live" });
    expect((await row(p.id)).stallRekickedAt).toEqual(kickAt);
    alive.add(p.id);
    expect(await watchdogLink(deps, p.id, "link6", at(60))).toBe("alive");
    expect((await row(p.id)).status).toBe("live");
    expect(await ledger.balances(a.id)).toEqual({ bonusKobo: 0, cashKobo: 0 });
    alive.delete(p.id);
  });

  it("no heartbeat, but a question opened since the re-kick: still progressing, never refunded", async () => {
    const p = await liveParty(await players("prog"));
    await watchdogLink(deps, p.id, "link7", at(0));
    const kickAt = at(30);
    expect(await watchdogLink(deps, p.id, "link8", kickAt)).toBe("rekicked");
    await db.update(parties).set({ roundProgressAt: at(40) }).where(eq(parties.id, p.id));
    expect(await watchdogLink(deps, p.id, "link9", at(60))).toBe("progressing");
    expect((await row(p.id)).status).toBe("live");
    // And the count starts again: the next miss is a first one.
    expect(await watchdogLink(deps, p.id, "link10", at(90))).toBe("missed");
  });

  it("a retried link repeats its own step: a retry of the re-kick never refunds", async () => {
    const p = await liveParty(await players("retry"));
    expect(await watchdogLink(deps, p.id, "r1", at(0))).toBe("missed");
    expect(await watchdogLink(deps, p.id, "r1", at(1))).toBe("missed"); // the same link again: not a second look
    expect((await row(p.id)).stallRekickedAt).toBeNull();
    expect(await watchdogLink(deps, p.id, "r2", at(30))).toBe("rekicked");
    expect(await watchdogLink(deps, p.id, "r2", at(31))).toBe("rekicked");
    expect((await row(p.id)).status).toBe("live");
    expect(await watchdogLink(deps, p.id, "r3", at(60))).toBe("refunded");
  });

  it("a room that's really gone: refunded after the re-kick, every entry back", async () => {
    const [a, b] = await players("gone");
    const p = await liveParty([a, b]);
    expect(await watchdogLink(deps, p.id, "link11", at(0))).toBe("missed");
    expect(await watchdogLink(deps, p.id, "link12", at(30))).toBe("rekicked");
    expect((await row(p.id)).status).toBe("live");
    expect(await watchdogLink(deps, p.id, "link13", at(60))).toBe("refunded");
    expect(await row(p.id)).toMatchObject({ status: "cancelled", cancelledBy: "system" });
    for (const u of [a, b]) expect(await ledger.balances(u.id)).toEqual({ bonusKobo: 0, cashKobo: ENTRY });
    expect(events).toContainEqual({ partyId: p.id, status: "cancelled" });
    expect(lines.some((l) => l.text === INTERRUPTED_MESSAGE)).toBe(true);
    // Retired from here.
    expect(await watchdogLink(deps, p.id, "link14", at(90))).toBe("retired");
    expect(remembered.has(p.id)).toBe(false);
  });
});

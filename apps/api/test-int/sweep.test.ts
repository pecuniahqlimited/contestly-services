/**
 * The worker's overdue-party sweep (apps/worker/src/partyStart.ts) against the real database: a party past
 * its start by more than the grace period starts if it can, or is cancelled with refunds; anything inside
 * the grace period, in the future or already started is left alone; a second sweep does nothing.
 */
import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, getPartyConfig, ledger, parties, partyPlayers, sql, type User } from "@contestly/db";
import { kobo } from "@contestly/shared";
import { SWEEP_GRACE_MS, sweepOverdue, type StartDeps } from "../../worker/src/partyStart.js";
import { makeUser, tag } from "./harness.js";

const events: { partyId: string; status: string }[] = [];
const watchdogs: string[] = [];
const deps: StartDeps = {
  emit: async (ev) => events.push(ev),
  publishLine: async () => undefined,
  queueQuestions: async () => undefined,
  queueWatchdog: async (id) => watchdogs.push(id),
};
const now = new Date();
const ENTRY = kobo(100);

async function party(name: string, startsAt: Date, players: User[], status: "open" | "live" = "open") {
  const [p] = await db.insert(parties).values({
    createdByUserId: players[0]?.id ?? (await makeUser(`sweephost${name}`)).id, title: `sweep ${name} ${tag}`, category: "General knowledge", maxPlayers: 10,
    funding: "pooled", entryKobo: ENTRY, split: [100], status, startsAt, questionsStatus: "ready",
  }).returning();
  for (const u of players) {
    await db.transaction(async (tx) => {
      await ledger.post(tx, { userId: u.id, kind: "cash", amountKobo: ENTRY, type: "topup", idempotencyKey: `t:sweep:${p.id}:${u.id}` });
      await ledger.charge(tx, { userId: u.id, amountKobo: ENTRY, type: "party_entry", refType: "party", refId: p.id, idempotencyKey: `party_entry:${p.id}:${u.id}` });
      await tx.insert(partyPlayers).values({ partyId: p.id, userId: u.id });
    });
  }
  return p;
}
const statusOf = async (id: string) => (await db.select().from(parties).where(eq(parties.id, id)))[0].status;

afterAll(async () => { await sql.end(); });

describe("the overdue-party sweep", () => {
  it("starts what can start, cancels and refunds what can't, and leaves the rest alone", async () => {
    const { minPlayers } = await getPartyConfig();
    const crowd = await Promise.all(Array.from({ length: Math.max(minPlayers, 2) }, (_, i) => makeUser(`sweepcrowd${i}`)));
    const loner = await makeUser("sweeploner");
    const late = new Date(now.getTime() - 10 * 60_000);
    const full = await party("full", late, crowd);
    const empty = await party("empty", late, minPlayers > 1 ? [loner] : []);
    const withinGrace = await party("grace", new Date(now.getTime() - SWEEP_GRACE_MS / 2), []);
    const future = await party("future", new Date(now.getTime() + 60_000), []);
    const alreadyLive = await party("live", late, [], "live");

    const swept = await sweepOverdue(deps, now);
    const mine = swept.filter((s) => [full.id, empty.id, withinGrace.id, future.id, alreadyLive.id].includes(s.id));
    expect(mine.map((s) => [s.id, s.outcome]).sort()).toEqual([[full.id, "live"], [empty.id, "cancelled"]].sort());
    expect(mine.every((s) => s.lateMs >= 10 * 60_000)).toBe(true);

    expect(await statusOf(full.id)).toBe("live");
    expect(events).toContainEqual({ partyId: full.id, status: "live" });
    expect(watchdogs).toContain(full.id);
    expect(await statusOf(empty.id)).toBe("cancelled");
    expect(events).toContainEqual({ partyId: empty.id, status: "cancelled" });
    if (minPlayers > 1) expect(await ledger.balances(loner.id)).toEqual({ cashKobo: ENTRY, bonusKobo: 0 });
    for (const p of [withinGrace, future]) expect(await statusOf(p.id)).toBe("open");
    expect(await statusOf(alreadyLive.id)).toBe("live");

    // A second sweep (or the real start job racing it) changes nothing and refunds nothing twice.
    const again = await sweepOverdue(deps, now);
    expect(again.filter((s) => [full.id, empty.id].includes(s.id))).toEqual([]);
    await db.delete(partyPlayers).where(inArray(partyPlayers.partyId, [withinGrace.id, future.id]));
  });
});

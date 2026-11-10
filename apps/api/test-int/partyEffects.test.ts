/**
 * What the worker's party jobs tell the outside world (apps/worker/src/partyStart.ts, partySettle.ts):
 * the room and the chat hear a cancel only once its transaction has committed. A commit that fails (a
 * deadlock injected at commit with a deferred trigger, after the point where the old code emitted) tells
 * nobody anything, and the retry announces it once. And a job that fails after its commit (the event or the
 * line couldn't be sent) finishes on its retry: the event again, the same chat line again (written once per
 * party and key), and its follow-up jobs under fixed ids. And record_progress, queued after a settle, can fail
 * without touching the settle, and catches up on its retry.
 */
import { afterAll, describe, expect, it } from "vitest";
import { and, eq, isNull, sql as sqlRaw } from "drizzle-orm";
import { adminCancelParty, chatMessages, chatThreads, cornerParties, db, ledger, parties, partyPlayers, playedWith, recordPartyProgress, sql, users, type Party, type User } from "@contestly/db";
import { kobo, type ChatMessage } from "@contestly/shared";
import { cancelFailedGeneration, refundInterrupted, startJobIds, startOrCancel, type StartDeps } from "../../worker/src/partyStart.js";
import { recordPlayJobId, recordProgressJobId, settle, type SettleDeps } from "../../worker/src/partySettle.js";
import { makeUser, tag } from "./harness.js";

const ENTRY = kobo(100);
let n = 0;

/**
 * A recorder for everything a job tells the outside world. `failOnce` makes that one call throw the first
 * time (Valkey down for a moment): a failure after the commit.
 */
function recorder(failOnce?: "emit" | "publishLine") {
  const events: { partyId: string; status: string }[] = [];
  const lines: ChatMessage[] = [];
  const jobs: string[] = [];
  let failed = false;
  const maybeFail = (what: "emit" | "publishLine") => {
    if (failOnce === what && !failed) {
      failed = true;
      throw new Error(`injected: ${what} failed after the commit`);
    }
  };
  const deps: StartDeps & SettleDeps = {
    emit: async (ev) => { maybeFail("emit"); events.push(ev); },
    publishLine: async (l) => { maybeFail("publishLine"); lines.push(l); },
    queueQuestions: async (_kind, _id, jobId) => jobs.push(jobId),
    queueWatchdog: async (_id, jobId) => jobs.push(jobId),
    inLobby: async () => new Set(),
    queueRecordPlay: async (_id, jobId) => jobs.push(jobId),
    queueRecordProgress: async (_id, jobId) => jobs.push(jobId),
  };
  return { deps, events, lines, jobs };
}
/** The party's system lines in the database. */
const systemLines = async (partyId: string) => db.select({ id: chatMessages.id, text: chatMessages.text }).from(chatMessages)
  .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.threadId)).where(and(eq(chatThreads.partyId, partyId), isNull(chatMessages.userId)));

async function party(status: "open" | "live", players: User[], extra: Partial<typeof parties.$inferInsert> = {}): Promise<Party> {
  const host = players[0] ?? (await makeUser(`fxhost${++n}`));
  const [p] = await db.insert(parties).values({
    createdByUserId: host.id, title: `effects ${++n} ${tag}`, category: "General knowledge", maxPlayers: 10,
    funding: "pooled", entryKobo: ENTRY, split: [100], status, startsAt: new Date(Date.now() - 60_000), questionsStatus: "ready",
    ...(status === "live" ? { liveAt: new Date() } : {}), ...extra,
  }).returning();
  for (const u of players) {
    await db.transaction(async (tx) => {
      await ledger.post(tx, { userId: u.id, kind: "cash", amountKobo: ENTRY, type: "topup", idempotencyKey: `t:fx:${p.id}:${u.id}` });
      await ledger.charge(tx, { userId: u.id, amountKobo: ENTRY, type: "party_entry", refType: "party", refId: p.id, idempotencyKey: `party_entry:${p.id}:${u.id}` });
      await tx.insert(partyPlayers).values({ partyId: p.id, userId: u.id });
    });
  }
  return p;
}
const statusOf = async (id: string) => (await db.select().from(parties).where(eq(parties.id, id)))[0].status;

/**
 * TEST-ONLY: every transaction that updates this party fails at its commit with a deadlock (a deferred
 * constraint trigger), i.e. after everything the transaction body did. Returns the undo.
 */
async function deadlockAtCommit(partyId: string) {
  const name = `t_fx_deadlock_${partyId.replace(/-/g, "")}`;
  await db.execute(sqlRaw.raw(`create function ${name}() returns trigger language plpgsql as $$ begin raise exception 'injected deadlock at commit' using errcode = '40P01'; end $$`));
  await db.execute(sqlRaw.raw(`create constraint trigger ${name} after update on parties deferrable initially deferred for each row when (new.id = '${partyId}') execute function ${name}()`));
  return async () => {
    await db.execute(sqlRaw.raw(`drop trigger ${name} on parties`));
    await db.execute(sqlRaw.raw(`drop function ${name}()`));
  };
}

afterAll(async () => { await sql.end(); });

describe("a cancel is announced only after it commits", () => {
  const cases: [string, (deps: StartDeps) => Promise<Party>, (deps: StartDeps, id: string) => Promise<unknown>][] = [
    ["the start job (too few players)", async () => party("open", []), (deps, id) => startOrCancel(deps, id)],
    ["cancelGenerationFailed", async () => party("live", [await makeUser(`fxgen${++n}`)], { questionsStatus: "failed" }), (deps, id) => cancelFailedGeneration(deps, id)],
    ["the watchdog", async () => party("live", [await makeUser(`fxdog${++n}`)]), (deps, id) => refundInterrupted(deps, id, false)],
  ];
  for (const [what, make, run] of cases) {
    it(`${what}: a deadlock at commit tells the room nothing; the retry tells it once`, async () => {
      const { deps, events, lines } = recorder();
      const p = await make(deps);
      const before = await statusOf(p.id);
      const undo = await deadlockAtCommit(p.id);
      try {
        await expect(run(deps, p.id)).rejects.toMatchObject({ code: "40P01" });
      } finally {
        await undo();
      }
      expect([events, lines, await statusOf(p.id)]).toEqual([[], [], before]);

      await run(deps, p.id); // BullMQ's retry
      expect(await statusOf(p.id)).toBe("cancelled");
      expect(events).toEqual([{ partyId: p.id, status: "cancelled" }]);
      expect(lines).toHaveLength(1);
    });
  }
});

describe("a job that fails after its commit finishes on its retry", () => {
  it("start (live, with a set never built): the retry emits live, republishes the same line, and queues the build and the watchdog under fixed ids", async () => {
    const players = [await makeUser(`fxlive${++n}`), await makeUser(`fxlive${++n}`)];
    const p = await party("open", players, { questionsStatus: "not_started" });
    const { deps, events, lines, jobs } = recorder("emit");
    await expect(startOrCancel(deps, p.id)).rejects.toThrow(/injected/);
    expect([await statusOf(p.id), events, jobs]).toEqual(["live", [], []]); // committed; the room heard nothing
    const firstLine = lines[0];

    expect(await startOrCancel(deps, p.id)).toBe("replayed");
    expect(events).toEqual([{ partyId: p.id, status: "live" }]);
    expect(lines.map((l) => l.id)).toEqual([firstLine.id, firstLine.id]); // the same line again; the room drops the repeat
    expect(jobs).toEqual([startJobIds.generate_set(p.id), startJobIds.watchdog(p.id)]);
    expect(await systemLines(p.id)).toHaveLength(1);
    // A third run is the same again: safe to repeat.
    await startOrCancel(deps, p.id);
    expect(jobs).toEqual([startJobIds.generate_set(p.id), startJobIds.watchdog(p.id), startJobIds.generate_set(p.id), startJobIds.watchdog(p.id)]);
    // Once the set is ready, a replay no longer asks for it.
    await db.update(parties).set({ questionsStatus: "ready" }).where(eq(parties.id, p.id));
    jobs.length = 0;
    await startOrCancel(deps, p.id);
    expect(jobs).toEqual([startJobIds.watchdog(p.id)]);
  });

  it("start (cancelled for too few players): the retry announces the cancel and its line", async () => {
    const p = await party("open", []);
    const { deps, events, lines } = recorder("publishLine");
    await expect(startOrCancel(deps, p.id)).rejects.toThrow(/injected/);
    expect([await statusOf(p.id), events, lines]).toEqual(["cancelled", [], []]);
    expect(await startOrCancel(deps, p.id)).toBe("replayed");
    expect(events).toEqual([{ partyId: p.id, status: "cancelled" }]);
    expect(lines.map((l) => l.id)).toEqual((await systemLines(p.id)).map((l) => l.id));
  });

  it("settle: the retry emits finished, republishes the wrap line and queues record_play and record_progress under their ids; no money moves twice", async () => {
    const [a, b] = [await makeUser(`fxset${++n}`), await makeUser(`fxset${++n}`)];
    const p = await party("live", [a, b]);
    await db.update(partyPlayers).set({ rank: 1 }).where(and(eq(partyPlayers.partyId, p.id), eq(partyPlayers.userId, a.id)));
    await db.update(partyPlayers).set({ rank: 2 }).where(and(eq(partyPlayers.partyId, p.id), eq(partyPlayers.userId, b.id)));
    const { deps, events, lines, jobs } = recorder("emit");
    await expect(settle(deps, p.id)).rejects.toThrow(/injected/);
    expect([await statusOf(p.id), events, jobs]).toEqual(["finished", [], []]);
    const paid = await ledger.balances(a.id);

    expect(await settle(deps, p.id)).toBe(false); // settled by the first run
    expect(events).toEqual([{ partyId: p.id, status: "finished" }]);
    expect(lines).toHaveLength(1);
    expect(jobs).toEqual([recordPlayJobId(p.id), recordProgressJobId(p.id)]);
    expect(await ledger.balances(a.id)).toEqual(paid);
    expect(await systemLines(p.id)).toHaveLength(1);
  });

  it("settle, cancelled as unplaceable: the retry announces the cancel", async () => {
    const banned = await makeUser(`fxban${++n}`);
    const p = await party("live", [banned]);
    await db.update(partyPlayers).set({ rank: 1 }).where(eq(partyPlayers.partyId, p.id));
    await db.update(users).set({ bannedAt: new Date(), banReason: "test" }).where(eq(users.id, banned.id));
    const { deps, events, lines } = recorder("emit");
    await expect(settle(deps, p.id)).rejects.toThrow(/injected/);
    expect(await statusOf(p.id)).toBe("cancelled");
    await settle(deps, p.id);
    expect(events).toEqual([{ partyId: p.id, status: "cancelled" }]);
    expect(new Set(lines.map((l) => l.id)).size).toBe(1);
  });

  for (const [what, make, run] of [
    ["cancelGenerationFailed", async () => party("live", [await makeUser(`fxgen${++n}`)], { questionsStatus: "failed" }), cancelFailedGeneration],
    ["the watchdog's refund", async () => party("live", [await makeUser(`fxdog${++n}`)]), (deps: StartDeps, id: string) => refundInterrupted(deps, id, false)],
  ] as const) {
    it(`${what}: the retry announces the cancel and its line; nothing is refunded twice`, async () => {
      const p = await make();
      const { deps, events, lines } = recorder("emit");
      await expect(run(deps, p.id)).rejects.toThrow(/injected/);
      expect([await statusOf(p.id), events]).toEqual(["cancelled", []]);
      await run(deps, p.id);
      expect(events).toEqual([{ partyId: p.id, status: "cancelled" }]);
      expect(new Set(lines.map((l) => l.id)).size).toBe(1);
      expect(await systemLines(p.id)).toHaveLength(1);
    });
  }

  it("an admin's cancel: a replay gets the same line back to announce, and refunds nothing", async () => {
    const u = await makeUser(`fxadm${++n}`);
    const p = await party("open", [u]);
    const first = await db.transaction((tx) => adminCancelParty(tx, p.id));
    const again = await db.transaction((tx) => adminCancelParty(tx, p.id));
    expect([first.cancelled, again.cancelled, again.refunded, again.line?.id]).toEqual([true, false, 0, first.line?.id]);
    expect(await ledger.balances(u.id)).toEqual({ cashKobo: ENTRY, bonusKobo: 0 });
  });
});

/** TEST-ONLY: recording this party's corner progress fails (a trigger on its corner_parties insert). Returns the undo. */
async function progressThrows(partyId: string) {
  const name = `t_fx_progress_${partyId.replace(/-/g, "")}`;
  await db.execute(sqlRaw.raw(`create function ${name}() returns trigger language plpgsql as $$ begin raise exception 'injected: corner progress failed'; end $$`));
  await db.execute(sqlRaw.raw(`create trigger ${name} before insert on corner_parties for each row when (new.party_id = '${partyId}') execute function ${name}()`));
  return async () => {
    await db.execute(sqlRaw.raw(`drop trigger ${name} on corner_parties`));
    await db.execute(sqlRaw.raw(`drop function ${name}()`));
  };
}

describe("record_progress runs after settlement, never inside it", () => {
  it("progress throws: the party still settles and pays; the job's retry catches up, once", async () => {
    const [a, b] = [await makeUser(`fxprog${++n}`), await makeUser(`fxprog${++n}`)];
    const p = await party("live", [a, b]);
    await db.update(partyPlayers).set({ rank: 1 }).where(and(eq(partyPlayers.partyId, p.id), eq(partyPlayers.userId, a.id)));
    await db.update(partyPlayers).set({ rank: 2 }).where(and(eq(partyPlayers.partyId, p.id), eq(partyPlayers.userId, b.id)));
    const [x, y] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
    const pairRow = async () => (await db.select().from(playedWith).where(and(eq(playedWith.userA, x), eq(playedWith.userB, y))))[0];
    const progressAt = async () => (await db.select({ at: parties.progressRecordedAt }).from(parties).where(eq(parties.id, p.id)))[0].at;
    const { deps, jobs } = recorder();
    const undo = await progressThrows(p.id);
    try {
      expect(await settle(deps, p.id)).toBe(true);
      expect(await statusOf(p.id)).toBe("finished");
      expect((await ledger.balances(a.id)).cashKobo).toBeGreaterThan(0); // the winner was paid
      expect(jobs).toEqual([recordPlayJobId(p.id), recordProgressJobId(p.id)]);
      await expect(recordPartyProgress(p.id)).rejects.toThrow(/injected/); // the job fails; BullMQ retries it
      expect([await progressAt(), await pairRow()]).toEqual([null, undefined]); // nothing half-written
    } finally {
      await undo();
    }
    const paid = await ledger.balances(a.id);
    expect(await recordPartyProgress(p.id)).toBe(true); // the retry
    expect(await progressAt()).not.toBeNull();
    expect((await pairRow())?.parties).toBe(1);
    expect(await db.select().from(cornerParties).where(eq(cornerParties.partyId, p.id))).toHaveLength(1);
    expect(await recordPartyProgress(p.id)).toBe(false); // a repeat records nothing twice
    expect((await pairRow())?.parties).toBe(1);
    expect(await ledger.balances(a.id)).toEqual(paid);
  });

  it("does nothing for a party that hasn't finished", async () => {
    const p = await party("live", [await makeUser(`fxprog${++n}`)]);
    expect(await recordPartyProgress(p.id)).toBe(false);
    expect(await db.select().from(cornerParties).where(eq(cornerParties.partyId, p.id))).toEqual([]);
  });
});

/**
 * What the worker's party jobs tell the outside world (apps/worker/src/partyStart.ts, partySettle.ts):
 * the room and the chat hear a cancel only once its transaction has committed. A commit that fails (a
 * deadlock injected at commit with a deferred trigger, after the point where the old code emitted) tells
 * nobody anything, and the retry announces it once.
 */
import { afterAll, describe, expect, it } from "vitest";
import { eq, sql as sqlRaw } from "drizzle-orm";
import { db, ledger, parties, partyPlayers, sql, type Party, type User } from "@contestly/db";
import { kobo, type ChatMessage } from "@contestly/shared";
import { cancelFailedGeneration, refundInterrupted, startOrCancel, type StartDeps } from "../../worker/src/partyStart.js";
import { makeUser, tag } from "./harness.js";

const ENTRY = kobo(100);
let n = 0;

/** A recorder for everything a job tells the outside world, per party. */
function recorder() {
  const events: { partyId: string; status: string }[] = [];
  const lines: ChatMessage[] = [];
  const questions: string[] = [];
  const watchdogs: string[] = [];
  const deps: StartDeps = {
    emit: async (ev) => events.push(ev),
    publishLine: async (l) => lines.push(l),
    queueQuestions: async (kind, id) => questions.push(`${kind}:${id}`),
    queueWatchdog: async (id) => watchdogs.push(id),
  };
  return { deps, events, lines, questions, watchdogs };
}

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

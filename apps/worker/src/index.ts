import { Worker } from "bullmq";
import { and, eq, count } from "drizzle-orm";
import { db, parties, partyPlayers, follows, users, chatMessages, ledger, getPartyConfig } from "@contestly/db";
import { makeRedis } from "@contestly/queue";
import { QUEUES, PARTY_EVENTS_CHANNEL, type NotifyJob, type PartyJob } from "@contestly/shared";

const connection = makeRedis();
const pub = makeRedis();
const emit = (ev: { partyId: string; status: string }) => pub.publish(PARTY_EVENTS_CHANNEL, JSON.stringify(ev));

/** Push notifications. Locally this logs; wire FCM/APNs here (device tokens table + firebase-admin messaging). */
const notifyWorker = new Worker<NotifyJob>(QUEUES.notify, async (job) => {
  const d = job.data;
  if (d.kind === "party_created") {
    const [p] = await db.select().from(parties).where(eq(parties.id, d.partyId));
    const targets = await db.select({ id: follows.followerId }).from(follows).where(and(eq(follows.followeeId, d.hostId), eq(follows.notify, true)));
    console.log(`[notify] "${p.title}" opened → ${targets.length} followers with alerts on`);
  } else if (d.kind === "party_invite") {
    console.log(`[notify] invites for party ${d.partyId} → ${d.toUserIds.length} users`);
  }
}, { connection });

/** Party lifecycle. Starts a party at startsAt, or cancels + refunds if too few people joined. */
const partyWorker = new Worker<PartyJob>(QUEUES.party, async (job) => {
  const { partyId } = job.data;
  const cfg = await getPartyConfig();
  await db.transaction(async (tx) => {
    const [p] = await tx.select().from(parties).where(eq(parties.id, partyId)).for("update");
    if (!p || p.status !== "open") return;
    const [{ n }] = await tx.select({ n: count() }).from(partyPlayers).where(eq(partyPlayers.partyId, partyId));
    if (Number(n) < cfg.minPlayers) {
      // Refund every entry and the host's pot. Idempotency keys make retries safe.
      const players = await tx.select().from(partyPlayers).where(eq(partyPlayers.partyId, partyId));
      for (const pl of players) await ledger.refund(tx, { chargeKey: `party_entry:${p.id}:${pl.userId}`, type: "party_refund", refType: "party", refId: p.id, idempotencyKey: `party_refund:${p.id}:${pl.userId}` });
      if (p.funding === "host") await ledger.post(tx, { userId: p.createdByUserId, kind: "cash", amountKobo: p.hostPoolKobo, type: "party_refund", refType: "party", refId: p.id, idempotencyKey: `party_fund_refund:${p.id}` });
      await tx.update(parties).set({ status: "cancelled" }).where(eq(parties.id, partyId));
      await tx.insert(chatMessages).values({ partyId, system: true, text: "Not enough players joined. Everyone has been refunded." });
      await emit({ partyId, status: "cancelled" });
      console.log(`[party] ${p.title} cancelled, ${players.length} refunded`);
      return;
    }
    await tx.update(parties).set({ status: "live" }).where(eq(parties.id, partyId));
    await tx.insert(chatMessages).values({ partyId, system: true, text: "The party is starting. Good luck!" });
    await emit({ partyId, status: "live" });
    console.log(`[party] ${p.title} is live with ${n} players`);
  });
}, { connection });

for (const w of [notifyWorker, partyWorker]) {
  w.on("failed", (job, err) => console.error(`[${w.name}] job ${job?.id} failed:`, err.message));
}
console.log("worker running: queues", Object.values(QUEUES).join(", "));

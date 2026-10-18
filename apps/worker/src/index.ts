import { Worker } from "bullmq";
import { and, asc, eq, count } from "drizzle-orm";
import { db, parties, partyPlayers, partyQuestions, follows, users, chatMessages, prizeFulfilments, ledger, getPartyConfig, getQuestionsConfig, seenInSet, type Party, type Tx } from "@contestly/db";
import { makeRedis, partyQueue, questionsQueue } from "@contestly/queue";
import { QUEUES, PARTY_EVENTS_CHANNEL, partyRoomKey, type NotifyJob, type PartyJob } from "@contestly/shared";
import { computeSettlement } from "@contestly/game";

const connection = makeRedis();
const pub = makeRedis();
const partyJobs = partyQueue();
const questionJobs = questionsQueue();
const emit = (ev: { partyId: string; status: string }) => pub.publish(PARTY_EVENTS_CHANNEL, JSON.stringify(ev));

const GENERATION_FAILED_MESSAGE = "We couldn't build the questions for this party. Everyone has been refunded.";

/** A curate party may start only when its whole play order exists and every question in it was approved. */
async function curateSetApproved(tx: Tx, p: Party): Promise<boolean> {
  const rows = await tx.select({ status: partyQuestions.status }).from(partyQuestions).where(and(eq(partyQuestions.partyId, p.id), eq(partyQuestions.reserve, false)));
  return rows.length === p.questionCount && rows.every((r) => r.status === "pending");
}

/** Push notifications. Locally this logs; wire FCM/APNs here (device tokens table + firebase-admin messaging). */
const notifyWorker = new Worker<NotifyJob>(QUEUES.notify, async (job) => {
  const d = job.data;
  if (d.kind === "party_created") {
    const [p] = await db.select().from(parties).where(eq(parties.id, d.partyId));
    const targets = await db.select({ id: follows.followerId }).from(follows).where(and(eq(follows.followeeId, d.hostId), eq(follows.notify, true)));
    console.log(`[notify] "${p.title}" opened → ${targets.length} followers with alerts on`);
  } else if (d.kind === "party_invite") {
    console.log(`[notify] invites for party ${d.partyId} → ${d.toUserIds.length} users`);
  } else if (d.kind === "questions_failed") {
    console.log(`[notify] host ${d.hostId}: questions for party ${d.partyId} couldn't be made — "${d.reason}" (retry or edit the brief)`);
  }
}, { connection });

/** Refund everything a party took in: every entry leg by leg, and the host's cash pot. Idempotent. */
async function refundParty(tx: Tx, p: Party, message: string) {
  const players = await tx.select().from(partyPlayers).where(eq(partyPlayers.partyId, p.id));
  for (const pl of players) await ledger.refund(tx, { chargeKey: `party_entry:${p.id}:${pl.userId}`, type: "party_refund", refType: "party", refId: p.id, idempotencyKey: `party_refund:${p.id}:${pl.userId}` });
  if (p.funding === "host" && p.prizeKind === "cash" && p.hostPoolKobo > 0) {
    await ledger.post(tx, { userId: p.createdByUserId, kind: "cash", amountKobo: p.hostPoolKobo, type: "party_refund", refType: "party", refId: p.id, idempotencyKey: `party_fund_refund:${p.id}` });
  }
  await tx.update(parties).set({ status: "cancelled", endedAt: new Date() }).where(eq(parties.id, p.id));
  await tx.insert(chatMessages).values({ partyId: p.id, system: true, text: message });
  await emit({ partyId: p.id, status: "cancelled" });
  return players.length;
}

/**
 * What a sealed set needs at start (ADR 0002). It was built at creation, so normally the only work
 * is checking the final roster: if nobody seated has seen any of its questions it starts as is,
 * instantly; otherwise just those are swapped first.
 */
type StartFollowUp = "none" | "reseal" | "generate";

/** Start a party at startsAt, or cancel + refund if too few people joined or it has nothing to play. */
async function startOrCancel(partyId: string) {
  const cfg = await getPartyConfig();
  const started = await db.transaction(async (tx): Promise<StartFollowUp | false> => {
    const [p] = await tx.select().from(parties).where(eq(parties.id, partyId)).for("update");
    if (!p || p.status !== "open") return false;
    const [{ n }] = await tx.select({ n: count() }).from(partyPlayers).where(eq(partyPlayers.partyId, partyId));
    if (Number(n) < cfg.minPlayers) {
      const refunded = await refundParty(tx, p, "Not enough players joined. Everyone has been refunded.");
      console.log(`[party] ${p.title} cancelled, ${refunded} refunded`);
      return false;
    }
    if (p.mode === "curate" && !(await curateSetApproved(tx, p))) {
      const refunded = await refundParty(tx, p, "The host didn't finish reviewing the questions. Everyone has been refunded.");
      console.log(`[party] ${p.title}: curate set not approved at start, cancelled and ${refunded} refunded`);
      return false;
    }
    if (p.mode === "sealed" && p.questionsStatus === "failed") {
      const refunded = await refundParty(tx, p, GENERATION_FAILED_MESSAGE);
      console.log(`[party] ${p.title}: question set still failed at start, cancelled and ${refunded} refunded`);
      return false;
    }
    const followUp = await sealedFollowUp(p);
    await tx.update(parties).set({
      status: "live",
      liveAt: new Date(),
      ...(followUp === "none" ? {} : { questionsStatus: "generating" as const }),
    }).where(eq(parties.id, partyId));
    await tx.insert(chatMessages).values({ partyId, system: true, text: "The party is starting. Good luck!" });
    console.log(`[party] ${p.title} is live with ${n} players${followUp === "reseal" ? "; swapping questions a player has already seen" : ""}`);
    return followUp;
  });
  if (started === false) return;
  // After commit, so the room never reads the set's state from before this transaction.
  await emit({ partyId, status: "live" });
  if (started === "reseal") await questionJobs.add("reseal_for_roster", { kind: "reseal_for_roster", partyId }, { jobId: `reseal-${partyId}` });
  if (started === "generate") await questionJobs.add("generate_set", { kind: "generate_set", partyId }, { jobId: `generate-set-${partyId}-start` });
  // Watchdog: if the realtime room's heartbeat key goes stale mid-round, cancel and refund.
  await partyJobs.add("watchdog", { kind: "watchdog", partyId }, { delay: 45_000 });
}

async function sealedFollowUp(p: Party): Promise<StartFollowUp> {
  if (p.mode !== "sealed") return "none";
  if (p.questionsStatus === "not_started") return "generate"; // a party from before sets were built at creation
  if (p.questionsStatus === "generating") return "none"; // still building: it runs the roster check itself when done
  return (await seenInSet(p.id)).length ? "reseal" : "none";
}

/**
 * Settle a finished round: rake taken once, pot split via the ledger with idempotency keys,
 * non-cash prizes become a fulfilment record, party → finished with ranks. A replayed job is a no-op.
 */
async function settle(partyId: string) {
  const cfg = await getPartyConfig();
  const settled = await db.transaction(async (tx) => {
    const [p] = await tx.select().from(parties).where(eq(parties.id, partyId)).for("update");
    if (!p || p.status !== "live") return false; // already settled or cancelled
    const players = await tx.select().from(partyPlayers).where(eq(partyPlayers.partyId, partyId)).orderBy(asc(partyPlayers.rank));
    const ranked = players.filter((x) => x.rank !== null).map((x) => x.userId);
    if (!ranked.length) throw new Error(`settle ${partyId}: no ranks persisted yet`); // BullMQ retries

    if (p.prizeKind === "noncash") {
      await tx.insert(prizeFulfilments).values({ partyId: p.id, winnerUserId: ranked[0], hostUserId: p.createdByUserId, prizeText: p.prizeText ?? "" }).onConflictDoNothing();
      console.log(`[party] ${p.title}: non-cash prize awarded to winner (fulfilment record created)`);
    } else {
      const s = computeSettlement({ funding: p.funding, entryKobo: p.entryKobo, playerCount: players.length, hostPoolKobo: p.hostPoolKobo, split: p.split, ranked }, cfg);
      if (s.rakeKobo > 0) await ledger.post(tx, { userId: await ledger.treasuryUserId(tx), kind: "cash", amountKobo: s.rakeKobo, type: "party_rake", refType: "party", refId: p.id, idempotencyKey: `party_rake:${p.id}` });
      if (s.hostCutKobo > 0) await ledger.post(tx, { userId: p.createdByUserId, kind: "cash", amountKobo: s.hostCutKobo, type: "party_host_cut", refType: "party", refId: p.id, idempotencyKey: `party_host_cut:${p.id}` });
      for (const prize of s.prizes) {
        if (prize.amountKobo <= 0) continue;
        await ledger.post(tx, { userId: prize.userId, kind: "cash", amountKobo: prize.amountKobo, type: "party_prize", refType: "party", refId: p.id, idempotencyKey: `party_prize:${p.id}:${prize.userId}` });
        await tx.update(partyPlayers).set({ prizeKobo: prize.amountKobo }).where(and(eq(partyPlayers.partyId, p.id), eq(partyPlayers.userId, prize.userId)));
      }
      console.log(`[party] ${p.title} settled: pot ${s.potKobo}, rake ${s.rakeKobo}, host cut ${s.hostCutKobo}, ${s.prizes.length} prize(s)`);
    }

    await tx.update(parties).set({ status: "finished", endedAt: new Date() }).where(eq(parties.id, partyId));
    await tx.insert(chatMessages).values({ partyId, system: true, text: "That's a wrap! Results are in." });
    await emit({ partyId, status: "finished" });
    return true;
  });
  // Fold this party's answer stats back into the question bank (idempotent via play_stats_recorded_at).
  if (settled) await questionJobs.add("record_play", { kind: "record_play", partyId }, { jobId: `record-play-${partyId}` });
}

/**
 * A live party's set couldn't be made playable (the start-time re-check, or a build that was still
 * running at start, exhausted its retries): fail closed, refund and cancel, unless the set became
 * ready in the meantime. Money only ever moves here, never in questions.
 */
async function cancelGenerationFailed(partyId: string) {
  await db.transaction(async (tx) => {
    const [p] = await tx.select().from(parties).where(eq(parties.id, partyId)).for("update");
    if (!p || p.status !== "live") return; // before start a failed set never cancels: the host retries
    if (p.questionsStatus === "ready") return; // a retry made the set playable after all; let the round run
    const refunded = await refundParty(tx, p, GENERATION_FAILED_MESSAGE);
    console.log(`[party] ${p.title}: question generation failed, cancelled and ${refunded} refunded`);
  });
}

/**
 * A live round whose room heartbeat disappeared (process crash, deploy) is cancelled and refunded.
 * Also the belt-and-braces for generation: a live party still waiting for its question set past
 * the generation timeout is cancelled the same way (a dead questions process never fails its job).
 */
async function watchdog(partyId: string) {
  const [p] = await db.select().from(parties).where(eq(parties.id, partyId));
  if (!p || p.status !== "live") return; // finished or cancelled; the watchdog retires
  const qcfg = await getQuestionsConfig();
  const generationStalled =
    p.liveAt !== null &&
    Date.now() - p.liveAt.getTime() > qcfg.generationTimeoutSeconds * 1000 &&
    p.questionsStatus !== "ready";
  if (!generationStalled) {
    const alive = await pub.get(partyRoomKey(partyId));
    if (alive) {
      await partyJobs.add("watchdog", { kind: "watchdog", partyId }, { delay: 30_000 });
      return;
    }
  }
  await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(parties).where(eq(parties.id, partyId)).for("update");
    if (!locked || locked.status !== "live") return;
    const message = generationStalled ? GENERATION_FAILED_MESSAGE : "The round was interrupted. Everyone has been refunded.";
    const refunded = await refundParty(tx, locked, message);
    console.log(`[party] ${locked.title}: ${generationStalled ? "generation stalled" : "room disappeared mid-round"}, cancelled and ${refunded} refunded`);
  });
}

const partyWorker = new Worker<PartyJob>(QUEUES.party, async (job) => {
  const { kind, partyId } = job.data;
  if (kind === "start" || kind === "cancel_if_empty") return startOrCancel(partyId);
  if (kind === "settle") return settle(partyId);
  if (kind === "watchdog") return watchdog(partyId);
  if (kind === "cancel_generation_failed") return cancelGenerationFailed(partyId);
}, { connection });

for (const w of [notifyWorker, partyWorker]) {
  w.on("failed", (job, err) => console.error(`[${w.name}] job ${job?.id} failed:`, err.message));
}
console.log("worker running: queues", Object.values(QUEUES).join(", "));

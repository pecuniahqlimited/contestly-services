import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import {
  db, parties, cornerPostReplies, recordPartyProgress, lineDeliveries, deliverDueNudges, emitCornerParty, emitCornerReply, emitFillingUp, emitHostCancelled,
  emitMentions, emitPartyLive, emitPartyStarting, emitPeopleJoined, emitRecentlyLive, emitStreakRisk, emitGuestFollowUps, emitWinBack, type DeliveryDeps, purgeEmailSends, adminCancelParty, clearExpiredArchives, cornersAfterStandingChange, liftExpiredSuspensions, getAccountsConfig, currentEmailConfig, recordDeliveryNudges } from "@contestly/db";
import { climbQueue, housekeepingQueue, makeRedis, nudgeChannel, nudgeClockQueue, notifyQueue, PARTY_EVENTS_CHANNEL, partyQueue, questionsQueue, QUEUE_PREFIX, startHeartbeat } from "@contestly/queue";
import { objectStoreFromEnv } from "@contestly/storage";
import { CLIMB_TIME_ZONE, type ChatMessage, EMAIL_SEND_RETENTION_DAYS, QUEUES, partyHereKey, partyRoomKey, type ChatJob, type ClimbJob, type HousekeepingJob, type NotifyJob, type PartyJob } from "@contestly/shared";
import { closeCrewWeeks, closeWeeks, startDay } from "./climb.js";
import { purgeVoiceNotes, transcribeVoice } from "./voice.js";
import { announceCancelled, cancelFailedGeneration, startOrCancel, sweepOverdue, sweepStalled, type StartDeps } from "./partyStart.js";
import { watchdogLink, type WatchdogDeps } from "./watchdog.js";
import { nudgeClockWorker } from "./nudgeClock.js";
import { LIVENESS_CHECK_EVERY_MS, graceMsFromEnv, lastCompletions, livenessCheck, missedIntervalsFromEnv, raiseStalled, recordCompletion, schedule, scheduledJobs, watchCompletions, type WatchedJob } from "./liveness.js";
import { settle as settleWith, type SettleDeps } from "./partySettle.js";
import { runChallengeJob } from "./challenges.js";
import { routedTranscriber } from "./transcribe/index.js";
import { sendersFromEnv } from "@contestly/email";
import { ALERT_DELIVERY_EVERY_MS, alertChannelsFromEnv, alertDeliveryConfigFromEnv, deliverAlerts } from "./alertDelivery.js";
import { selectPushSender } from "./push/index.js";
import { paymentsWorker } from "./payments.js";
import { applyBanEffects, type BanEffectDeps } from "./banEffects.js";

const connection = makeRedis();
const pub = makeRedis();
const partyJobs = partyQueue();
const questionJobs = questionsQueue();
const emit = (ev: { partyId: string; status: string }) => pub.publish(PARTY_EVENTS_CHANNEL, JSON.stringify(ev));
/** A system line the worker wrote reaches the party's room once its transaction has committed. */
async function publishLine(line: ChatMessage) {
  for (const d of await lineDeliveries(line)) await pub.publish(d.channel, JSON.stringify(d.payload));
}

/**
 * Nudges (row 9). Events become pending nudge records (packages/db/src/nudges/emitters.ts); the clock below
 * delivers what's due: a banner through the user's inbox room when it's up (its subscription to their nudge
 * channel is how we know), else a push.
 */
const push = selectPushSender();
const nudgeDeps: DeliveryDeps = {
  push,
  connected: async (userId) => {
    const [, subscribers] = (await pub.pubsub("NUMSUB", nudgeChannel(userId))) as [string, number];
    return Number(subscribers) > 0;
  },
  banner: async (userId, message) => (await pub.publish(nudgeChannel(userId), JSON.stringify(message))) > 0,
  inPartyRoom: async (partyId, userId) => Number(await pub.hget(partyHereKey(partyId), userId)) > 0,
};

const notifyWorker = new Worker<NotifyJob>(QUEUES.notify, async (job) => {
  const d = job.data;
  if (d.kind === "party_created") {
    await emitCornerParty(d.partyId, d.hostId);
  } else if (d.kind === "party_joined") {
    await emitPeopleJoined(d.partyId, d.userId);
  } else if (d.kind === "chat_mention") {
    await emitMentions(d.threadId, d.fromUserId, d.toUserIds);
  } else if (d.kind === "corner_reply") {
    const [r] = await db.select({ text: cornerPostReplies.text }).from(cornerPostReplies).where(eq(cornerPostReplies.id, d.replyId));
    if (r) await emitCornerReply(d.postId, d.fromUserId, r.text);
  } else if (d.kind === "party_cancelled") {
    await emitHostCancelled(d.partyId, d.toUserIds, d.refunded);
  } else if (d.kind === "party_invite") {
    console.log(`[notify] invites for party ${d.partyId} → ${d.toUserIds.length} users (no nudge for invites yet)`);
  } else if (d.kind === "questions_failed") {
    console.log(`[notify] host ${d.hostId}: questions for party ${d.partyId} couldn't be made — "${d.reason}" (retry or edit the brief)`);
  }
}, { connection, prefix: QUEUE_PREFIX });
const notifyJobs = notifyQueue();
// The clock moved to its own queue (nudgeClock.ts); the schedulers it had on this one go (a no-op once gone).
for (const name of ["deliver_nudges", "nudge_minute", "nudge_hourly"]) await notifyJobs.removeJobScheduler(name);

const nudgeClockWorker_ = nudgeClockWorker({
  connection, prefix: QUEUE_PREFIX,
  run: {
    deliver_nudges: async () => {
      const out = await deliverDueNudges(nudgeDeps);
      if (out.length) console.log(`[nudges] ${out.map((o) => `${o.kind}→${o.status}${o.channel ? `:${o.channel}` : ""}${o.skipReason ? `(${o.skipReason})` : ""}`).join(", ")}`);
    },
    nudge_minute: async () => {
      const [starting, live, filling] = [await emitPartyStarting(), await emitRecentlyLive(), await emitFillingUp()];
      if (starting + live + filling) console.log(`[nudges] recorded: ${starting} starting, ${live} live, ${filling} filling up`);
    },
    nudge_hourly: async () => {
      const [streaks, guests, winBacks, prizes] = [await emitStreakRisk(), await emitGuestFollowUps(), await emitWinBack(), await recordDeliveryNudges()];
      if (streaks + guests + winBacks + prizes) console.log(`[nudges] recorded: ${streaks} streak, ${guests} guest follow-up, ${winBacks} win-back, ${prizes} prize delivery`);
    },
  },
});
const nudgeClockJobs = nudgeClockQueue();
/** How often due nudges go out; batched kinds wait their own gaps on top. */
const DELIVER_NUDGES_EVERY_MS = 5_000;
const NUDGE_MINUTE_EVERY_MS = 60_000;
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
await schedule(nudgeClockJobs, "deliver_nudges", { every: DELIVER_NUDGES_EVERY_MS }, { kind: "deliver_nudges" }, DELIVER_NUDGES_EVERY_MS);
await schedule(nudgeClockJobs, "nudge_minute", { every: NUDGE_MINUTE_EVERY_MS }, { kind: "nudge_minute" }, NUDGE_MINUTE_EVERY_MS);
/** On the hour: each person's local hour is what the streak, guest and win-back nudges look at. */
await schedule(nudgeClockJobs, "nudge_hourly", { pattern: "0 * * * *", tz: "UTC" }, { kind: "nudge_hourly" }, HOUR_MS);

/** An admin cancelled a scheduled or live party. Idempotent: a party already over is left alone. */
async function adminCancel(partyId: string) {
  const out = await db.transaction((tx) => adminCancelParty(tx, partyId));
  if (!out.line) return; // over some other way
  // After the commit; a replay (already cancelled by an admin) announces it again.
  await announceCancelled(startDeps, partyId, out.line);
  if (out.cancelled) console.log(`[party] ${partyId}: cancelled by an admin, ${out.refunded} refunded`);
}


/** The watchdog's first look after a start, then every WATCHDOG_EVERY_MS; one chain per party (see watchdog()). */
const WATCHDOG_FIRST_MS = 45_000;
const WATCHDOG_EVERY_MS = 30_000;
const WATCHDOG_ONE_CHAIN_MS = 20_000;
/** A run of missed looks is forgotten after this long without a link (a lost chain restarts its count). */
const WATCHDOG_MEMORY_MS = 10 * 60_000;
const watchStateKey = (partyId: string) => `party:watchdog:state:${partyId}`;

const watchdogDeps: WatchdogDeps = {
  emit, publishLine, settle: (partyId) => settle(partyId),
  roomAlive: async (partyId) => !!(await pub.get(partyRoomKey(partyId))),
  next: (partyId) => partyJobs.add("watchdog", { kind: "watchdog", partyId }, { delay: WATCHDOG_EVERY_MS }),
  memory: {
    get: async (partyId) => { const s = await pub.get(watchStateKey(partyId)); return s ? JSON.parse(s) : null; },
    set: (partyId, state) => pub.set(watchStateKey(partyId), JSON.stringify(state), "PX", WATCHDOG_MEMORY_MS),
    clear: (partyId) => pub.del(watchStateKey(partyId)),
  },
};

/** One link of a live party's watchdog (watchdog.ts): a missed heartbeat is looked at again and re-kicked before any refund. */
async function watchdog(partyId: string, jobId: string | undefined) {
  // One chain per party: a link runs only if no other link ran in the last WATCHDOG_ONE_CHAIN_MS (its own
  // retry is let through), so a start that queued the first link twice can't leave two chains running.
  const key = `party:watchdog:${partyId}`;
  if (!(await pub.set(key, jobId ?? "", "PX", WATCHDOG_ONE_CHAIN_MS, "NX")) && (await pub.get(key)) !== jobId) return;
  const outcome = await watchdogLink(watchdogDeps, partyId, jobId ?? null);
  // The liveness check expects a link every WATCHDOG_EVERY_MS while the chain goes on.
  const chainGoesOn = outcome === "alive" || outcome === "missed" || outcome === "rekicked" || outcome === "progressing";
  await (chainGoesOn ? recordCompletion(pub, watchdogChainKey(partyId), Date.now(), WATCHDOG_LIVENESS_TTL_MS) : pub.del(`liveness:${watchdogChainKey(partyId)}`));
  return outcome;
}

const watchdogChainKey = (partyId: string) => `watchdog:${partyId}`;
const WATCHDOG_LIVENESS_TTL_MS = 3600_000;
/** Each live party's watchdog chain, from its first look on. */
async function watchdogChains(): Promise<WatchedJob[]> {
  const live = await db.select({ id: parties.id, title: parties.title, liveAt: parties.liveAt }).from(parties).where(eq(parties.status, "live"));
  return live.map((p) => ({ key: watchdogChainKey(p.id), label: `the watchdog for "${p.title}" (${p.id})`, everyMs: WATCHDOG_EVERY_MS, notBefore: (p.liveAt?.getTime() ?? Date.now()) + WATCHDOG_FIRST_MS }));
}

/** Starts, cancels and the sweep (partyStart.ts) reach the rest of the system through these. */
const startDeps: StartDeps = {
  emit, publishLine,
  queueQuestions: (kind, partyId, jobId) => questionJobs.add(kind, { kind, partyId }, { jobId }),
  queueWatchdog: (partyId, jobId) => partyJobs.add("watchdog", { kind: "watchdog", partyId }, { delay: WATCHDOG_FIRST_MS, jobId }),
  inLobby: async (partyId) => new Set(Object.entries(await pub.hgetall(partyHereKey(partyId))).filter(([, n]) => Number(n) > 0).map(([id]) => id)),
};
const settleDeps: SettleDeps = {
  emit, publishLine,
  queueRecordPlay: (partyId, jobId) => questionJobs.add("record_play", { kind: "record_play", partyId }, { jobId }),
  queueRecordProgress: (partyId, jobId) => partyJobs.add("record_progress", { kind: "record_progress", partyId }, { jobId }),
};
const settle = (partyId: string) => settleWith(settleDeps, partyId);
const banDeps: BanEffectDeps = {
  announceCancelled: (partyId, line) => announceCancelled(startDeps, partyId, line),
  publishLine,
  emitSeats: (ev) => pub.publish(PARTY_EVENTS_CHANNEL, JSON.stringify(ev)),
};

/** Every minute, the sweep for any open party whose start job never ran. */
const SWEEP_EVERY_MS = 60_000;

const partyWorker = new Worker<PartyJob>(QUEUES.party, async (job) => {
  const d = job.data;
  if (d.kind === "sweep") {
    // Both run every minute even if one fails; the job fails (and shows in BullMQ) if either did.
    const results = await Promise.allSettled([sweepOverdue(startDeps), sweepStalled({ ...startDeps, settle })]);
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason);
    if (failed.length) throw new AggregateError(failed, "party sweep failed");
    return;
  }
  if (d.kind === "start" || d.kind === "cancel_if_empty") {
    const out = await startOrCancel(startDeps, d.partyId);
    // Seated players who aren't in the room hear it's live (the minute sweep is the backstop).
    if (out === "live" || out === "replayed") await emitPartyLive(d.partyId);
    return out;
  }
  if (d.kind === "challenge_expire" || d.kind === "challenge_remind" || d.kind === "challenge_ready") {
    const out = await runChallengeJob(startDeps, d.kind, d.partyId);
    if (out === "live" || out === "replayed") await emitPartyLive(d.partyId);
    return out;
  }
  if (d.kind === "settle") return settle(d.partyId);
  if (d.kind === "record_progress") return recordPartyProgress(d.partyId);
  if (d.kind === "watchdog") return watchdog(d.partyId, job.id);
  if (d.kind === "cancel_generation_failed") return cancelFailedGeneration(startDeps, d.partyId);
  if (d.kind === "admin_cancel") return adminCancel(d.partyId);
  if (d.kind === "ban_effects") {
    const out = await applyBanEffects(banDeps, d.userId);
    console.log(`[safety] ban effects for ${d.userId}: ${out.cancelled} hosted cancelled, ${out.seatsFreed} seats refunded, ${out.withdrawalsHeld} withdrawals held`);
    return out;
  }
}, { connection, prefix: QUEUE_PREFIX });
await schedule(partyJobs, "sweep", { every: SWEEP_EVERY_MS }, { kind: "sweep" }, SWEEP_EVERY_MS);

const climbJobs = climbQueue();
const climbWorker = new Worker<ClimbJob>(QUEUES.climb, async (job) => {
  if (job.data.kind === "day_start") return startDay(pub);
  if (job.data.kind === "week_close") {
    await closeWeeks();
    return closeCrewWeeks();
  }
}, { connection, prefix: QUEUE_PREFIX });
/** Each Lagos day at 00:00, and each Monday at 00:15: a run can't outlast its ladder's clock, so by then last week is final (ADR 0005). */
const CLIMB_DAY_START = "0 0 * * *";
const CLIMB_WEEK_CLOSE = "15 0 * * 1";
await schedule(climbJobs, "day_start", { pattern: CLIMB_DAY_START, tz: CLIMB_TIME_ZONE }, { kind: "day_start" }, DAY_MS);
await schedule(climbJobs, "week_close", { pattern: CLIMB_WEEK_CLOSE, tz: CLIMB_TIME_ZONE }, { kind: "week_close" }, 7 * DAY_MS);

const store = objectStoreFromEnv();
const transcriber = routedTranscriber();
const chatWorker = new Worker<ChatJob>(QUEUES.chat, async (job) => {
  if (job.data.kind === "transcribe_voice") return transcribeVoice(store, transcriber, job.data.voiceNoteId);
}, { connection, prefix: QUEUE_PREFIX });

const alertChannels = alertChannelsFromEnv(process.env, { senders: sendersFromEnv(process.env), primary: async () => (await currentEmailConfig()).primary });
const alertConfig = alertDeliveryConfigFromEnv();
if (!alertChannels.length) console.warn("[alerts] no delivery channel configured (ADMIN_ALERT_EMAILS, ADMIN_ALERT_WEBHOOK_URL): admin alerts show only in the console");
const housekeepingJobs = housekeepingQueue();
const housekeepingWorker = new Worker<HousekeepingJob>(QUEUES.housekeeping, async (job) => {
  if (job.data.kind === "deliver_alerts") {
    const sent = await deliverAlerts(alertChannels, alertConfig);
    for (const r of sent ?? []) if (r.ok) console.log(`[alerts] ${r.channel} ${r.mode}${r.kind ? ` ${r.kind}` : ""}: ${r.alerts} alert(s), ${r.occurrences} occurrence(s)`);
  } else if (job.data.kind === "purge_email_sends") {
    const n = await purgeEmailSends(new Date(Date.now() - EMAIL_SEND_RETENTION_DAYS * DAY_MS));
    if (n) console.log(`[housekeeping] deleted ${n} email send record(s) older than ${EMAIL_SEND_RETENTION_DAYS} days`);
  } else if (job.data.kind === "purge_voice_notes") {
    const out = await purgeVoiceNotes(store);
    if (out.unsent || out.expired) console.log(`[housekeeping] voice notes: ${out.unsent} unsent upload(s) deleted, ${out.expired} expired`);
  } else if (job.data.kind === "lift_expired") {
    const lifted = await liftExpiredSuspensions();
    for (const id of lifted) await cornersAfterStandingChange(id);
    if (lifted.length) console.log(`[safety] ${lifted.length} suspension(s) ran out and were lifted`);
  } else if (job.data.kind === "purge_deleted_archives") {
    const { deletedArchiveRetentionDays: days } = await getAccountsConfig();
    if (days === null) return; // shipped off: no period until the privacy policy sets one
    const n = await clearExpiredArchives(new Date(Date.now() - days * DAY_MS));
    if (n) console.log(`[housekeeping] cleared the archive of ${n} account(s) deleted more than ${days} days ago`);
  }
}, { connection, prefix: QUEUE_PREFIX });
await schedule(housekeepingJobs, "deliver_alerts", { every: ALERT_DELIVERY_EVERY_MS }, { kind: "deliver_alerts" }, ALERT_DELIVERY_EVERY_MS);
/** Suspensions are lifted within a minute of running out (they stop counting as a ban at once; ADR 0014). */
const LIFT_EXPIRED_EVERY_MS = 60_000;
await schedule(housekeepingJobs, "lift_expired", { every: LIFT_EXPIRED_EVERY_MS }, { kind: "lift_expired" }, LIFT_EXPIRED_EVERY_MS);

/** Every day at 03:00 Lagos, when nobody's playing. */
const PURGE_EMAIL_SENDS = "0 3 * * *";
await schedule(housekeepingJobs, "purge_email_sends", { pattern: PURGE_EMAIL_SENDS, tz: CLIMB_TIME_ZONE }, { kind: "purge_email_sends" }, DAY_MS);

/** Every day at 03:30 Lagos. */
const PURGE_VOICE_NOTES = "30 3 * * *";
await schedule(housekeepingJobs, "purge_voice_notes", { pattern: PURGE_VOICE_NOTES, tz: CLIMB_TIME_ZONE }, { kind: "purge_voice_notes" }, DAY_MS);

/** Every day at 04:00 Lagos. */
const PURGE_DELETED_ARCHIVES = "0 4 * * *";
await schedule(housekeepingJobs, "purge_deleted_archives", { pattern: PURGE_DELETED_ARCHIVES, tz: CLIMB_TIME_ZONE }, { kind: "purge_deleted_archives" }, DAY_MS);

for (const w of [notifyWorker, partyWorker, climbWorker, housekeepingWorker, chatWorker, nudgeClockWorker_]) {
  w.on("failed", (job, err) => console.error(`[${w.name}] job ${job?.id} failed:`, err.message));
}
// A scheduler's run completing is what the liveness check looks for.
for (const w of [notifyWorker, partyWorker, climbWorker, housekeepingWorker, chatWorker, nudgeClockWorker_, paymentsWorker]) watchCompletions(w, pub);

/** Repeatable jobs that stop completing raise a critical alert (liveness.ts); a timer, so a stuck queue can't silence it. */
const checkLiveness = livenessCheck({
  jobs: async () => [...scheduledJobs(), ...(await watchdogChains())],
  lastCompleted: (keys) => lastCompletions(pub, keys),
  stalled: raiseStalled,
}, { missedIntervals: missedIntervalsFromEnv(), graceMs: graceMsFromEnv() });
setInterval(() => {
  checkLiveness().catch((err) => console.error("[liveness] check failed", err));
}, LIVENESS_CHECK_EVERY_MS);
// GET /health/deep: this process is up (a timer, like the liveness check; whether jobs complete is that check's job).
startHeartbeat(pub, QUEUE_PREFIX, "worker");
console.log("worker running: queues", Object.values(QUEUES).join(", "));

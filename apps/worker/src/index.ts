import { Worker } from "bullmq";
import { and, eq } from "drizzle-orm";
import { db, parties, follows, lineDeliveries, getQuestionsConfig, purgeEmailSends, adminCancelParty, clearExpiredArchives, getAccountsConfig, currentEmailConfig } from "@contestly/db";
import { climbQueue, housekeepingQueue, makeRedis, PARTY_EVENTS_CHANNEL, partyQueue, questionsQueue, QUEUE_PREFIX } from "@contestly/queue";
import { objectStoreFromEnv } from "@contestly/storage";
import { CLIMB_TIME_ZONE, type ChatMessage, EMAIL_SEND_RETENTION_DAYS, QUEUES, partyRoomKey, type ChatJob, type ClimbJob, type HousekeepingJob, type NotifyJob, type PartyJob } from "@contestly/shared";
import { closeCrewWeeks, closeWeeks, startDay } from "./climb.js";
import { purgeVoiceNotes, transcribeVoice } from "./voice.js";
import { allQuestionsPlayed, announceCancelled, cancelFailedGeneration, refundInterrupted, settleFromRecords, startOrCancel, sweepOverdue, sweepStalled, type StartDeps } from "./partyStart.js";
import { settle as settleWith, type SettleDeps } from "./partySettle.js";
import { selectTranscriber } from "./transcribe/index.js";
import { sendersFromEnv } from "@contestly/email";
import { ALERT_DELIVERY_EVERY_MS, alertChannelsFromEnv, alertDeliveryConfigFromEnv, deliverAlerts } from "./alertDelivery.js";
import "./payments.js";

const connection = makeRedis();
const pub = makeRedis();
const partyJobs = partyQueue();
const questionJobs = questionsQueue();
const emit = (ev: { partyId: string; status: string }) => pub.publish(PARTY_EVENTS_CHANNEL, JSON.stringify(ev));
/** A system line the worker wrote reaches the party's room once its transaction has committed. */
async function publishLine(line: ChatMessage) {
  for (const d of await lineDeliveries(line)) await pub.publish(d.channel, JSON.stringify(d.payload));
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
  } else if (d.kind === "party_cancelled") {
    // Row 9's nudge: "<host> cancelled <party>; your entry is back" to each seat. Logged until pushes exist.
    console.log(`[notify] party ${d.partyId} cancelled by its host → ${d.toUserIds.length} player(s)${d.refunded ? ", entries refunded" : ""}`);
  } else if (d.kind === "chat_mention") {
    console.log(`[notify] @mention in thread ${d.threadId} → ${d.toUserIds.length} user(s) (batched per thread from row 9)`);
  }
}, { connection, prefix: QUEUE_PREFIX });

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

/**
 * A live round whose room heartbeat disappeared (process crash, deploy) is cancelled and refunded.
 * Also the belt-and-braces for generation: a live party still waiting for its question set past
 * the generation timeout is cancelled the same way (a dead questions process never fails its job).
 */
async function watchdog(partyId: string, jobId: string | undefined) {
  // One chain per party: a link runs only if no other link ran in the last WATCHDOG_ONE_CHAIN_MS (its own
  // retry is let through), so a start that queued the first link twice can't leave two chains running.
  const key = `party:watchdog:${partyId}`;
  if (!(await pub.set(key, jobId ?? "", "PX", WATCHDOG_ONE_CHAIN_MS, "NX")) && (await pub.get(key)) !== jobId) return;
  const [p] = await db.select().from(parties).where(eq(parties.id, partyId));
  if (!p) return;
  if (p.status !== "live") {
    // Finished or cancelled: the watchdog retires. A refund of its own that failed after the commit is announced again.
    if (p.status === "cancelled") await refundInterrupted(startDeps, partyId, false);
    return;
  }
  const qcfg = await getQuestionsConfig();
  const generationStalled =
    p.liveAt !== null &&
    Date.now() - p.liveAt.getTime() > qcfg.generationTimeoutSeconds * 1000 &&
    p.questionsStatus !== "ready";
  if (!generationStalled) {
    const alive = await pub.get(partyRoomKey(partyId));
    if (alive) {
      await partyJobs.add("watchdog", { kind: "watchdog", partyId }, { delay: WATCHDOG_EVERY_MS });
      return;
    }
  }
  // The room is gone (or its heartbeat stopped when the match finished) after every question was played:
  // settle by the recorded scores, never refund a finished party.
  if (!generationStalled && (await allQuestionsPlayed(partyId))) {
    const out = await settleFromRecords({ emit, publishLine, settle }, partyId);
    console.log(`[party] ${p.title}: room gone after the last question → ${out ?? "already ended"} from the recorded scores`);
    return;
  }
  await refundInterrupted(startDeps, partyId, generationStalled);
}

/** Starts, cancels and the sweep (partyStart.ts) reach the rest of the system through these. */
const startDeps: StartDeps = {
  emit, publishLine,
  queueQuestions: (kind, partyId, jobId) => questionJobs.add(kind, { kind, partyId }, { jobId }),
  queueWatchdog: (partyId, jobId) => partyJobs.add("watchdog", { kind: "watchdog", partyId }, { delay: WATCHDOG_FIRST_MS, jobId }),
};
const settleDeps: SettleDeps = {
  emit, publishLine,
  queueRecordPlay: (partyId, jobId) => questionJobs.add("record_play", { kind: "record_play", partyId }, { jobId }),
};
const settle = (partyId: string) => settleWith(settleDeps, partyId);

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
  if (d.kind === "start" || d.kind === "cancel_if_empty") return startOrCancel(startDeps, d.partyId);
  if (d.kind === "settle") return settle(d.partyId);
  if (d.kind === "watchdog") return watchdog(d.partyId, job.id);
  if (d.kind === "cancel_generation_failed") return cancelFailedGeneration(startDeps, d.partyId);
  if (d.kind === "admin_cancel") return adminCancel(d.partyId);
}, { connection, prefix: QUEUE_PREFIX });
await partyJobs.upsertJobScheduler("sweep", { every: SWEEP_EVERY_MS }, { name: "sweep", data: { kind: "sweep" } });

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
await climbJobs.upsertJobScheduler("day_start", { pattern: CLIMB_DAY_START, tz: CLIMB_TIME_ZONE }, { name: "day_start", data: { kind: "day_start" } });
await climbJobs.upsertJobScheduler("week_close", { pattern: CLIMB_WEEK_CLOSE, tz: CLIMB_TIME_ZONE }, { name: "week_close", data: { kind: "week_close" } });

const store = objectStoreFromEnv();
const transcriber = selectTranscriber();
const chatWorker = new Worker<ChatJob>(QUEUES.chat, async (job) => {
  if (job.data.kind === "transcribe_voice") return transcribeVoice(store, transcriber, job.data.voiceNoteId);
}, { connection, prefix: QUEUE_PREFIX });

const DAY_MS = 24 * 60 * 60 * 1000;
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
  } else if (job.data.kind === "purge_deleted_archives") {
    const { deletedArchiveRetentionDays: days } = await getAccountsConfig();
    if (days === null) return; // shipped off: no period until the privacy policy sets one
    const n = await clearExpiredArchives(new Date(Date.now() - days * DAY_MS));
    if (n) console.log(`[housekeeping] cleared the archive of ${n} account(s) deleted more than ${days} days ago`);
  }
}, { connection, prefix: QUEUE_PREFIX });
await housekeepingJobs.upsertJobScheduler("deliver_alerts", { every: ALERT_DELIVERY_EVERY_MS }, { name: "deliver_alerts", data: { kind: "deliver_alerts" } });

/** Every day at 03:00 Lagos, when nobody's playing. */
const PURGE_EMAIL_SENDS = "0 3 * * *";
await housekeepingJobs.upsertJobScheduler("purge_email_sends", { pattern: PURGE_EMAIL_SENDS, tz: CLIMB_TIME_ZONE }, { name: "purge_email_sends", data: { kind: "purge_email_sends" } });

/** Every day at 03:30 Lagos. */
const PURGE_VOICE_NOTES = "30 3 * * *";
await housekeepingJobs.upsertJobScheduler("purge_voice_notes", { pattern: PURGE_VOICE_NOTES, tz: CLIMB_TIME_ZONE }, { name: "purge_voice_notes", data: { kind: "purge_voice_notes" } });

/** Every day at 04:00 Lagos. */
const PURGE_DELETED_ARCHIVES = "0 4 * * *";
await housekeepingJobs.upsertJobScheduler("purge_deleted_archives", { pattern: PURGE_DELETED_ARCHIVES, tz: CLIMB_TIME_ZONE }, { name: "purge_deleted_archives", data: { kind: "purge_deleted_archives" } });

for (const w of [notifyWorker, partyWorker, climbWorker, housekeepingWorker, chatWorker]) {
  w.on("failed", (job, err) => console.error(`[${w.name}] job ${job?.id} failed:`, err.message));
}
console.log("worker running: queues", Object.values(QUEUES).join(", "));

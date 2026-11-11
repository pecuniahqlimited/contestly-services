/**
 * The question engine: a BullMQ consumer, never HTTP — the API, worker and realtime reach it
 * through the questions queue, and it answers the world through Postgres rows and the
 * party:events channel. A set that can't be built before start is marked failed and the host is
 * told; only a live party with no playable set becomes a cancel_generation_failed party job (the
 * worker refunds, because money only ever moves there).
 */
import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { db, parties } from "@contestly/db";
import { makeRedis, notifyQueue, PARTY_EVENTS_CHANNEL, partyQueue, questionsQueue, QUEUE_PREFIX, startHeartbeat } from "@contestly/queue";
import { QUEUES, type QuestionsJob } from "@contestly/shared";
import { ProviderUnavailable, describeTally, tallied, withCallContext } from "@contestly/ai";
import { providerNames, selectProviders } from "./providers/index.js";
import { generateSet } from "./pipeline/generateSet.js";
import { resealForRoster } from "./pipeline/reseal.js";
import { SetUnderfilled } from "./pipeline/gate.js";
import { FilesNotReady } from "./pipeline/sources.js";
import { recordPlay } from "./pipeline/recordPlay.js";
import { regenerateOne } from "./pipeline/regenerateOne.js";
import { questionVoided, retireSweep } from "./pipeline/retire.js";
import { reviewEdit } from "./pipeline/reviewEdit.js";
import { checkHostEdit } from "./pipeline/checkHostEdit.js";
import { embedFile } from "./files/embedFile.js";
import { sourceSweep } from "./files/sourceSweep.js";
import { sealWhenFilesRead } from "./files/sealWhenFilesRead.js";
import { needsReembed, reembedBackoffMs, reembedBatch, REEMBED_MAX_WAIT_MS, staleRows } from "./pipeline/reembed.js";
import { startDistractorsWorker } from "./distractorsWorker.js";

/** Daily, at 04:00 server time: retire flagged and underperforming bank questions. */
const RETIRE_SWEEP_CRON = "0 4 * * *";
/** Daily, at 04:30: delete source chunks past their retention window. */
const SOURCE_SWEEP_CRON = "30 4 * * *";

const connection = makeRedis();
const pub = makeRedis();
const partyJobs = partyQueue();
const notifyJobs = notifyQueue();
const questionJobs = questionsQueue();
const providers = selectProviders();
const publish = (ev: { partyId: string; status: string }) => pub.publish(PARTY_EVENTS_CHANNEL, JSON.stringify(ev));

/** Re-embedding is one chain: each batch queues the next, after a backoff when the provider was rate-limited. */
const queueReembed = (waits = 0, delay = 0) => questionJobs.add("reembed", { kind: "reembed", waits }, { jobId: `reembed-${Date.now()}`, delay });

/**
 * The mock embedder never re-embeds: its vectors are throwaway, and moving real ones into it would discard
 * work a real embedder (and its free quota) did. Under the mock profile, rows of other models just sit unused.
 */
const reembedsInto = (model: string) => model !== "mock";

/** At start: a chain already waiting (from before a restart) carries on, so starting one more would double the rate. */
async function startReembed() {
  if (!reembedsInto(providers.embedder.model)) return;
  const pending = await questionJobs.getJobs(["waiting", "delayed", "prioritized", "active"]);
  if (pending.some((j) => j.data.kind === "reembed")) return;
  await startReembed();
}

async function reembed(waits: number) {
  // A chain queued under a real embedder, picked up after a switch to the mock: it stops here.
  if (!reembedsInto(providers.embedder.model)) return console.log("[reembed] the mock embedder doesn't re-embed; stopping the chain");
  const t0 = Date.now();
  let moved: number;
  try {
    moved = await reembedBatch({ embedder: providers.embedder });
  } catch (err) {
    if (!(err instanceof ProviderUnavailable)) throw err;
    // A daily quota says when it resets: wait for that rather than knocking every half hour.
    const delay = Math.max(reembedBackoffMs(waits + 1), Math.min(err.retryAfterMs ?? 0, REEMBED_MAX_WAIT_MS));
    console.warn(`[reembed] ${err.message}; next batch in ${Math.round(delay / 1000)} s`);
    await queueReembed(waits + 1, delay);
    return;
  }
  if (!moved) return console.log(`[reembed] done: every row is on ${providers.embedder.model}`);
  const left = await staleRows(providers.embedder.model);
  console.log(`[reembed] ${moved} rows in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${left} left`);
  await queueReembed();
}

const worker = new Worker<QuestionsJob>(QUEUES.questions, async (job) => {
  const d = job.data;
  // Every provider call this job makes is recorded against its party (budgets, the usage view) and its kind, and
  // counted, so each set's calls, tokens and cost are one log line.
  const partyId = "partyId" in d ? d.partyId : null;
  const { value, tally } = await withCallContext({ partyId, job: d.kind }, () => tallied(() => run(d)));
  if (tally.calls) console.log(`[questions] ${d.kind}${partyId ? ` ${partyId}` : ""}: AI ${describeTally(tally)}`);
  return value;
}, { connection, prefix: QUEUE_PREFIX });

async function run(d: QuestionsJob) {
  switch (d.kind) {
    case "generate_set": return generateSet(d.partyId, { providers, publish });
    case "reseal_for_roster": return resealForRoster(d.partyId, { providers, publish });
    case "record_play": return recordPlay(d.partyId);
    case "regenerate_one": return regenerateOne(d, { providers });
    case "file_read":
      await embedFile(d.fileId, { embedder: providers.embedder });
      // A fresh job id: an earlier build of this party that failed keeps its id in the queue's history.
      return sealWhenFilesRead(d.fileId, (partyId) => questionJobs.add("generate_set", { kind: "generate_set", partyId }, { jobId: `generate-set-${partyId}-${Date.now()}` }));
    case "question_voided": return questionVoided(d);
    case "review_edit": return reviewEdit(d, { providers });
    case "check_host_edit": return checkHostEdit(d, { providers });
    case "retire_sweep": return retireSweep();
    case "source_sweep": return sourceSweep();
    case "reembed": return reembed(d.waits ?? 0);
  }
}

worker.on("failed", async (job, err) => {
  console.error(`[questions] job ${job?.id} failed:`, err.message);
  if (!job || (job.data.kind !== "generate_set" && job.data.kind !== "reseal_for_roster")) return;
  if (job.attemptsMade < (job.opts.attempts ?? 1)) return; // BullMQ will retry
  await setFailed(job.data.partyId, err);
});

/**
 * The set couldn't be built after every retry. Before start nothing is cancelled: the set is marked
 * failed with a reason the host can act on, the host is notified, and the lobby is told. A party
 * that is already live has nothing to play, so the worker cancels and refunds it.
 */
async function setFailed(partyId: string, err: Error) {
  const [party] = await db.select().from(parties).where(eq(parties.id, partyId));
  if (!party) return;
  if (party.status === "live") {
    await partyJobs.add("cancel_generation_failed", { kind: "cancel_generation_failed", partyId }, { jobId: `cancel-gen-${partyId}` });
    return;
  }
  if (party.status !== "open") return;
  const reason = hostReason(err);
  await db.update(parties).set({ questionsStatus: "failed", questionsError: reason, forgeProgress: null }).where(eq(parties.id, partyId));
  await notifyJobs.add("questions_failed", { kind: "questions_failed", partyId, hostId: party.createdByUserId, reason }, { jobId: `questions-failed-${partyId}-${Date.now()}` });
  await publish({ partyId, status: "questions_failed" });
}

/** What the host is told, in words they can act on. Never anything from the questions themselves. */
function hostReason(err: Error): string {
  if (err instanceof SetUnderfilled && err.unavailable.length) return "We couldn't make your questions just now. Try again in a few minutes.";
  if (err instanceof SetUnderfilled) return "We couldn't make enough good questions from this brief. Try a broader brief, or allow more question types.";
  if (err instanceof FilesNotReady) return "Your source file isn't ready (it's still being read, or it couldn't be read). Check it, then try again.";
  return "Something went wrong making your questions. Try again.";
}

// Distractor suggestions on their own queue and workers: a host in the builder never waits behind a set.
const distractorsWorker = startDistractorsWorker({ providers, connection: makeRedis() });
distractorsWorker.on("failed", (job, err) => console.warn(`[questions] distractors ${job?.id}: ${err.message}`));

await questionJobs.upsertJobScheduler("retire-sweep", { pattern: RETIRE_SWEEP_CRON }, { name: "retire_sweep", data: { kind: "retire_sweep" } });
await questionJobs.upsertJobScheduler("source-sweep", { pattern: SOURCE_SWEEP_CRON }, { name: "source_sweep", data: { kind: "source_sweep" } });

// Rows embedded by another model aren't compared with this one's; move them over in the background.
await startReembed();

// GET /health/deep reads it: this process is up.
startHeartbeat(pub, QUEUE_PREFIX, "questions");

const names = providerNames();
console.log(`questions running: queues ${QUEUES.questions} and ${QUEUES.distractors}, AI profile ${names.profile}: generate=${names.generator} verify=${names.verifier} embed=${names.embedder} (${providers.embedder.model}) safety=${names.safety}`);

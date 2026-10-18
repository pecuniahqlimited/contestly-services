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
import { makeRedis, notifyQueue, partyQueue, questionsQueue } from "@contestly/queue";
import { objectStoreFromEnv } from "@contestly/storage";
import { PARTY_EVENTS_CHANNEL, QUEUES, type QuestionsJob } from "@contestly/shared";
import { selectProviders } from "./providers/index.js";
import { generateSet } from "./pipeline/generateSet.js";
import { resealForRoster } from "./pipeline/reseal.js";
import { SetUnderfilled } from "./pipeline/gate.js";
import { FilesNotReady } from "./pipeline/sources.js";
import { recordPlay } from "./pipeline/recordPlay.js";
import { regenerateOne } from "./pipeline/regenerateOne.js";
import { questionVoided, retireSweep } from "./pipeline/retire.js";
import { parseFile } from "./files/parseFile.js";
import { sealWhenFilesRead } from "./files/sealWhenFilesRead.js";

/** Daily, at 04:00 server time: retire flagged and underperforming bank questions. */
const RETIRE_SWEEP_CRON = "0 4 * * *";

const connection = makeRedis();
const pub = makeRedis();
const partyJobs = partyQueue();
const notifyJobs = notifyQueue();
const questionJobs = questionsQueue();
const providers = selectProviders();
const store = objectStoreFromEnv();
const publish = (ev: { partyId: string; status: string }) => pub.publish(PARTY_EVENTS_CHANNEL, JSON.stringify(ev));

const worker = new Worker<QuestionsJob>(QUEUES.questions, async (job) => {
  const d = job.data;
  switch (d.kind) {
    case "generate_set": return generateSet(d.partyId, { providers, publish });
    case "reseal_for_roster": return resealForRoster(d.partyId, { providers, publish });
    case "record_play": return recordPlay(d.partyId);
    case "regenerate_one": return regenerateOne(d, { providers });
    case "parse_file":
      await parseFile(d.fileId, { store, embedder: providers.embedder });
      // The same job id as an API-queued build, so two files read at once still build the set once.
      return sealWhenFilesRead(d.fileId, (partyId) => questionJobs.add("generate_set", { kind: "generate_set", partyId }, { jobId: `generate-set-${partyId}` }));
    case "question_voided": return questionVoided(d);
    case "retire_sweep": return retireSweep();
  }
}, { connection });

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
  await db.update(parties).set({ questionsStatus: "failed", questionsError: reason }).where(eq(parties.id, partyId));
  await notifyJobs.add("questions_failed", { kind: "questions_failed", partyId, hostId: party.createdByUserId, reason }, { jobId: `questions-failed-${partyId}-${Date.now()}` });
  await publish({ partyId, status: "questions_failed" });
}

/** What the host is told, in words they can act on. Never anything from the questions themselves. */
function hostReason(err: Error): string {
  if (err instanceof SetUnderfilled) return "We couldn't make enough good questions from this brief. Try a broader brief, or allow more question types.";
  if (err instanceof FilesNotReady) return "Your source file isn't ready (it's still being read, or it couldn't be read). Check it, then try again.";
  return "Something went wrong making your questions. Try again.";
}

await questionJobs.upsertJobScheduler("retire-sweep", { pattern: RETIRE_SWEEP_CRON }, { name: "retire_sweep", data: { kind: "retire_sweep" } });
if (process.env.NODE_ENV !== "production") await store.ensureBucket();

console.log(`questions running: queue ${QUEUES.questions}, providers ${process.env.QUESTIONS_GENERATOR ?? "mock"}/${process.env.QUESTIONS_VERIFIER ?? "mock"}/${process.env.QUESTIONS_EMBEDDER ?? "mock"}`);

/**
 * The question engine: a BullMQ consumer, never HTTP — the API, worker and realtime reach it
 * through the questions queue, and it answers the world through Postgres rows and the
 * party:events channel. A generate_set that fails its last retry becomes a
 * cancel_generation_failed party job: the worker refunds, because money only ever moves there.
 */
import { Worker } from "bullmq";
import { makeRedis, partyQueue, questionsQueue } from "@contestly/queue";
import { objectStoreFromEnv } from "@contestly/storage";
import { PARTY_EVENTS_CHANNEL, QUEUES, type QuestionsJob } from "@contestly/shared";
import { selectProviders } from "./providers/index.js";
import { generateSet } from "./pipeline/generateSet.js";
import { recordPlay } from "./pipeline/recordPlay.js";
import { regenerateOne } from "./pipeline/regenerateOne.js";
import { questionVoided, retireSweep } from "./pipeline/retire.js";
import { parseFile } from "./files/parseFile.js";

/** Daily, at 04:00 server time: retire flagged and underperforming bank questions. */
const RETIRE_SWEEP_CRON = "0 4 * * *";

const connection = makeRedis();
const pub = makeRedis();
const partyJobs = partyQueue();
const providers = selectProviders();
const store = objectStoreFromEnv();
const publish = (ev: { partyId: string; status: string }) => pub.publish(PARTY_EVENTS_CHANNEL, JSON.stringify(ev));

const worker = new Worker<QuestionsJob>(QUEUES.questions, async (job) => {
  const d = job.data;
  switch (d.kind) {
    case "generate_set": return generateSet(d.partyId, { providers, publish });
    case "record_play": return recordPlay(d.partyId);
    case "regenerate_one": return regenerateOne(d, { providers });
    case "parse_file": return parseFile(d.fileId, { store, embedder: providers.embedder });
    case "question_voided": return questionVoided(d);
    case "retire_sweep": return retireSweep();
  }
}, { connection });

worker.on("failed", async (job, err) => {
  console.error(`[questions] job ${job?.id} failed:`, err.message);
  if (!job || job.data.kind !== "generate_set") return;
  if (job.attemptsMade < (job.opts.attempts ?? 1)) return; // BullMQ will retry
  await partyJobs.add("cancel_generation_failed",
    { kind: "cancel_generation_failed", partyId: job.data.partyId },
    { jobId: `cancel-gen-${job.data.partyId}` });
});

await questionsQueue().upsertJobScheduler("retire-sweep", { pattern: RETIRE_SWEEP_CRON }, { name: "retire_sweep", data: { kind: "retire_sweep" } });
if (process.env.NODE_ENV !== "production") await store.ensureBucket();

console.log(`questions running: queue ${QUEUES.questions}, providers ${process.env.QUESTIONS_GENERATOR ?? "mock"}/${process.env.QUESTIONS_VERIFIER ?? "mock"}/${process.env.QUESTIONS_EMBEDDER ?? "mock"}`);

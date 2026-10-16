/**
 * The question engine: a BullMQ consumer, never HTTP — the API and worker reach it through the
 * questions queue, and it answers the world through Postgres rows and the party:events channel.
 * A generate_set that fails its last retry becomes a cancel_generation_failed party job: the
 * worker refunds, because money only ever moves in the worker.
 */
import { Worker } from "bullmq";
import { makeRedis, partyQueue } from "@contestly/queue";
import { PARTY_EVENTS_CHANNEL, QUEUES, type QuestionsJob } from "@contestly/shared";
import { selectProviders } from "./providers/index.js";
import { generateSet } from "./pipeline/generateSet.js";
import { recordPlay } from "./pipeline/recordPlay.js";

const connection = makeRedis();
const pub = makeRedis();
const partyJobs = partyQueue();
const providers = selectProviders();
const publish = (ev: { partyId: string; status: string }) => pub.publish(PARTY_EVENTS_CHANNEL, JSON.stringify(ev));

const worker = new Worker<QuestionsJob>(QUEUES.questions, async (job) => {
  if (job.data.kind === "generate_set") return generateSet(job.data.partyId, { providers, publish });
  if (job.data.kind === "record_play") return recordPlay(job.data.partyId);
}, { connection });

worker.on("failed", async (job, err) => {
  console.error(`[questions] job ${job?.id} failed:`, err.message);
  if (!job || job.data.kind !== "generate_set") return;
  if (job.attemptsMade < (job.opts.attempts ?? 1)) return; // BullMQ will retry
  await partyJobs.add("cancel_generation_failed",
    { kind: "cancel_generation_failed", partyId: job.data.partyId },
    { jobId: `cancel-gen-${job.data.partyId}` });
});

console.log(`questions running: queue ${QUEUES.questions}, providers ${process.env.QUESTIONS_GENERATOR ?? "mock"}/${process.env.QUESTIONS_VERIFIER ?? "mock"}/${process.env.QUESTIONS_EMBEDDER ?? "mock"}`);

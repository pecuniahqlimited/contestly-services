/**
 * The distractors queue's own workers (ADR 0015): suggest_distractors is answered while a host waits in the
 * builder, so it never shares the questions queue, where one set generation can run for minutes. Several at once
 * (DISTRACTORS_CONCURRENCY), each one generation call and one safety call.
 */
import { Worker } from "bullmq";
import { QUEUE_PREFIX, type makeRedis } from "@contestly/queue";
import { QUEUES, type DistractorsJob } from "@contestly/shared";
import { withCallContext } from "@contestly/ai";
import { suggestDistractors } from "./pipeline/distractors.js";
import type { Providers } from "./providers/types.js";

/** How many suggestions run at once, per questions process. */
export const DISTRACTORS_CONCURRENCY = Number(process.env.DISTRACTORS_CONCURRENCY ?? 8);

export function startDistractorsWorker(deps: { providers: Pick<Providers, "generator" | "safety">; connection: ReturnType<typeof makeRedis>; concurrency?: number }) {
  return new Worker<DistractorsJob>(QUEUES.distractors, (job) => withCallContext({ partyId: null, job: job.data.kind }, () => suggestDistractors(job.data, deps.providers)), {
    connection: deps.connection, prefix: QUEUE_PREFIX, concurrency: deps.concurrency ?? DISTRACTORS_CONCURRENCY,
  });
}

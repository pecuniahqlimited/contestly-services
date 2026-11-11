/**
 * The distractors queue's own workers (ADR 0015): suggest_distractors is answered while a host waits in the
 * builder, so it never shares the questions queue, where one set generation can run for minutes. Several at once
 * (DISTRACTORS_CONCURRENCY), each one generation call and one safety call.
 */
import { Worker } from "bullmq";
import { QUEUE_PREFIX, type makeRedis } from "@contestly/queue";
import { QUEUES, type DistractorsJob } from "@contestly/shared";
import { withCallContext } from "@contestly/ai";
import type { AiStakes } from "@contestly/shared";
import { suggestDistractors } from "./pipeline/distractors.js";
import type { Routed } from "./routing.js";

/** How many suggestions run at once, per questions process. */
export const DISTRACTORS_CONCURRENCY = Number(process.env.DISTRACTORS_CONCURRENCY ?? 8);

/** `route`: the providers for the draft's stakes (AI routing: the builder's current stakes pick the tier). */
export function startDistractorsWorker(deps: { route: (stakes: AiStakes | undefined) => Promise<Routed>; connection: ReturnType<typeof makeRedis>; concurrency?: number }) {
  return new Worker<DistractorsJob>(QUEUES.distractors, async (job) => {
    const { route, providers } = await deps.route(job.data.stakes);
    return withCallContext({ partyId: null, job: job.data.kind, route }, () => suggestDistractors(job.data, providers));
  }, {
    connection: deps.connection, prefix: QUEUE_PREFIX, concurrency: deps.concurrency ?? DISTRACTORS_CONCURRENCY,
  });
}

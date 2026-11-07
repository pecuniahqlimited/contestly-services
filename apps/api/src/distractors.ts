/**
 * Distractor suggestions (ADR 0015) through the questions service, never HTTP: the API queues a
 * suggest_distractors job and waits for its result for a few seconds. The route checks the host's own words
 * first (assertHostTextSafe, the term filter, failing closed), so an unsafe question never reaches the queue; the
 * service checks them again, with the model safety check too, and filters what it generates (a check that can't
 * run is distractors_unavailable: no suggestions). Tests pass their own suggester (AppOptions.distractors).
 */
import { QueueEvents, type Job } from "bullmq";
import { makeRedis, questionsQueue, QUEUE_PREFIX } from "@contestly/queue";
import { QUEUES, checkHostText, distractorResponseSchema, type DistractorRequest, type DistractorResponse } from "@contestly/shared";
import { httpError } from "./httpError.js";

export type DistractorSuggester = (req: DistractorRequest) => Promise<DistractorResponse>;

/** How long the builder waits for the questions service: a generation call and a model safety check. */
const WAIT_MS = 30_000;
const KEEP_RESULT_SECONDS = 60;

export const HOST_TEXT_UNSAFE = "host_text_unsafe";
export const NO_SAFE_DISTRACTORS = "no_safe_distractors";
export const DISTRACTORS_UNAVAILABLE = "distractors_unavailable";

/** The safety filter on the host's words, failing closed: refused with the reasons (no part of the text). */
export function assertHostTextSafe(text: Parameters<typeof checkHostText>[0], brief: string, details: Record<string, unknown> = {}) {
  const safety = checkHostText(text, brief);
  if (!safety.passed) throw httpError(422, HOST_TEXT_UNSAFE, { ...details, reasons: safety.reasons });
}

let events: QueueEvents | undefined;
const questionJobs = questionsQueue();

/** The questions service's failure, in words the builder can act on. */
function mapFailure(job: Job, err: unknown): never {
  const reason = job.failedReason ?? (err as Error).message ?? "";
  if (reason.startsWith("unsafe_host_text")) throw httpError(422, HOST_TEXT_UNSAFE, { reasons: reason.split(": ")[1]?.split(", ") ?? [] });
  if (reason.startsWith("no_safe_distractors")) throw httpError(422, NO_SAFE_DISTRACTORS);
  throw httpError(503, DISTRACTORS_UNAVAILABLE);
}

export const queueDistractors: DistractorSuggester = async (req) => {
  events ??= new QueueEvents(QUEUES.questions, { connection: makeRedis(), prefix: QUEUE_PREFIX });
  const job = await questionJobs.add("suggest_distractors", { kind: "suggest_distractors", ...req }, {
    attempts: 1, removeOnComplete: { age: KEEP_RESULT_SECONDS }, removeOnFail: { age: KEEP_RESULT_SECONDS },
  });
  try {
    return distractorResponseSchema.parse(await job.waitUntilFinished(events, WAIT_MS));
  } catch (err) {
    const fresh = await questionJobs.getJob(job.id!);
    if (fresh?.failedReason) mapFailure(fresh, err);
    throw httpError(503, DISTRACTORS_UNAVAILABLE);
  }
};

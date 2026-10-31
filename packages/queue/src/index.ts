import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { QUEUES, type ChatJob, type ClimbJob, type HousekeepingJob, type NotifyJob, type PartyJob, type PaymentsJob, type QuestionsJob } from "@contestly/shared";

export const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
/** BullMQ's key prefix. Every Queue and Worker passes it, so two stacks on one Valkey never share jobs. */
export const QUEUE_PREFIX = process.env.BULLMQ_PREFIX || "bull";
/** BullMQ needs maxRetriesPerRequest: null. Make one connection per purpose, not per call. */
export const makeRedis = () => new Redis(REDIS_URL, { maxRetriesPerRequest: null });

let connection: Redis | undefined;
const conn = () => (connection ??= makeRedis());

export const notifyQueue = () => new Queue<NotifyJob>(QUEUES.notify, { connection: conn(), prefix: QUEUE_PREFIX, defaultJobOptions: { attempts: 5, backoff: { type: "exponential", delay: 2000 }, removeOnComplete: 500, removeOnFail: 1000 } });
export const partyQueue = () => new Queue<PartyJob>(QUEUES.party, { connection: conn(), prefix: QUEUE_PREFIX, defaultJobOptions: { attempts: 3, removeOnComplete: 500 } });
export const questionsQueue = () => new Queue<QuestionsJob>(QUEUES.questions, { connection: conn(), prefix: QUEUE_PREFIX, defaultJobOptions: { attempts: 3, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 500, removeOnFail: 1000 } });

export const climbQueue = () => new Queue<ClimbJob>(QUEUES.climb, { connection: conn(), prefix: QUEUE_PREFIX, defaultJobOptions: { attempts: 5, backoff: { type: "exponential", delay: 10_000 }, removeOnComplete: 100, removeOnFail: 500 } });

export const housekeepingQueue = () => new Queue<HousekeepingJob>(QUEUES.housekeeping, { connection: conn(), prefix: QUEUE_PREFIX, defaultJobOptions: { attempts: 3, backoff: { type: "exponential", delay: 60_000 }, removeOnComplete: 50, removeOnFail: 200 } });

export const chatQueue = () => new Queue<ChatJob>(QUEUES.chat, { connection: conn(), prefix: QUEUE_PREFIX, defaultJobOptions: { attempts: 5, backoff: { type: "exponential", delay: 10_000 }, removeOnComplete: 500, removeOnFail: 1000 } });

/** Payments jobs retry with backoff; every one is safe to run twice (the transitions lock and check state). */
export const paymentsQueue = () => new Queue<PaymentsJob>(QUEUES.payments, { connection: conn(), prefix: QUEUE_PREFIX, defaultJobOptions: { attempts: 5, backoff: { type: "exponential", delay: 5_000 }, removeOnComplete: 1000, removeOnFail: 5000 } });

/** For one-off scripts: close these queues and the shared connection so the process can exit. */
export async function closeQueues(...queues: Queue[]) {
  await Promise.all(queues.map((q) => q.close()));
  await connection?.quit();
  connection = undefined;
}

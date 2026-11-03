import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { WindowCounter } from "@contestly/shared";
import { ADMIN_EVENTS_CHANNEL as ADMIN_EVENTS, PARTY_EVENTS_CHANNEL as PARTY_EVENTS, QUEUES, type ChatJob, type ClimbJob, type HousekeepingJob, type NotifyJob, type PartyJob, type PaymentsJob, type QuestionsJob } from "@contestly/shared";

export const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
/** BullMQ's key prefix. Every Queue and Worker passes it, so two stacks on one Valkey never share jobs. */
export const QUEUE_PREFIX = process.env.BULLMQ_PREFIX || "bull";
/** BullMQ needs maxRetriesPerRequest: null. Make one connection per purpose, not per call. */
export const makeRedis = () => new Redis(REDIS_URL, { maxRetriesPerRequest: null });

/**
 * Valkey pub/sub ignores the db index, so two stacks on one Valkey (a worktree beside main, or staging beside
 * production) hear each other's channels. PUBSUB_PREFIX (default empty: unchanged) namespaces them.
 * Every publisher and subscriber takes the channel names from here, never from @contestly/shared directly.
 */
export const PUBSUB_PREFIX = process.env.PUBSUB_PREFIX ?? "";
export const pubsubChannel = (name: string) => (PUBSUB_PREFIX ? `${PUBSUB_PREFIX}:${name}` : name);
export const PARTY_EVENTS_CHANNEL = pubsubChannel(PARTY_EVENTS);
export const ADMIN_EVENTS_CHANNEL = pubsubChannel(ADMIN_EVENTS);

let connection: Redis | undefined;
const conn = () => (connection ??= makeRedis());

export const notifyQueue = () => new Queue<NotifyJob>(QUEUES.notify, { connection: conn(), prefix: QUEUE_PREFIX, defaultJobOptions: { attempts: 5, backoff: { type: "exponential", delay: 2000 }, removeOnComplete: 500, removeOnFail: 1000 } });
/**
 * Party jobs (start, settle, cancels and their refunds, the watchdog) move money; each is idempotent (party row
 * locked, keyed ledger posts), so a failure (a deadlock Postgres broke, say) is retried with exponential backoff.
 */
export const PARTY_JOB_OPTIONS = { attempts: 5, backoff: { type: "exponential", delay: 2_000 }, removeOnComplete: 500, removeOnFail: 1000 } as const;
export const partyQueue = () => new Queue<PartyJob>(QUEUES.party, { connection: conn(), prefix: QUEUE_PREFIX, defaultJobOptions: PARTY_JOB_OPTIONS });
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

/** The Valkey counter (an ioredis connection). */
export function valkeyCounter(redis: Redis): WindowCounter {
  return {
    async hit(key, windowSeconds) {
      const m = redis.multi();
      m.incr(key);
      m.expire(key, windowSeconds, "NX");
      m.ttl(key);
      const [[, count], , [, ttl]] = (await m.exec()) as [[null, number], unknown, [null, number]];
      return { count, ttlSeconds: ttl };
    },
  };
}

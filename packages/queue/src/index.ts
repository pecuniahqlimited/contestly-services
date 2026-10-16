import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { QUEUES, type NotifyJob, type PartyJob, type QuestionsJob } from "@contestly/shared";

export const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
/** BullMQ needs maxRetriesPerRequest: null. Make one connection per purpose, not per call. */
export const makeRedis = () => new Redis(REDIS_URL, { maxRetriesPerRequest: null });

let connection: Redis | undefined;
const conn = () => (connection ??= makeRedis());

export const notifyQueue = () => new Queue<NotifyJob>(QUEUES.notify, { connection: conn(), defaultJobOptions: { attempts: 5, backoff: { type: "exponential", delay: 2000 }, removeOnComplete: 500, removeOnFail: 1000 } });
export const partyQueue = () => new Queue<PartyJob>(QUEUES.party, { connection: conn(), defaultJobOptions: { attempts: 3, removeOnComplete: 500 } });
export const questionsQueue = () => new Queue<QuestionsJob>(QUEUES.questions, { connection: conn(), defaultJobOptions: { attempts: 3, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 500, removeOnFail: 1000 } });

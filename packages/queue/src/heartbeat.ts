/**
 * Process heartbeats for GET /health/deep: each process (api, worker, realtime, questions) writes the time to Valkey
 * every HEARTBEAT_EVERY_MS on a plain timer. Any instance of a process keeps its key fresh; a process whose every
 * instance is down (or whose event loop is stuck) goes stale within HEARTBEAT_FRESH_SECONDS.
 */
import type { Redis } from "ioredis";
import { HEALTH_PROCESSES, type HealthProcess } from "@contestly/shared";

export const HEARTBEAT_EVERY_MS = 15_000;
/** Kept a while past stale, so the report can say how long ago the last one was. */
const HEARTBEAT_TTL_MS = 60 * 60_000;

/** Namespaced like the queues, so two stacks on one Valkey don't vouch for each other. */
export const heartbeatKey = (prefix: string, p: HealthProcess) => `${prefix}:health:heartbeat:${p}`;

export const writeHeartbeat = (redis: Redis, prefix: string, p: HealthProcess, now = Date.now()) =>
  redis.set(heartbeatKey(prefix, p), String(now), "PX", HEARTBEAT_TTL_MS);

/** Beat now and every HEARTBEAT_EVERY_MS; a failed write is logged and the next one tries again. Returns a stop. */
export function startHeartbeat(redis: Redis, prefix: string, p: HealthProcess): () => void {
  const beat = () => writeHeartbeat(redis, prefix, p).catch((err) => console.error(`[health] ${p} couldn't write its heartbeat`, err));
  void beat();
  const timer = setInterval(beat, HEARTBEAT_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/** Each process's last heartbeat (epoch ms), or null. */
export async function lastHeartbeats(redis: Redis, prefix: string): Promise<Record<HealthProcess, number | null>> {
  const values = await redis.mget(HEALTH_PROCESSES.map((p) => heartbeatKey(prefix, p)));
  return Object.fromEntries(HEALTH_PROCESSES.map((p, i) => [p, values[i] === null ? null : Number(values[i])])) as Record<HealthProcess, number | null>;
}

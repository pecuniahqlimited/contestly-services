/**
 * The per-user chat send limit, across every thread: a short burst window and an hourly cap, both fixed
 * windows counted in Valkey so every realtime instance shares them. Counted before the check, so a
 * client hammering a closed window keeps it closed.
 */
import type { ChatConfig } from "@contestly/shared";

/** Counts a hit on `key` in a window that starts with the first hit; returns the count and the seconds left. */
export interface WindowCounter {
  hit(key: string, windowSeconds: number): Promise<{ count: number; ttlSeconds: number }>;
}

/** Null when the send may go ahead; otherwise how long until it can. */
export async function chatRateCheck(counter: WindowCounter, userId: string, cfg: Pick<ChatConfig, "burstMax" | "burstSeconds" | "hourlyMax">): Promise<{ retryAfter: number } | null> {
  const windows = [
    { key: `chat:rate:burst:${userId}`, max: cfg.burstMax, seconds: cfg.burstSeconds },
    { key: `chat:rate:hour:${userId}`, max: cfg.hourlyMax, seconds: 3600 },
  ];
  let retryAfter = 0;
  for (const w of windows) {
    const { count, ttlSeconds } = await counter.hit(w.key, w.seconds);
    if (count > w.max) retryAfter = Math.max(retryAfter, Math.max(1, ttlSeconds));
  }
  return retryAfter ? { retryAfter } : null;
}

/** The Valkey counter (an ioredis connection). */
export function valkeyCounter(redis: { multi(): { incr(k: string): unknown; expire(k: string, s: number, mode: "NX"): unknown; ttl(k: string): unknown; exec(): Promise<unknown> } }): WindowCounter {
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

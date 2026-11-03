/**
 * The per-user chat send limit, across every thread: a short burst window and an hourly cap, both fixed
 * windows counted in Valkey (valkeyCounter in @contestly/queue) so every instance shares them. Party, DM
 * and crew lines (realtime) and corner replies (API) all count here. Counted before the check, so a
 * client hammering a closed window keeps it closed.
 */
import type { ChatConfig } from "./chat.js";

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

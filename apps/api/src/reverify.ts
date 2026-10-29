/**
 * "Recently verified": a sign-in (email code, Google or Apple) that landed on the session's own account
 * marks it for REVERIFY_WINDOW_SECONDS. Deleting the account needs the mark (ADR 0010). An account's
 * devices share one Firebase uid, so the mark is per account.
 */
import { REVERIFY_WINDOW_SECONDS } from "@contestly/shared";
import { valkey } from "./redis.js";

const key = (userId: string) => `reverified:${userId}`;

export async function markReverified(userId: string) {
  await valkey().set(key(userId), "1", "EX", REVERIFY_WINDOW_SECONDS);
}

/** When the mark runs out, or null without one. */
export async function reverifiedUntil(userId: string): Promise<Date | null> {
  const ms = await valkey().pttl(key(userId));
  return ms > 0 ? new Date(Date.now() + ms) : null;
}

export async function clearReverified(userId: string) {
  await valkey().del(key(userId));
}

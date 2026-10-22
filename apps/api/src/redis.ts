/** The API's Valkey connection (boards, sign-in codes, rate limits). One per process. */
import { makeRedis } from "@contestly/queue";

let redis: ReturnType<typeof makeRedis> | undefined;
export const valkey = () => (redis ??= makeRedis());

/**
 * A fixed-window counter: counts `by` against `key` and refuses (429 `error`) past `max` in `windowSeconds`.
 * Counted before the check, so hammering a closed window keeps it closed.
 */
export async function limit(key: string, max: number, windowSeconds: number, error = "rate_limited", by = 1): Promise<void> {
  const [[, n]] = (await valkey().multi().incrby(`limit:${key}`, by).expire(`limit:${key}`, windowSeconds, "NX").exec()) as [[null, number]];
  if (n > max) throw Object.assign(new Error(error), { statusCode: 429 });
}

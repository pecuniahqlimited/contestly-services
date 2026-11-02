/** The API's Valkey connection (boards, sign-in codes, rate limits). One per process. */
import { makeRedis } from "@contestly/queue";
import { RATE_LIMITED } from "@contestly/shared";

let redis: ReturnType<typeof makeRedis> | undefined;
export const valkey = () => (redis ??= makeRedis());

/**
 * A fixed-window counter: counts `by` against `name:subject` and refuses past `max` in `windowSeconds` with
 * 429 `error` and details.retryAfterSeconds (the error handler sends it as Retry-After too, and logs `name`).
 * Counted before the check, so hammering a closed window keeps it closed.
 */
export async function limit(name: string, subject: string, max: number, windowSeconds: number, error: string = RATE_LIMITED, by = 1): Promise<void> {
  const key = `limit:${name}:${subject}`;
  const [[, n], , [, ttl]] = (await valkey().multi().incrby(key, by).expire(key, windowSeconds, "NX").ttl(key).exec()) as [[null, number], unknown, [null, number]];
  if (n > max) throw rateLimited(error, ttl > 0 ? ttl : windowSeconds, name);
}

/**
 * A 429 the app can show plainly: the code, and when to try again (seconds; also the Retry-After header).
 * `limit` names which limit refused it, for the log only (several limits share one error code).
 */
export const rateLimited = (error: string, retryAfterSeconds: number, limit: string) =>
  Object.assign(new Error(error), { statusCode: 429, limit, details: { retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)) } });

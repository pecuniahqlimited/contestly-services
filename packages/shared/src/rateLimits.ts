/**
 * 429s, the same shape from every route: { error, details: { retryAfterSeconds } } plus a Retry-After
 * header. `error` says which limit, so the app can word it ("Too many codes. Try again in 20 minutes").
 */
import { z } from "zod";

/** The general limit: per signed-in user, or per client IP with no session. */
export const RATE_LIMITED = "rate_limited";
/** Sign-in codes: too many sent (to this email, or from this network) in the hour. */
export const TOO_MANY_CODES = "too_many_codes";
/** Sign-in codes: too many checks, or this code's tries are used up. */
export const TOO_MANY_ATTEMPTS = "too_many_attempts";
/** Too many new guests (first anonymous sessions) from this network in the hour. */
export const TOO_MANY_GUESTS = "too_many_guests";
/** Sign-in codes: a new code can't be sent this soon after the last. */
export const RESEND_COOLDOWN = "resend_cooldown";

export const rateLimitedSchema = z.object({
  error: z.string(),
  details: z.object({ retryAfterSeconds: z.number().int().positive() }),
});
export type RateLimited = z.infer<typeof rateLimitedSchema>;

/**
 * Realtime rooms: each connection may send ROOM_MESSAGES_PER_SECOND messages a second (default 20); the
 * rest are dropped. A connection that stays over for ROOM_FLOOD_DISCONNECT_SECONDS (default 5) gets
 * MSG.error { error: TOO_MANY_MESSAGES } and is closed with ROOM_FLOOD_CLOSE_CODE.
 */
export const TOO_MANY_MESSAGES = "too_many_messages";
export const ROOM_FLOOD_CLOSE_CODE = 4429;

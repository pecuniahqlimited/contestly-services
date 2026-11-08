/**
 * Sign in with a 6-digit code typed in the app (never a link). The code lives in Valkey as an HMAC for
 * 10 minutes, bound to the session that asked for it (or to having none: the app signs in by email when
 * Firebase won't give it an anonymous session, and a sessionless code is checked only without one); 5 wrong
 * tries kill it; a new one can be sent after 30 s. Sends and checks are rate-limited per email and per client IP (limits.ts).
 */
import { randomInt, timingSafeEqual } from "node:crypto";
import { adminAlert, type User } from "@contestly/db";
import { EMAIL_CODE_LENGTH, EMAIL_CODE_MAX_ATTEMPTS, EMAIL_CODE_RESEND_SECONDS, EMAIL_CODE_TTL_SECONDS, RESEND_COOLDOWN, TOO_MANY_ATTEMPTS, TOO_MANY_CODES } from "@contestly/shared";
import { limit, rateLimited, valkey } from "../redis.js";
import type { Limits } from "../limits.js";
import { sendSignInCode } from "../email.js";
import { httpError } from "../httpError.js";
import { hmac } from "./secrets.js";

const HOUR = 3600;
const TEN_MINUTES = 600;

const codeKey = (email: string) => `auth:email:${email}`;
const codeHmac = (email: string, code: string) => hmac("EMAIL_CODE_SECRET", `${email}:${code}`);
/** Who a code is bound to: the session's user, or nobody. */
const boundTo = (session: User | null) => session?.id ?? "";

/** What a code is for: signing in, or adding the email to the signed-in account (/me/email). One can't be used as the other. */
export type CodePurpose = "sign_in" | "add_email" | `brand_email:${string}`;

/** The mail a code goes out in: sign-in and adding an email say "sign in"; a brand's business email says whose it is. */
export type CodeMailer = (email: string, code: string) => ReturnType<typeof sendSignInCode>;

export async function startEmailCode(session: User | null, email: string, ip: string, limits: Limits, purpose: CodePurpose = "sign_in", mailer: CodeMailer = sendSignInCode) {
  await limit("email-start:ip", ip, limits.codeSendsPerIpPerHour, HOUR, TOO_MANY_CODES);
  const sentAt = Number(await valkey().hget(codeKey(email), "sentAt"));
  const sinceSent = Date.now() - sentAt;
  if (sentAt && sinceSent < EMAIL_CODE_RESEND_SECONDS * 1000) throw rateLimited(RESEND_COOLDOWN, (EMAIL_CODE_RESEND_SECONDS * 1000 - sinceSent) / 1000, "email-start:cooldown");
  await limit("email-start:email", email, limits.codeSendsPerEmailPerHour, HOUR, TOO_MANY_CODES);

  const code = String(randomInt(0, 10 ** EMAIL_CODE_LENGTH)).padStart(EMAIL_CODE_LENGTH, "0");
  await valkey().multi()
    .del(codeKey(email))
    .hset(codeKey(email), { hmac: codeHmac(email, code), attempts: 0, sessionUserId: boundTo(session), purpose, sentAt: Date.now() })
    .expire(codeKey(email), EMAIL_CODE_TTL_SECONDS).exec();
  const sent = await mailer(email, code);
  if (!sent.deliveredBy) {
    await valkey().del(codeKey(email));
    throw httpError(503, "email_unavailable");
  }
  return { sent: true, expiresInSeconds: EMAIL_CODE_TTL_SECONDS, resendAfterSeconds: EMAIL_CODE_RESEND_SECONDS };
}

/** The clock hour a send counts in, UTC ("2026-11-02T22"). */
const clockHour = (now = new Date()) => now.toISOString().slice(0, 13);

/**
 * Counts a code that went out against the clock hour, everyone together, and raises a warning (the admin
 * digest) the moment the hour passes `threshold`: the request that crosses it, and only that one.
 */
export async function watchCodeSends(threshold: number, hour = clockHour()): Promise<void> {
  const key = `stats:code-sends:${hour}`;
  const [[, sent]] = (await valkey().multi().incr(key).expire(key, 2 * HOUR).exec()) as [[null, number], unknown];
  if (sent !== threshold + 1) return;
  await adminAlert({
    kind: "code_sends_spike", severity: "warning", subject: `More than ${threshold} sign-in codes sent in the hour ${hour}:00 UTC`,
    details: { hour, sent, threshold }, dedupeKey: `code_sends_spike:${hour}`,
  });
}

/** Checks the code. True once, then the code is gone; throws invalid_code / too_many_attempts otherwise. */
export async function checkEmailCode(session: User | null, email: string, code: string, ip: string, limits: Limits, purpose: CodePurpose = "sign_in"): Promise<void> {
  await limit("email-check:ip", ip, limits.codeChecksPerIpPer10Min, TEN_MINUTES, TOO_MANY_ATTEMPTS);
  await limit("email-check:email", email, limits.codeChecksPerEmailPer10Min, TEN_MINUTES, TOO_MANY_ATTEMPTS);
  const key = codeKey(email);
  const entry = await valkey().hgetall(key);
  if (!entry.hmac) throw httpError(400, "invalid_code"); // expired, never sent, or already used
  const attempts = await valkey().hincrby(key, "attempts", 1);
  if (attempts > EMAIL_CODE_MAX_ATTEMPTS) {
    await valkey().del(key);
    throw rateLimited(TOO_MANY_ATTEMPTS, EMAIL_CODE_TTL_SECONDS, "email-check:code-tries");
  }
  const match = entry.sessionUserId === boundTo(session) && (entry.purpose ?? "sign_in") === purpose && timingSafeEqual(Buffer.from(entry.hmac, "hex"), Buffer.from(codeHmac(email, code), "hex"));
  if (!match) {
    if (attempts === EMAIL_CODE_MAX_ATTEMPTS) await valkey().del(key);
    throw httpError(400, "invalid_code");
  }
  // Exactly one request gets to use it.
  if ((await valkey().del(key)) !== 1) throw httpError(400, "invalid_code");
}

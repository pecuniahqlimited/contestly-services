/**
 * Sign in with a 6-digit code typed in the app (never a link). The code lives in Valkey as an HMAC for
 * 10 minutes, bound to the session that asked for it; 5 wrong tries kill it; a new one can be sent after
 * 30 s. Starts are rate-limited per email and per IP, checks per IP.
 */
import { randomInt, timingSafeEqual } from "node:crypto";
import type { User } from "@contestly/db";
import { EMAIL_CODE_LENGTH, EMAIL_CODE_MAX_ATTEMPTS, EMAIL_CODE_RESEND_SECONDS, EMAIL_CODE_TTL_SECONDS } from "@contestly/shared";
import { limit, valkey } from "../redis.js";
import { sendSignInCode } from "../email.js";
import { httpError } from "../httpError.js";
import { hmac } from "./secrets.js";

const HOUR = 3600;
const STARTS_PER_EMAIL_PER_HOUR = 5;
const STARTS_PER_IP_PER_HOUR = 20;
const CHECKS_PER_IP_PER_10_MIN = 30;

const codeKey = (email: string) => `auth:email:${email}`;
const codeHmac = (email: string, code: string) => hmac("EMAIL_CODE_SECRET", `${email}:${code}`);

export async function startEmailCode(session: User, email: string, ip: string) {
  await limit(`email-start:ip:${ip}`, STARTS_PER_IP_PER_HOUR, HOUR, "too_many_codes");
  const sentAt = Number(await valkey().hget(codeKey(email), "sentAt"));
  if (sentAt && Date.now() - sentAt < EMAIL_CODE_RESEND_SECONDS * 1000) throw httpError(429, "resend_cooldown");
  await limit(`email-start:email:${email}`, STARTS_PER_EMAIL_PER_HOUR, HOUR, "too_many_codes");

  const code = String(randomInt(0, 10 ** EMAIL_CODE_LENGTH)).padStart(EMAIL_CODE_LENGTH, "0");
  await valkey().multi()
    .del(codeKey(email))
    .hset(codeKey(email), { hmac: codeHmac(email, code), attempts: 0, sessionUserId: session.id, sentAt: Date.now() })
    .expire(codeKey(email), EMAIL_CODE_TTL_SECONDS).exec();
  const sent = await sendSignInCode(email, code);
  if (!sent.deliveredBy) {
    await valkey().del(codeKey(email));
    throw httpError(503, "email_unavailable");
  }
  return { sent: true, expiresInSeconds: EMAIL_CODE_TTL_SECONDS, resendAfterSeconds: EMAIL_CODE_RESEND_SECONDS };
}

/** Checks the code. True once, then the code is gone; throws invalid_code / too_many_attempts otherwise. */
export async function checkEmailCode(session: User, email: string, code: string, ip: string): Promise<void> {
  await limit(`email-check:ip:${ip}`, CHECKS_PER_IP_PER_10_MIN, 600, "too_many_attempts");
  const key = codeKey(email);
  const entry = await valkey().hgetall(key);
  if (!entry.hmac) throw httpError(400, "invalid_code"); // expired, never sent, or already used
  const attempts = await valkey().hincrby(key, "attempts", 1);
  if (attempts > EMAIL_CODE_MAX_ATTEMPTS) {
    await valkey().del(key);
    throw httpError(429, "too_many_attempts");
  }
  const match = entry.sessionUserId === session.id && timingSafeEqual(Buffer.from(entry.hmac, "hex"), Buffer.from(codeHmac(email, code), "hex"));
  if (!match) {
    if (attempts === EMAIL_CODE_MAX_ATTEMPTS) await valkey().del(key);
    throw httpError(400, "invalid_code");
  }
  // Exactly one request gets to use it.
  if ((await valkey().del(key)) !== 1) throw httpError(400, "invalid_code");
}

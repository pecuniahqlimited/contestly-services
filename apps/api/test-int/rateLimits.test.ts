/**
 * HTTP rate limits against the real Valkey: per user when signed in (people behind one CGNAT address don't
 * share a bucket), per real client IP when not; CF-Connecting-IP counts only through a trusted proxy;
 * the sign-in code routes have their own per-IP and per-email limits; every 429 says which limit and
 * when to retry (body and Retry-After).
 */
import { randomInt } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type User } from "@contestly/db";
import { CLOUDFLARE_RANGES } from "../src/clientIp.js";
import type { Limits } from "../src/limits.js";
import { valkey } from "../src/redis.js";
import { as, makeUser, tag, testApp } from "./harness.js";

const HIGH = 100_000;
const base: Limits = {
  userPerMinute: HIGH, ipPerMinute: HIGH, codeSendsPerIpPerHour: HIGH, codeSendsPerEmailPerHour: HIGH,
  codeChecksPerIpPer10Min: HIGH, codeChecksPerEmailPer10Min: HIGH, oauthPerIpPer10Min: HIGH,
};
const CADDY = "10.9.9.9";
let general: Awaited<ReturnType<typeof testApp>>["app"];
let codes: Awaited<ReturnType<typeof testApp>>["app"];
/** A fresh address per test, so buckets never carry over between tests. */
const ip = (prefix = "198.51.100") => `${prefix}.${randomInt(1, 255)}`;

beforeAll(async () => {
  general = (await testApp({ limits: { ...base, userPerMinute: 3, ipPerMinute: 2 }, trust: { trustedProxies: [CADDY], cloudflare: CLOUDFLARE_RANGES } })).app;
  codes = (await testApp({
    limits: { ...base, codeSendsPerIpPerHour: 2, codeSendsPerEmailPerHour: 2, codeChecksPerIpPer10Min: 3, codeChecksPerEmailPer10Min: 2 },
  })).app;
});
afterAll(async () => {
  await general.close();
  await codes.close();
  await sql.end();
});

function expect429(res: { statusCode: number; headers: Record<string, unknown>; json(): any }, error: string) {
  expect(res.statusCode).toBe(429);
  expect(res.json()).toEqual({ error, details: { retryAfterSeconds: expect.any(Number) } });
  const retry = res.json().details.retryAfterSeconds;
  expect(retry).toBeGreaterThan(0);
  expect(Number(res.headers["retry-after"])).toBe(retry);
}

describe("the general limit", () => {
  it("counts per user when signed in: two people on one IP don't share a bucket", async () => {
    const [a, b] = await Promise.all([makeUser("rlA"), makeUser("rlB")]);
    const shared = ip();
    const me = (u: User) => general.inject({ method: "GET", url: "/me", headers: as(u), remoteAddress: shared });
    for (let i = 0; i < 3; i++) expect((await me(a)).statusCode).toBe(200);
    expect429(await me(a), "rate_limited");
    expect((await me(b)).statusCode).toBe(200);
    // And from another address the same person is still the same bucket.
    expect((await general.inject({ method: "GET", url: "/me", headers: as(a), remoteAddress: ip() })).statusCode).toBe(429);
  });

  it("counts per client IP when signed out", async () => {
    const one = ip(), two = ip("192.0.2");
    const about = (from: string) => general.inject({ method: "GET", url: "/onboarding/about", remoteAddress: from });
    for (let i = 0; i < 2; i++) expect((await about(one)).statusCode).toBe(200);
    expect429(await about(one), "rate_limited");
    expect((await about(two)).statusCode).toBe(200);
  });

  it("through a trusted proxy from Cloudflare, the client is CF-Connecting-IP", async () => {
    const client = ip("41.58.1");
    const via = (edge: string, cf: string) => general.inject({ method: "GET", url: "/onboarding/about", remoteAddress: CADDY, headers: { "x-forwarded-for": edge, "cf-connecting-ip": cf } });
    expect((await via("162.158.1.1", client)).statusCode).toBe(200);
    expect((await via("172.64.9.9", client)).statusCode).toBe(200); // another Cloudflare edge, same person
    expect429(await via("162.158.1.1", client), "rate_limited");
    expect((await via("162.158.1.1", ip("41.58.2"))).statusCode).toBe(200); // someone else behind the same edge and proxy
  });

  it("from anyone else, the header is ignored: the socket address counts", async () => {
    const attacker = ip("203.0.113");
    const spoof = (cf: string) => general.inject({ method: "GET", url: "/onboarding/about", remoteAddress: attacker, headers: { "cf-connecting-ip": cf, "x-forwarded-for": "162.158.1.1" } });
    expect((await spoof(ip("41.58.3"))).statusCode).toBe(200);
    expect((await spoof(ip("41.58.4"))).statusCode).toBe(200);
    expect429(await spoof(ip("41.58.5")), "rate_limited"); // a new header each time doesn't buy a new bucket
  });
});

describe("the sign-in code routes", () => {
  const start = (u: User, email: string, from: string) => codes.inject({ method: "POST", url: "/auth/email/start", headers: as(u), remoteAddress: from, payload: { email } });
  const verify = (u: User, email: string, from: string) => codes.inject({ method: "POST", url: "/auth/email/verify", headers: as(u), remoteAddress: from, payload: { email, code: "000000" } });
  const email = (n: string) => `rl-${n}-${tag}@example.com`;
  /** TEST-ONLY: skip the 30 s resend wait, so the per-email limit itself is what's tested. */
  const skipCooldown = (e: string) => valkey().hdel(`auth:email:${e}`, "sentAt");

  it("a resend too soon: resend_cooldown, with how long to wait", async () => {
    const u = await makeUser("rlcool", { isGuest: true, email: null, emailVerifiedAt: null });
    expect((await start(u, email("cool"), ip())).statusCode).toBe(200);
    const again = await start(u, email("cool"), ip());
    expect429(again, "resend_cooldown");
    expect(again.json().details.retryAfterSeconds).toBeLessThanOrEqual(30);
  });

  it("sends per client IP: too_many_codes, whatever the addresses", async () => {
    const u = await makeUser("rlsendip", { isGuest: true, email: null, emailVerifiedAt: null });
    const from = ip();
    for (const n of ["ip1", "ip2"]) expect((await start(u, email(n), from)).statusCode).toBe(200);
    expect429(await start(u, email("ip3"), from), "too_many_codes");
    expect((await start(u, email("ip3"), ip())).statusCode).toBe(200);
  });

  it("sends per email: too_many_codes, from wherever", async () => {
    const u = await makeUser("rlsendem", { isGuest: true, email: null, emailVerifiedAt: null });
    const e = email("inbox");
    for (let i = 0; i < 2; i++) {
      expect((await start(u, e, ip())).statusCode).toBe(200);
      await skipCooldown(e);
    }
    expect429(await start(u, e, ip()), "too_many_codes");
  });

  it("checks per email and per client IP: too_many_attempts", async () => {
    const u = await makeUser("rlcheck", { isGuest: true, email: null, emailVerifiedAt: null });
    const e = email("guess");
    for (let i = 0; i < 2; i++) expect((await verify(u, e, ip())).json().error).toBe("invalid_code");
    expect429(await verify(u, e, ip()), "too_many_attempts");

    const from = ip();
    for (const n of ["c1", "c2", "c3"]) expect((await verify(u, email(n), from)).json().error).toBe("invalid_code");
    expect429(await verify(u, email("c4"), from), "too_many_attempts");
  });
});

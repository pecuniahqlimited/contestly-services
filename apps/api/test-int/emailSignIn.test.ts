/**
 * Signing in by email code with no session at all (Firebase refused the app an anonymous one), through the
 * real token path (Firebase Auth emulator): start and verify work without credentials, a correct code
 * lands on the email's account or a new one and returns a custom token for exactly that account; a guest
 * with a session still upgrades in place; a code is bound to who asked (a session, or none); a wrong code
 * never yields a token; the per-email and per-IP limits apply without a session too. Needs the emulator.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, sql, users } from "@contestly/db";
import { EMAIL_CODE_MAX_ATTEMPTS, UNAUTHORIZED } from "@contestly/shared";
import { buildApp } from "../src/app.js";
import { limitsFromEnv } from "../src/limits.js";
import { valkey } from "../src/redis.js";
import { hmac } from "../src/signin/secrets.js";
import { clientAddress as ip, makeUser, tag } from "./harness.js";

const EMULATOR = process.env.FIREBASE_AUTH_EMULATOR_HOST;
if (!EMULATOR || !process.env.FIREBASE_PROJECT_ID) throw new Error("emailSignIn.test.ts needs FIREBASE_AUTH_EMULATOR_HOST and FIREBASE_PROJECT_ID (.env) and the emulator running");
const IDT = `http://${EMULATOR}/identitytoolkit.googleapis.com/v1`;

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
let limited: App;
beforeAll(async () => {
  process.env.AUTH_MODE = "firebase"; // the real resolver
  app = await buildApp();
  limited = await buildApp({
    limits: { ...limitsFromEnv(), codeSendsPerIpPerHour: 2, codeSendsPerEmailPerHour: 2, codeChecksPerIpPer10Min: 3, codeChecksPerEmailPer10Min: 2 },
  });
  await Promise.all([app.ready(), limited.ready()]);
});
afterAll(async () => {
  await Promise.all([app.close(), limited.close()]);
  await sql.end();
});

async function idt(path: string, body: unknown) {
  const res = await fetch(`${IDT}/${path}?key=test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json() as { idToken: string; localId: string };
  if (!res.ok) throw new Error(`${path}: ${JSON.stringify(json)}`);
  return json;
}
/** What the app does with the result: sign in to Firebase with the custom token, then use the ID token. */
const signInWith = async (customToken: string) => (await idt("accounts:signInWithCustomToken", { token: customToken, returnSecureToken: true })).idToken;

const email = (n: string) => `es-${n}-${tag}@example.com`;
const bearer = (token?: string) => (token ? { authorization: `Bearer ${token}` } : {});
const start = (e: string, o: { token?: string; from?: string; on?: App } = {}) =>
  (o.on ?? app).inject({ method: "POST", url: "/auth/email/start", headers: bearer(o.token), remoteAddress: o.from ?? ip(), payload: { email: e } });
const verify = (e: string, code: string, o: { token?: string; from?: string; on?: App } = {}) =>
  (o.on ?? app).inject({ method: "POST", url: "/auth/email/verify", headers: bearer(o.token), remoteAddress: o.from ?? ip(), payload: { email: e, code } });
const me = async (idToken: string) => (await app.inject({ method: "GET", url: "/me", headers: bearer(idToken) })).json();

/**
 * TEST-ONLY: the code went out by mail; swap its HMAC for one of a code we know. Everything else the start
 * wrote (who it's bound to, attempts, expiry) is left as it was.
 */
const CODE = "424242";
const knowCode = async (e: string) => {
  expect(await valkey().hexists(`auth:email:${e}`, "hmac")).toBe(1);
  await valkey().hset(`auth:email:${e}`, "hmac", hmac("EMAIL_CODE_SECRET", `${e}:${CODE}`));
};

describe("no session", () => {
  it("a new email: a new account, and a token that signs into it", async () => {
    const e = email("new");
    expect((await start(e)).statusCode).toBe(200);
    await knowCode(e);
    const res = await verify(e, CODE);
    expect(res.statusCode).toBe(200);
    expect(res.json().account).toBe("created");

    const [row] = await db.select().from(users).where(eq(users.email, e));
    expect(row).toMatchObject({ isGuest: false, email: e });
    expect(row.emailVerifiedAt).not.toBeNull();
    const account = await me(await signInWith(res.json().customToken));
    expect(account).toMatchObject({ id: row.id, isGuest: false, email: e });
  });

  it("an existing account's email: a token for that account", async () => {
    const u = await makeUser("esold");
    expect((await start(u.email!)).statusCode).toBe(200);
    await knowCode(u.email!);
    const res = await verify(u.email!, CODE);
    expect([res.statusCode, res.json().account]).toEqual([200, "existing"]);
    expect((await me(await signInWith(res.json().customToken))).id).toBe(u.id);
  });

  it("credentials that were sent and refused are not 'no session'", async () => {
    const res = await start(email("bad"), { token: "not-a-jwt" });
    expect([res.statusCode, res.json().error]).toEqual([401, UNAUTHORIZED]);
  });
});

describe("with a session", () => {
  it("a guest still upgrades in place: same row, same uid", async () => {
    const anon = await idt("accounts:signUp", { returnSecureToken: true });
    const guest = await me(anon.idToken);
    expect(guest.isGuest).toBe(true);
    const e = email("guest");
    expect((await start(e, { token: anon.idToken })).statusCode).toBe(200);
    await knowCode(e);
    const res = await verify(e, CODE, { token: anon.idToken });
    expect([res.statusCode, res.json().account]).toEqual([200, "upgraded"]);
    const after = await me(await signInWith(res.json().customToken));
    expect(after).toMatchObject({ id: guest.id, isGuest: false, email: e });
  });

  it("a code is bound to who asked: a session's can't be used without it, and a sessionless one can't be used by a session", async () => {
    const anon = await idt("accounts:signUp", { returnSecureToken: true });
    const a = email("bound-a");
    await start(a, { token: anon.idToken });
    await knowCode(a);
    expect((await verify(a, CODE)).json().error).toBe("invalid_code");

    const b = email("bound-b");
    await start(b);
    await knowCode(b);
    expect((await verify(b, CODE, { token: anon.idToken })).json().error).toBe("invalid_code");
    expect((await me(anon.idToken)).isGuest).toBe(true); // the guest wasn't signed up by either
  });
});

describe("a wrong code never yields a token", () => {
  it("each wrong try is invalid_code with no token; after the last try the right code is dead too", async () => {
    const e = email("wrong");
    await start(e);
    await knowCode(e);
    for (let i = 0; i < EMAIL_CODE_MAX_ATTEMPTS; i++) {
      const res = await verify(e, "000000");
      expect([res.statusCode, res.json().error]).toEqual([400, "invalid_code"]);
      expect(res.json().customToken).toBeUndefined();
    }
    const late = await verify(e, CODE);
    expect([late.statusCode, late.json().customToken]).toEqual([400, undefined]);
    expect(await db.select().from(users).where(eq(users.email, e))).toEqual([]);
  });

  it("a code for one email doesn't open another", async () => {
    const [one, two] = [email("one"), email("two")];
    await start(one);
    await knowCode(one);
    await start(two);
    expect((await verify(two, CODE)).json().error).toBe("invalid_code");
    expect(await db.select().from(users).where(eq(users.email, two))).toEqual([]);
  });
});

describe("the limits apply without a session", () => {
  it("sends per client IP and per email", async () => {
    const from = ip();
    for (const n of ["l1", "l2"]) expect((await start(email(n), { from, on: limited })).statusCode).toBe(200);
    expect((await start(email("l3"), { from, on: limited })).json().error).toBe("too_many_codes");

    const e = email("inbox");
    for (let i = 0; i < 2; i++) {
      expect((await start(e, { on: limited })).statusCode).toBe(200);
      await valkey().hdel(`auth:email:${e}`, "sentAt"); // TEST-ONLY: skip the 30 s resend wait
    }
    expect((await start(e, { on: limited })).json().error).toBe("too_many_codes");
  });

  it("checks per email and per client IP", async () => {
    const e = email("guess");
    for (let i = 0; i < 2; i++) expect((await verify(e, "000000", { on: limited })).json().error).toBe("invalid_code");
    expect((await verify(e, "000000", { on: limited })).json().error).toBe("too_many_attempts");

    const from = ip();
    for (const n of ["c1", "c2", "c3"]) expect((await verify(email(n), "000000", { from, on: limited })).json().error).toBe("invalid_code");
    expect((await verify(email("c4"), "000000", { from, on: limited })).json().error).toBe("too_many_attempts");
  });
});

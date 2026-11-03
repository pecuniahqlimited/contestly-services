/**
 * Adding an email to a signed-up account with none verified (POST /me/email/start and /verify): the
 * sign-in code flow and its limits, bound to the account and to this purpose; an email another account
 * has is refused without saying whose, when asked and again when used; a verified email can't be changed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, sql, users, type User } from "@contestly/db";
import { limitsFromEnv } from "../src/limits.js";
import { valkey } from "../src/redis.js";
import { hmac } from "../src/signin/secrets.js";
import { as, clientAddress as ip, makeUser, tag, testApp } from "./harness.js";

type App = Awaited<ReturnType<typeof testApp>>["app"];
let app: App;
let limited: App;
beforeAll(async () => {
  app = (await testApp()).app;
  limited = (await testApp({ limits: { ...limitsFromEnv(), codeSendsPerEmailPerHour: 1 } })).app;
});
afterAll(async () => {
  await Promise.all([app.close(), limited.close()]);
  await sql.end();
});

let n = 0;
const email = (name: string) => `ae-${name}-${tag}@example.com`;
/** A signed-up account with no verified email (an Apple sign-in that hid it). */
const noEmail = () => makeUser(`ae${++n}`, { email: null, emailVerifiedAt: null });
const start = (u: User, e: string, on = app) => on.inject({ method: "POST", url: "/me/email/start", headers: as(u), remoteAddress: ip(), payload: { email: e } });
const verify = (u: User, e: string, code: string) => app.inject({ method: "POST", url: "/me/email/verify", headers: as(u), remoteAddress: ip(), payload: { email: e, code } });
const reload = async (u: User) => (await db.select().from(users).where(eq(users.id, u.id)))[0];

/** TEST-ONLY: the code went out by mail; swap its HMAC for one of a code we know, leaving everything else the start wrote. */
const CODE = "424242";
const knowCode = async (e: string) => {
  expect(await valkey().hexists(`auth:email:${e}`, "hmac")).toBe(1);
  await valkey().hset(`auth:email:${e}`, "hmac", hmac("EMAIL_CODE_SECRET", `${e}:${CODE}`));
};

describe("adding an email", () => {
  it("a code, then the code: the email is the account's, verified, and signs it in from then on", async () => {
    const me = await noEmail();
    const e = email("add");
    const sent = await start(me, e);
    expect([sent.statusCode, sent.json().sent]).toEqual([200, true]);
    await knowCode(e);
    const done = await verify(me, e, CODE);
    expect([done.statusCode, done.json().email]).toEqual([200, e]);
    const after = await reload(me);
    expect([after.email, after.emailVerifiedAt !== null, after.isGuest]).toEqual([e, true, false]);
    expect((await verify(me, e, CODE)).json().error).toBe("email_already_verified");
  });

  it("an email another account has: email_in_use, saying nothing about whose; also when it's taken between the code and its use", async () => {
    const other = await makeUser(`aeother${++n}`);
    const me = await noEmail();
    const refused = await start(me, other.email!);
    expect([refused.statusCode, refused.json().error]).toEqual([409, "email_in_use"]);
    expect(JSON.stringify(refused.json())).not.toMatch(new RegExp(`${other.id}|${other.handle}`));

    const e = email("race");
    await start(me, e);
    await knowCode(e);
    const quick = await noEmail();
    await db.update(users).set({ email: e, emailVerifiedAt: new Date() }).where(eq(users.id, quick.id)); // signed up with it meanwhile
    const late = await verify(me, e, CODE);
    expect([late.statusCode, late.json().error]).toEqual([409, "email_in_use"]);
    expect((await reload(me)).email).toBeNull();
  });

  it("a verified email can't be changed here; guests sign up instead", async () => {
    const verified = await makeUser(`aever${++n}`);
    expect((await start(verified, email("change"))).json().error).toBe("email_already_verified");
    const guest = await makeUser(`aeguest${++n}`, { isGuest: true, email: null, emailVerifiedAt: null });
    expect((await start(guest, email("guest"))).json().error).toBe("sign_up_required");
  });

  it("the code is bound to this account and this purpose: a sign-in code doesn't add an email, another account's code doesn't either", async () => {
    const me = await noEmail();
    const e = email("purpose");
    expect((await app.inject({ method: "POST", url: "/auth/email/start", headers: as(me), remoteAddress: ip(), payload: { email: e } })).statusCode).toBe(200);
    await knowCode(e);
    expect((await verify(me, e, CODE)).json().error).toBe("invalid_code");

    const f = email("bound");
    await start(me, f);
    await knowCode(f);
    expect((await verify(await noEmail(), f, CODE)).json().error).toBe("invalid_code");
    expect((await reload(me)).email).toBeNull();
  });

  it("the sign-in code limits apply", async () => {
    const me = await noEmail();
    const e = email("limit");
    expect((await start(me, e, limited)).statusCode).toBe(200);
    await valkey().hdel(`auth:email:${e}`, "sentAt"); // TEST-ONLY: skip the 30 s resend wait
    const again = await start(me, e, limited);
    expect([again.statusCode, again.json().error]).toEqual([429, "too_many_codes"]);
  });
});

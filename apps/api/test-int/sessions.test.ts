/**
 * Rejected sessions, through the real token path (Firebase Auth emulator, not the test header): a token
 * that doesn't verify is 401 unauthorized; a valid token whose account no longer exists is 401
 * account_gone; a banned account is 403 account_banned. Needs the emulator (npm run infra:up).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createCustomToken, deleteFirebaseUser } from "@contestly/auth";
import { db, sql, userIdentities, users } from "@contestly/db";
import { ACCOUNT_BANNED, ACCOUNT_GONE, UNAUTHORIZED } from "@contestly/shared";
import { buildApp } from "../src/app.js";
import { makeUser, tag } from "./harness.js";

const EMULATOR = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const PROJECT = process.env.FIREBASE_PROJECT_ID;
if (!EMULATOR || !PROJECT) throw new Error("sessions.test.ts needs FIREBASE_AUTH_EMULATOR_HOST and FIREBASE_PROJECT_ID (.env) and the emulator running");
const IDT = `http://${EMULATOR}/identitytoolkit.googleapis.com/v1`;

let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  process.env.AUTH_MODE = "firebase"; // the real resolver; the dev header is ignored
  app = await buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await sql.end();
});

async function idt(path: string, body: unknown) {
  const res = await fetch(`${IDT}/${path}?key=test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json() as { idToken: string; localId: string };
  if (!res.ok) throw new Error(`${path}: ${JSON.stringify(json)}`);
  return json;
}
const anonymous = () => idt("accounts:signUp", { returnSecureToken: true });
const sessionFor = async (uid: string) => (await idt("accounts:signInWithCustomToken", { token: await createCustomToken(uid), returnSecureToken: true })).idToken;
const me = (token: string) => app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${token}` } });

/** An unsigned ID token with these claims. The emulator skips the signature, so only the claims decide. */
function forged(uid: string, claims: { aud?: string; exp?: number } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const aud = claims.aud ?? PROJECT!;
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({
    aud, iss: `https://securetoken.google.com/${aud}`, sub: uid, user_id: uid, iat: now - 60, auth_time: now - 60,
    exp: claims.exp ?? now + 3600, firebase: { sign_in_provider: "anonymous", identities: {} },
  })}.`;
}

describe("401 unauthorized: the token doesn't verify", () => {
  it("no token, garbage, another project, expired", async () => {
    const { localId } = await anonymous();
    expect((await me(forged(localId))).statusCode).toBe(200); // control: these claims pass when nothing is wrong
    for (const token of ["not-a-jwt", forged(localId, { aud: "some-other-project" }), forged(localId, { exp: Math.floor(Date.now() / 1000) - 60 })]) {
      const res = await me(token);
      expect.soft(res.statusCode, token.slice(0, 20)).toBe(401);
      expect.soft(res.json().error, token.slice(0, 20)).toBe(UNAUTHORIZED);
    }
    const none = await app.inject({ method: "GET", url: "/me" });
    expect([none.statusCode, none.json().error]).toEqual([401, UNAUTHORIZED]);
  });
});

describe("401 account_gone: a valid token, no account", () => {
  it("a custom token for a uid with no user_identities row", async () => {
    const res = await me(await sessionFor(`gone-${tag}`));
    expect([res.statusCode, res.json().error]).toEqual([401, ACCOUNT_GONE]);
  });

  it("an account whose user row was deleted (its identities go with it)", async () => {
    const u = await makeUser("gone");
    const uid = `acct-${tag}`;
    await db.insert(userIdentities).values({ provider: "firebase", externalId: uid, userId: u.id });
    const token = await sessionFor(uid);
    expect((await me(token)).statusCode).toBe(200);
    await db.delete(users).where(eq(users.id, u.id));
    const res = await me(token);
    expect([res.statusCode, res.json().error]).toEqual([401, ACCOUNT_GONE]);
  });

  it("a cleaned-up guest (row and Firebase user deleted) isn't silently made a new guest", async () => {
    const { idToken, localId } = await anonymous();
    const first = await me(idToken);
    expect(first.statusCode).toBe(200);
    await db.delete(users).where(eq(users.id, first.json().id));
    await deleteFirebaseUser(localId);
    const res = await me(idToken);
    expect([res.statusCode, res.json().error]).toEqual([401, ACCOUNT_GONE]);
  });

  it("a brand-new anonymous session is still a guest", async () => {
    const res = await me((await anonymous()).idToken);
    expect(res.statusCode).toBe(200);
    expect(res.json().isGuest).toBe(true);
  });
});

describe("403 account_banned", () => {
  it("a valid token for a banned account", async () => {
    const u = await makeUser("banned", { bannedAt: new Date(), banReason: "test" });
    const uid = `banned-${tag}`;
    await db.insert(userIdentities).values({ provider: "firebase", externalId: uid, userId: u.id });
    const res = await me(await sessionFor(uid));
    expect([res.statusCode, res.json().error]).toEqual([403, ACCOUNT_BANNED]);
  });
});

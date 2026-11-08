/**
 * TEST-ONLY: the API in-process (app.inject) with sessions injected by `x-test-user: <user id>`, resolved
 * as a real token session would be, so the admin role is really checked (no dev-header pass). Users are
 * written straight to the database with a per-run tag.
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { NoCredentials, Unauthorized, type Session } from "@contestly/auth";
import { approveBrand, brands, createBrand, db, systemActorId, users, type User } from "@contestly/db";
import { ACT_AS_HEADER } from "@contestly/shared";
import { buildApp, type AppOptions } from "../src/app.js";

export const tag = randomBytes(3).toString("hex");

/** `opts`: a test's own rate limits or trusted proxies (the rest of the suite uses .env's, set high for dev). */
export async function testApp(opts: Pick<AppOptions, "limits" | "trust" | "publicConfig" | "distractors"> = {}) {
  const routes: { method: string; url: string }[] = [];
  const app = await buildApp({
    ...opts,
    resolveSession: async (req): Promise<Session> => {
      const id = req.headers["x-test-user"];
      if (typeof id !== "string") throw new NoCredentials();
      const [user] = await db.select().from(users).where(eq(users.id, id));
      if (!user) throw new Unauthorized();
      return { user, via: "token" };
    },
    onRoute: (r) => { for (const method of [r.method].flat()) routes.push({ method, url: r.url }); },
  });
  await app.ready();
  return { app, routes };
}

export async function makeUser(name: string, extra: Partial<typeof users.$inferInsert> = {}): Promise<User> {
  const handle = `t${tag}_${name}`.slice(0, 20);
  const [u] = await db.insert(users).values({ handle, displayName: name, email: `${handle}@test.contestly.invalid`, emailVerifiedAt: new Date(), ...extra }).returning();
  return u;
}

export const as = (u: { id: string }) => ({ "x-test-user": u.id });

/**
 * A client address no other test will draw: rate-limit buckets live in the shared Valkey and test files run
 * in parallel, so a small pool (254 IPv4 addresses) collides. IPv6 documentation range, 48 random bits.
 */
export const clientAddress = () => `2001:db8:${randomBytes(6).toString("hex").match(/.{4}/g)!.join(":")}::1`;

let brandsMade = 0;
/**
 * A brand owned by `owner` (ADR 0017), made through createBrand. `verified`: its checklist filled in straight in the
 * database, sent for review and approved by the system actor (approveBrand: is_verified, its corner). Returns its account.
 */
export async function makeBrand(owner: User, opts: { verified?: boolean; cashPrizes?: boolean } = {}): Promise<User> {
  const handle = `b${tag}${++brandsMade}`.slice(0, 20);
  const { account } = await createBrand(owner, { name: `Brand ${brandsMade}`, handle, logoEmoji: "🏷️", cashPrizes: opts.cashPrizes ?? false });
  if (opts.verified) {
    await db.update(brands).set({
      registrationNumber: "RC123456", logoUrl: `https://${handle}.example/logo.png`, siteUrl: `https://${handle}.example`,
      businessEmail: `${handle}@biz.example`, businessEmailVerifiedAt: new Date(), verificationStatus: "in_review", submittedAt: new Date(),
    }).where(eq(brands.id, account.id));
    await approveBrand(await systemActorId(db as never), account.id, "test brand");
  }
  return (await db.select().from(users).where(eq(users.id, account.id)))[0];
}

/** Headers for a person acting as a brand. */
export const asBrand = (person: { id: string }, brand: { id: string }) => ({ ...as(person), [ACT_AS_HEADER]: brand.id });

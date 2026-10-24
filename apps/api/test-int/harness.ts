/**
 * TEST-ONLY: the API in-process (app.inject) with sessions injected by `x-test-user: <user id>`, resolved
 * as a real token session would be, so the admin role is really checked (no dev-header pass). Users are
 * written straight to the database with a per-run tag.
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { Unauthorized, type Session } from "@contestly/auth";
import { db, users, type User } from "@contestly/db";
import { buildApp } from "../src/app.js";

export const tag = randomBytes(3).toString("hex");

export async function testApp() {
  const routes: { method: string; url: string }[] = [];
  const app = await buildApp({
    resolveSession: async (req): Promise<Session> => {
      const id = req.headers["x-test-user"];
      if (typeof id !== "string") throw new Unauthorized();
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

import { eq } from "drizzle-orm";
import { db, guestForFirebaseUid, isBanned, ledger, userByIdentity, users, type User } from "@contestly/db";
import { ACCOUNT_BANNED } from "@contestly/shared";
import { authMode } from "./mode.js";
import { isAnonymousToken, verifyIdToken } from "./firebase.js";

export * from "./mode.js";
export { createCustomToken, deleteFirebaseUser, verifyIdToken } from "./firebase.js";

export class Unauthorized extends Error { constructor(msg = "unauthorized") { super(msg); } }

/** A banned account can't sign in, join, host or play: every door calls this (API sessions, sign-in, rooms). */
export function assertNotBanned(user: Pick<User, "bannedAt">): void {
  if (isBanned(user)) throw Object.assign(new Error(ACCOUNT_BANNED), { statusCode: 403 });
}

export interface Session {
  user: User;
  /** "dev": the x-dev-user header (AUTH_MODE=dev only); "token": a verified Firebase ID token. */
  via: "dev" | "token";
}

/** Dev-header users are signed up, with a verified dev email, so payouts and admin work in the sims. */
const DEV_EMAIL_DOMAIN = "dev.contestly.invalid";

async function devUser(raw: string): Promise<User> {
  const handle = raw.trim().toLowerCase();
  const [u] = await db.select().from(users).where(eq(users.handle, handle));
  if (u) return u;
  const created = await db.transaction(async (tx) => {
    const [u] = await tx.insert(users).values({ handle, displayName: handle, email: `${handle}@${DEV_EMAIL_DOMAIN}`, emailVerifiedAt: new Date() }).onConflictDoNothing().returning();
    if (u) await ledger.grantWelcome(tx, u.id);
    return u;
  });
  // Two first requests at once: the other one created it.
  return created ?? (await db.select().from(users).where(eq(users.handle, handle)))[0];
}

/**
 * Turns request credentials into the session's users row.
 * - `Authorization: Bearer <Firebase ID token>`: the uid's account; a first anonymous session gets a
 *   guest row. A custom-token uid we don't know is refused (we only mint tokens for accounts).
 * - `x-dev-user: <handle>`: only with AUTH_MODE=dev, ignored entirely otherwise. Creates the user on
 *   first sight with the dev welcome coins.
 */
export async function resolveUser(h: { authorization?: string; devUser?: string }): Promise<Session> {
  const token = h.authorization?.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    if (authMode() === "dev" && h.devUser?.trim()) return { user: await devUser(h.devUser), via: "dev" };
    throw new Unauthorized();
  }
  const decoded = await verifyIdToken(token);
  if (!decoded) throw new Unauthorized("invalid_token");
  const known = await userByIdentity("firebase", decoded.uid);
  if (known) return { user: known, via: "token" };
  if (!isAnonymousToken(decoded)) throw new Unauthorized("unknown_account");
  return { user: await guestForFirebaseUid(decoded.uid), via: "token" };
}

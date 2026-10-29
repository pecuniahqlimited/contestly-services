import { eq } from "drizzle-orm";
import { db, guestForFirebaseUid, identityWasDisabled, isBanned, ledger, userByIdentity, users, type User } from "@contestly/db";
import { ACCOUNT_BANNED, ACCOUNT_GONE, UNAUTHORIZED } from "@contestly/shared";
import { authMode } from "./mode.js";
import { checkIdToken, firebaseUserActive, isAnonymousToken } from "./firebase.js";

export * from "./mode.js";
export { createCustomToken, deleteFirebaseUser, disableFirebaseUser, verifyIdToken } from "./firebase.js";

/** 401. The message is the error code the API replies with. */
export class Unauthorized extends Error { constructor(msg: string = UNAUTHORIZED) { super(msg); } }
/** 401 account_gone: a valid token for an account that no longer exists. */
export class AccountGone extends Unauthorized { constructor() { super(ACCOUNT_GONE); } }

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
 * - `Authorization: Bearer <Firebase ID token>`: the uid's account. A token that doesn't verify (bad,
 *   expired, another project) is Unauthorized. A valid token with no account behind it is AccountGone:
 *   a custom token (we only mint those for accounts, so its account was deleted), or an anonymous one
 *   whose uid was a deleted account's or whose Firebase user is gone (a cleaned-up guest) or disabled
 *   (a deleted account). Any other anonymous session is a first
 *   sight and gets a guest row.
 * - `x-dev-user: <handle>`: only with AUTH_MODE=dev, ignored entirely otherwise. Creates the user on
 *   first sight with the dev welcome coins.
 */
export async function resolveUser(h: { authorization?: string; devUser?: string }): Promise<Session> {
  const token = h.authorization?.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    if (authMode() === "dev" && h.devUser?.trim()) return { user: await devUser(h.devUser), via: "dev" };
    throw new Unauthorized();
  }
  const checked = await checkIdToken(token);
  if (checked.kind === "invalid") throw new Unauthorized();
  if (checked.kind === "user_gone") throw new AccountGone();
  const decoded = checked.token;
  const known = await userByIdentity("firebase", decoded.uid); // a deleted user row takes its identities with it
  if (known) return { user: known, via: "token" };
  if (!isAnonymousToken(decoded)) throw new AccountGone();
  // Only on first sight (one lookup per new guest): a deleted account's uid, or a cleaned-up guest's, is gone.
  if ((await identityWasDisabled("firebase", decoded.uid)) || !(await firebaseUserActive(decoded.uid))) throw new AccountGone();
  return { user: await guestForFirebaseUid(decoded.uid), via: "token" };
}

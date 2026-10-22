/**
 * Accounts (ADR 0006): how a session or sign-in reaches a users row, guests, and signing up.
 * Signing up turns the guest's own row into an account: nothing is copied or merged. It's the one
 * place the onboarding coins are claimed and held Climb awards are paid.
 */
import { randomBytes } from "node:crypto";
import { TransactionRollbackError, and, asc, eq, inArray } from "drizzle-orm";
import { GUEST_HANDLE_PREFIX, normaliseEmail, type IdentityProvider, type OnboardingBonusOutcome } from "@contestly/shared";
import { db, type Tx } from "./client.js";
import { ledgerEntries, onboardingDevices, onboardingRounds, userIdentities, users, type User } from "./schema.js";
import * as ledger from "./ledger.js";
import { payHeldAwards } from "./climb.js";

type Conn = Tx | typeof db;

/** The account behind (provider, external id), if any. */
export async function userByIdentity(provider: IdentityProvider, externalId: string, conn: Conn = db): Promise<User | null> {
  const [row] = await conn.select({ u: users }).from(userIdentities).innerJoin(users, eq(users.id, userIdentities.userId))
    .where(and(eq(userIdentities.provider, provider), eq(userIdentities.externalId, externalId)));
  return row?.u ?? null;
}

/** A signed-up account by its (lowercased) email. Guests never own an email. */
export async function memberByEmail(email: string, conn: Conn = db): Promise<User | null> {
  const [u] = await conn.select().from(users).where(and(eq(users.email, email), eq(users.isGuest, false)));
  return u ?? null;
}

/** Reach `userId` by (provider, external id) from now on. Idempotent; never moves an identity to another account. */
export async function attachIdentity(tx: Tx, userId: string, provider: IdentityProvider, externalId: string) {
  await tx.insert(userIdentities).values({ provider, externalId, userId }).onConflictDoNothing();
  const [row] = await tx.select().from(userIdentities).where(and(eq(userIdentities.provider, provider), eq(userIdentities.externalId, externalId)));
  if (row.userId !== userId) throw Object.assign(new Error("identity_in_use"), { statusCode: 409 });
}

/** A first sight of an anonymous Firebase session: a guest row for it. Two first requests at once share one row. */
export async function guestForFirebaseUid(uid: string): Promise<User> {
  const existing = await userByIdentity("firebase", uid);
  if (existing) return existing;
  await db.transaction(async (tx) => {
    const handle = GUEST_HANDLE_PREFIX + randomBytes(6).toString("hex");
    const [u] = await tx.insert(users).values({ handle, displayName: "Guest", isGuest: true }).returning();
    const [linked] = await tx.insert(userIdentities).values({ provider: "firebase", externalId: uid, userId: u.id }).onConflictDoNothing().returning();
    if (!linked) tx.rollback(); // the other request won; its row is the one
  }).catch((e) => { if (!(e instanceof TransactionRollbackError)) throw e; });
  return (await userByIdentity("firebase", uid))!;
}

/**
 * The Firebase uid to mint a session token for. A guest who signed up keeps their anonymous uid; an
 * account with none yet (one made by the migration, row 11b) gets its own id as its uid.
 */
export async function firebaseUidFor(userId: string, conn: Tx): Promise<string> {
  const [row] = await conn.select({ uid: userIdentities.externalId }).from(userIdentities)
    .where(and(eq(userIdentities.userId, userId), eq(userIdentities.provider, "firebase"))).orderBy(asc(userIdentities.createdAt)).limit(1);
  if (row) return row.uid;
  await attachIdentity(conn, userId, "firebase", userId);
  return userId;
}

/** Comma-separated in ADMIN_EMAILS; an account with one of these verified emails is an admin. */
const adminEmails = () => new Set((process.env.ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean));

/** At start-up: accounts whose verified email is in ADMIN_EMAILS become admins (grant only; revoking is a database change). */
export async function grantConfiguredAdmins(): Promise<number> {
  const emails = [...adminEmails()];
  if (!emails.length) return 0;
  const rows = await db.update(users).set({ isAdmin: true }).where(and(inArray(users.email, emails), eq(users.isGuest, false), eq(users.isAdmin, false))).returning({ id: users.id });
  return rows.length;
}

export interface SignUpResult {
  user: User;
  onboardingBonus: OnboardingBonusOutcome;
  bonusKobo: number;
  awardsPaid: number;
}

/**
 * A guest signs up with a verified email (already lowercased): the same row becomes an account, its
 * onboarding coins are claimed and any held Climb awards are paid, all in this transaction. The email
 * must not belong to another account (callers sign into that one instead).
 */
export async function becomeMember(tx: Tx, userId: string, email: string): Promise<SignUpResult> {
  const [locked] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
  if (!locked.isGuest) throw Object.assign(new Error("already_signed_up"), { statusCode: 409 }); // two sign-ups racing
  const [user] = await tx.update(users)
    .set({ isGuest: false, email, emailVerifiedAt: new Date(), isAdmin: locked.isAdmin || adminEmails().has(email) })
    .where(eq(users.id, userId)).returning();
  const claim = await claimOnboardingReward(tx, user);
  const awardsPaid = await payHeldAwards(tx, userId);
  return { user, ...claim, awardsPaid };
}

/**
 * Post the onboarding round's coins as bonus, once: the ledger key is the normalised email (so Gmail
 * aliases share it) and the device may only have claimed for this account. Needs a signed-up account
 * with an email; a round already claimed, or none, is "none".
 */
export async function claimOnboardingReward(tx: Tx, user: User): Promise<{ onboardingBonus: OnboardingBonusOutcome; bonusKobo: number }> {
  if (user.isGuest || !user.email) return { onboardingBonus: "none", bonusKobo: 0 };
  const [round] = await tx.select().from(onboardingRounds).where(eq(onboardingRounds.userId, user.id)).for("update");
  if (!round || round.claimedAt || round.coinsKobo <= 0) return { onboardingBonus: "none", bonusKobo: 0 };
  const key = `onboarding:${normaliseEmail(user.email)}`;
  const outcome = await claimOutcome(tx, user.id, key, round.deviceHash);
  if (outcome === "granted") {
    await ledger.post(tx, { userId: user.id, kind: "bonus", amountKobo: round.coinsKobo, type: "onboarding_bonus", refType: "onboarding_round", refId: user.id, idempotencyKey: key });
  }
  await tx.update(onboardingRounds).set({ claimedAt: new Date(), claimOutcome: outcome }).where(eq(onboardingRounds.userId, user.id));
  return { onboardingBonus: outcome, bonusKobo: outcome === "granted" ? round.coinsKobo : 0 };
}

async function claimOutcome(tx: Tx, userId: string, key: string, deviceHash: string | null): Promise<OnboardingBonusOutcome> {
  const [paid] = await tx.select({ id: ledgerEntries.id }).from(ledgerEntries).where(eq(ledgerEntries.idempotencyKey, key));
  if (paid) return "already_claimed";
  if (!deviceHash) return "granted";
  await tx.insert(onboardingDevices).values({ deviceHash, userId }).onConflictDoNothing();
  const [device] = await tx.select().from(onboardingDevices).where(eq(onboardingDevices.deviceHash, deviceHash));
  return device.userId === userId ? "granted" : "device_claimed";
}

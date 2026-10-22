/**
 * Which account a verified sign-in lands on (ADR 0006), shared by the email code and Google/Apple:
 *  1. the provider identity is already an account's → that account;
 *  2. the verified email is an account's → that account (and the identity is attached to it);
 *  3. the session is a guest → the guest signs up: same row, its coins claimed, held awards paid;
 *  4. otherwise (a signed-up session signing into a new email) → sign_out_first.
 * An existing account never takes the guest's coins or anything else; the guest row is left as it is.
 */
import { attachIdentity, becomeMember, db, firebaseUidFor, memberByEmail, userByIdentity, type User } from "@contestly/db";
import { createCustomToken } from "@contestly/auth";
import type { OAuthProvider, OnboardingBonusOutcome, SignInAccount, SignInResult } from "@contestly/shared";
import { putOnBoard } from "../climb/boards.js";
import { httpError } from "../httpError.js";

export interface VerifiedSignIn {
  /** Lowercased and verified by us or the provider; null if the provider didn't vouch for one. */
  email: string | null;
  identity?: { provider: OAuthProvider; subject: string };
}

export interface SignInOutcome {
  userId: string;
  account: SignInAccount;
  onboardingBonus: OnboardingBonusOutcome;
  bonusKobo: number;
}

const existing = (userId: string): SignInOutcome => ({ userId, account: "existing", onboardingBonus: "none", bonusKobo: 0 });

export async function signIn(session: User, v: VerifiedSignIn): Promise<SignInOutcome> {
  const outcome = await db.transaction(async (tx): Promise<SignInOutcome> => {
    if (v.identity) {
      const owner = await userByIdentity(v.identity.provider, v.identity.subject, tx);
      if (owner && !owner.isGuest) return existing(owner.id);
    }
    const member = v.email ? await memberByEmail(v.email, tx) : null;
    if (member) {
      if (v.identity) await attachIdentity(tx, member.id, v.identity.provider, v.identity.subject);
      return existing(member.id);
    }
    if (!session.isGuest) throw httpError(409, "sign_out_first");
    if (!v.email) throw httpError(422, "email_not_verified");
    if (v.identity) await attachIdentity(tx, session.id, v.identity.provider, v.identity.subject);
    const up = await becomeMember(tx, session.id, v.email);
    return { userId: session.id, account: "upgraded", onboardingBonus: up.onboardingBonus, bonusKobo: up.bonusKobo };
  });
  if (outcome.account === "upgraded") await putOnBoard(outcome.userId);
  return outcome;
}

/** The session token for the account a sign-in landed on: the guest's own uid, or the existing account's. */
export async function withSessionToken(o: SignInOutcome): Promise<SignInResult> {
  const uid = await db.transaction((tx) => firebaseUidFor(o.userId, tx));
  return { customToken: await createCustomToken(uid), account: o.account, onboardingBonus: o.onboardingBonus, bonusKobo: o.bonusKobo };
}

/**
 * Who money can reach. Decided here only; every payout and withdrawal asks these.
 */
import type { WithdrawBlockReason } from "@contestly/shared";
import type { User } from "./schema.js";

/** Cash can be paid to a signed-up account with a verified email: never a guest, a system account or a deleted one. */
export const canBePaidCash = (u: Pick<User, "isSystem" | "isGuest" | "emailVerifiedAt" | "deletedAt">) =>
  !u.isSystem && !u.isGuest && !u.deletedAt && !!u.emailVerifiedAt;

type BanFields = Pick<User, "bannedAt"> & Partial<Pick<User, "bannedUntil">>;

/**
 * Banned or suspended by an admin (assertNotBanned refuses them at every door). A suspension counts until its
 * end, even before the worker's sweep has lifted it (ADR 0014).
 */
export const isBanned = (u: BanFields, now = new Date()) => !!u.bannedAt && (!u.bannedUntil || u.bannedUntil > now);

/**
 * A wallet nothing goes into or out of (ADR 0014): a banned or suspended account. Cash stays where it is.
 * Asked by every withdrawal (at request and again before it's sent), top-up creation and taking a seat.
 */
export const isWalletFrozen = (u: BanFields) => isBanned(u);

/** Withdrawals frozen by payments itself: a payout we reversed was paid after all, until an admin resolves it (ADR 0013). */
export const isUnderPaymentReview = (u: Pick<User, "withdrawalsFrozenAt">) => !!u.withdrawalsFrozenAt;

type WithdrawFields = Pick<User, "isSystem" | "isGuest" | "emailVerifiedAt" | "deletedAt" | "phoneVerifiedAt" | "bannedAt" | "withdrawalsFrozenAt"> & Partial<Pick<User, "isBrand">>;

/**
 * What the user row doesn't say: what they owe (ledger.owedKobo), and whether a deleted account with their
 * email or phone had a payment issue an admin hasn't cleared for this account (withdrawContext in payments).
 */
export interface WithdrawContext {
  owedKobo: number;
  linkedIssue?: boolean;
  /** A brand's account (ADR 0017 §8): whether it's verified, and why its owner couldn't withdraw as a person (null: they could). */
  brand?: { verified: boolean; ownerBlock: WithdrawBlockReason | null };
}

/** Why this account can't withdraw, or null if it can. The app shows the reason (withdraw_not_allowed). */
export function withdrawBlockReason(u: WithdrawFields, ctx: WithdrawContext): WithdrawBlockReason | null {
  if (u.isSystem) return "system";
  if (u.isGuest) return "guest";
  if (u.deletedAt) return "deleted";
  if (u.isBrand) {
    // A brand has no email or phone of its own: it must be verified, and its owner must pass a person's checks,
    // so a brand's payout still reaches one real person (ADR 0017 §8).
    if (!ctx.brand?.verified) return "brand_unverified";
    if (ctx.brand.ownerBlock) return "owner_cannot_withdraw";
  } else {
    if (!u.emailVerifiedAt) return "email_unverified";
    if (!u.phoneVerifiedAt) return "phone_unverified";
  }
  if (isWalletFrozen(u)) return "frozen";
  if (isUnderPaymentReview(u)) return "payment_review";
  if (ctx.owedKobo > 0) return "amount_owed";
  if (ctx.linkedIssue) return "linked_payment_issue";
  return null;
}

/** Withdrawing cash also needs a verified phone number, one per account, so payouts reach one real person; and a wallet that isn't frozen. */
export const canWithdraw = (u: WithdrawFields, ctx: WithdrawContext) => (u.isBrand || canBePaidCash(u)) && withdrawBlockReason(u, ctx) === null;

/**
 * Who money can reach. Decided here only; every payout and withdrawal asks these.
 */
import type { WithdrawBlockReason } from "@contestly/shared";
import type { User } from "./schema.js";

/** Cash can be paid to a signed-up account with a verified email: never a guest, a system account or a deleted one. */
export const canBePaidCash = (u: Pick<User, "isSystem" | "isGuest" | "emailVerifiedAt" | "deletedAt">) =>
  !u.isSystem && !u.isGuest && !u.deletedAt && !!u.emailVerifiedAt;

/** Banned by an admin (assertNotBanned refuses them at every door). */
export const isBanned = (u: Pick<User, "bannedAt">) => !!u.bannedAt;

/**
 * A wallet nothing may leave. Today that's a banned account; row 11 (trust and safety) adds its own freeze
 * here, and every withdrawal (at request and again before it's sent) already asks.
 */
export const isWalletFrozen = (u: Pick<User, "bannedAt">) => isBanned(u);

/** Withdrawals frozen by payments itself: a payout we reversed was paid after all, until an admin resolves it (ADR 0013). */
export const isUnderPaymentReview = (u: Pick<User, "withdrawalsFrozenAt">) => !!u.withdrawalsFrozenAt;

type WithdrawFields = Pick<User, "isSystem" | "isGuest" | "emailVerifiedAt" | "deletedAt" | "phoneVerifiedAt" | "bannedAt" | "withdrawalsFrozenAt">;

/** Why this account can't withdraw, or null if it can. The app shows the reason (withdraw_not_allowed). */
export function withdrawBlockReason(u: WithdrawFields): WithdrawBlockReason | null {
  if (u.isSystem) return "system";
  if (u.isGuest) return "guest";
  if (u.deletedAt) return "deleted";
  if (!u.emailVerifiedAt) return "email_unverified";
  if (!u.phoneVerifiedAt) return "phone_unverified";
  if (isWalletFrozen(u)) return "frozen";
  if (isUnderPaymentReview(u)) return "payment_review";
  return null;
}

/** Withdrawing cash also needs a verified phone number, one per account, so payouts reach one real person; and a wallet that isn't frozen. */
export const canWithdraw = (u: WithdrawFields) => canBePaidCash(u) && withdrawBlockReason(u) === null;

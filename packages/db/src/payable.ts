/**
 * Who money can reach. Decided here only; every payout and (row 10) withdrawal asks these.
 */
import type { User } from "./schema.js";

/** Cash can be paid to a signed-up account with a verified email: never a guest, a system account or a deleted one. */
export const canBePaidCash = (u: Pick<User, "isSystem" | "isGuest" | "emailVerifiedAt" | "deletedAt">) =>
  !u.isSystem && !u.isGuest && !u.deletedAt && !!u.emailVerifiedAt;

/** Withdrawing cash (row 10) also needs a verified phone number, one per account, so payouts reach one real person. */
export const canWithdraw = (u: Pick<User, "isSystem" | "isGuest" | "emailVerifiedAt" | "deletedAt" | "phoneVerifiedAt">) =>
  canBePaidCash(u) && !!u.phoneVerifiedAt;

/** Banned by an admin (assertNotBanned refuses them at every door). */
export const isBanned = (u: Pick<User, "bannedAt">) => !!u.bannedAt;

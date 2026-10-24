/**
 * Who money can reach. Decided here only; every payout and (row 10) withdrawal asks these.
 */
import type { User } from "./schema.js";

/** Cash can be paid to a signed-up account with a verified email: never a guest, never a system account. */
export const canBePaidCash = (u: Pick<User, "isSystem" | "isGuest" | "emailVerifiedAt">) =>
  !u.isSystem && !u.isGuest && !!u.emailVerifiedAt;

/** Withdrawing cash (row 10) also needs a verified phone number, one per account, so payouts reach one real person. */
export const canWithdraw = (u: Pick<User, "isSystem" | "isGuest" | "emailVerifiedAt" | "phoneVerifiedAt">) =>
  canBePaidCash(u) && !!u.phoneVerifiedAt;

/** Banned by an admin (assertNotBanned refuses them at every door). */
export const isBanned = (u: Pick<User, "bannedAt">) => !!u.bannedAt;

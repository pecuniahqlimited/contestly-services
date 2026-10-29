/**
 * Deleting an account (ADR 0010) is a soft delete: nothing is erased that could trace the account. The
 * row, its id, the ledger, chat lines, voice notes and results stay; what identified the person moves to
 * the archive columns, the live fields become the deleted placeholders, and the identities are disabled
 * so no session reaches it again. Relationships that would keep showing it to people (follows, pending
 * invites) are removed. Crew hand-over and the Firebase user are the API's part.
 */
import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { DELETED_AVATAR_EMOJI, DELETED_DISPLAY_NAME, DELETED_HANDLE_PREFIX, type DeletionBlocker } from "@contestly/shared";
import { db, type Tx } from "./client.js";
import { crewInvites, follows, ledgerAccounts, parties, partyInvites, partyPlayers, userIdentities, users, type User } from "./schema.js";
import * as ledger from "./ledger.js";

type Conn = Tx | typeof db;

/** A party that hasn't finished or been cancelled. */
const unfinished = inArray(parties.status, ["open", "live"]);

/** What stops a delete right now: cash in the wallet (support pays it out until row 10), or an unfinished party. */
export async function deletionBlockers(conn: Conn, userId: string): Promise<DeletionBlocker[]> {
  const [[cash], [seated], [hosting]] = await Promise.all([
    conn.select({ balance: ledgerAccounts.balanceKobo }).from(ledgerAccounts).where(and(eq(ledgerAccounts.userId, userId), eq(ledgerAccounts.kind, "cash"))),
    conn.select({ id: parties.id }).from(partyPlayers).innerJoin(parties, eq(parties.id, partyPlayers.partyId)).where(and(eq(partyPlayers.userId, userId), unfinished)).limit(1),
    conn.select({ id: parties.id }).from(parties).where(and(eq(parties.createdByUserId, userId), unfinished)).limit(1),
  ]);
  const blockers: DeletionBlocker[] = [];
  if ((cash?.balance ?? 0) > 0) blockers.push("cash_balance");
  if (seated || hosting) blockers.push("active_party");
  return blockers;
}

/** The live handle a deleted account takes: unique (its id) and reserved (handleSchema refuses the prefix). */
export const deletedHandle = (userId: string) => `${DELETED_HANDLE_PREFIX}${userId.replaceAll("-", "")}`;

export interface ArchiveResult {
  /** Firebase uids whose identities were disabled: the API disables those Firebase users. */
  firebaseUids: string[];
  forfeitedBonusKobo: number;
}

/**
 * The database side of a delete, in the caller's transaction (which has locked the user row and checked
 * deletionBlockers). Idempotent in effect: the ledger key makes the forfeit post once.
 */
export async function archiveAccount(tx: Tx, user: User, reason: string | null, now = new Date()): Promise<ArchiveResult> {
  await tx.update(users).set({
    deletedAt: now, deletedReason: reason,
    archivedEmail: user.email, archivedHandle: user.handle, archivedDisplayName: user.displayName, archivedAvatarEmoji: user.avatarEmoji,
    archivedBio: user.bio, archivedPhone: user.phone, archivedPhoneHmac: user.phoneHmac,
    email: null, handle: deletedHandle(user.id), displayName: DELETED_DISPLAY_NAME, avatarEmoji: DELETED_AVATAR_EMOJI, bio: null,
    phone: null, phoneHmac: null, interests: [], invitePartyId: null,
  }).where(eq(users.id, user.id));

  const disabled = await tx.update(userIdentities).set({ disabledAt: now })
    .where(and(eq(userIdentities.userId, user.id), isNull(userIdentities.disabledAt))).returning();

  // Bonus coins aren't withdrawable and die with the account; posted, never by touching an entry.
  const [bonus] = await tx.select({ balance: ledgerAccounts.balanceKobo }).from(ledgerAccounts).where(and(eq(ledgerAccounts.userId, user.id), eq(ledgerAccounts.kind, "bonus")));
  const forfeitedBonusKobo = Math.max(0, bonus?.balance ?? 0);
  if (forfeitedBonusKobo) {
    await ledger.post(tx, { userId: user.id, kind: "bonus", amountKobo: -forfeitedBonusKobo, type: "account_deleted_forfeit", refType: "user", refId: user.id, idempotencyKey: `account_deleted:${user.id}:bonus` });
  }

  await tx.delete(follows).where(or(eq(follows.followerId, user.id), eq(follows.followeeId, user.id)));
  await tx.update(crewInvites).set({ status: "dismissed", respondedAt: now }).where(and(eq(crewInvites.inviteeId, user.id), eq(crewInvites.status, "pending")));
  await tx.update(partyInvites).set({ status: "dismissed", respondedAt: now }).where(and(eq(partyInvites.inviteeId, user.id), eq(partyInvites.status, "pending")));
  // Device tokens arrive with row 9 (nudges); they're deleted here then.

  return { firebaseUids: disabled.filter((i) => i.provider === "firebase").map((i) => i.externalId), forfeitedBonusKobo };
}

/**
 * The retention job: deleted accounts older than `before` lose their archived personal fields (email,
 * phone and its hash, name, face, bio, About you answers). The row, its id, the handle it had and the
 * ledger stay. Returns how many were cleared.
 */
export async function clearExpiredArchives(before: Date): Promise<number> {
  const rows = await db.update(users).set({
    archivedEmail: null, archivedPhone: null, archivedPhoneHmac: null, archivedDisplayName: null, archivedAvatarEmoji: null, archivedBio: null,
    aboutAnswers: null, archiveClearedAt: sql`now()`,
  }).where(and(isNotNull(users.deletedAt), lt(users.deletedAt, before), isNull(users.archiveClearedAt))).returning({ id: users.id });
  return rows.length;
}

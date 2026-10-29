/**
 * Deleting an account (ADR 0010) is a soft delete: nothing is erased that could trace the account. The
 * row, its id, the ledger, chat lines, voice notes and results stay; what identified the person moves to
 * the archive columns, the live fields become the deleted placeholders, and the identities are disabled
 * so no session reaches it again. Follows and crew invites that would keep showing it to people move to
 * their archive tables; pending party invites are dismissed; Climb prizes not yet paid are voided (each
 * logged) and a run in progress ends as abandoned. Crew hand-over and the Firebase user are the API's part.
 */
import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { DELETED_AVATAR_EMOJI, DELETED_DISPLAY_NAME, DELETED_HANDLE_PREFIX, leaveWindow, type BlockingParty, type DeletionBlocker } from "@contestly/shared";
import { db, type Tx } from "./client.js";
import {
  archivedCrewInvites, archivedFollows, climbAwards, climbRuns, crewInvites, follows, ledgerAccounts, parties, partyInvites, partyPlayers, userIdentities, users, type User,
} from "./schema.js";
import * as ledger from "./ledger.js";
import { recordAdminAction, systemActorId } from "./admin.js";

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

/**
 * The unfinished parties behind active_party, each with what the person can do: leave it (a seat outside
 * the lock), cancel it (theirs, still open; hosts can't leave), or wait (a seat inside the lock, or live).
 */
export async function blockingParties(conn: Conn, userId: string, now = new Date()): Promise<BlockingParty[]> {
  const [seated, hosted] = await Promise.all([
    conn.select({ p: parties }).from(partyPlayers).innerJoin(parties, eq(parties.id, partyPlayers.partyId)).where(and(eq(partyPlayers.userId, userId), unfinished)),
    conn.select().from(parties).where(and(eq(parties.createdByUserId, userId), unfinished)),
  ]);
  const byId = new Map<string, BlockingParty>();
  for (const { p } of seated) byId.set(p.id, { id: p.id, title: p.title, startsAt: p.startsAt.toISOString(), action: leaveWindow(p, now) === "open" ? "leave" : "starts_soon" });
  for (const p of hosted) byId.set(p.id, { id: p.id, title: p.title, startsAt: p.startsAt.toISOString(), action: p.status === "open" ? "cancel" : "starts_soon" });
  return [...byId.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/** The live handle a deleted account takes: unique (its id) and reserved (handleSchema refuses the prefix). */
export const deletedHandle = (userId: string) => `${DELETED_HANDLE_PREFIX}${userId.replaceAll("-", "")}`;

export interface ArchiveResult {
  /** Firebase uids whose identities were disabled: the API disables those Firebase users. */
  firebaseUids: string[];
  forfeitedBonusKobo: number;
}

/** Why the system voided something on a delete, in admin_actions. */
const ACCOUNT_DELETED_REASON = "account_deleted";

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

  await archiveFollows(tx, user.id, now);
  await archiveCrewInvites(tx, user.id, now);
  await tx.update(partyInvites).set({ status: "dismissed", respondedAt: now }).where(and(eq(partyInvites.inviteeId, user.id), eq(partyInvites.status, "pending")));
  await voidUnpaidAwards(tx, user.id);
  await tx.update(climbRuns).set({ status: "abandoned", endedAt: now }).where(and(eq(climbRuns.userId, user.id), eq(climbRuns.status, "active")));
  // Device tokens arrive with row 9 (nudges); they're deleted here then.

  return { firebaseUids: disabled.filter((i) => i.provider === "firebase").map((i) => i.externalId), forfeitedBonusKobo };
}

/** Follows of or by the account, moved (same columns, plus when) to archived_follows. */
async function archiveFollows(tx: Tx, userId: string, now: Date) {
  const moved = await tx.delete(follows).where(or(eq(follows.followerId, userId), eq(follows.followeeId, userId))).returning();
  if (moved.length) await tx.insert(archivedFollows).values(moved.map((f) => ({ ...f, archivedAt: now })));
}

/** Crew invites to or from the account, any status, moved to archived_crew_invites. */
async function archiveCrewInvites(tx: Tx, userId: string, now: Date) {
  const moved = await tx.delete(crewInvites).where(or(eq(crewInvites.inviteeId, userId), eq(crewInvites.inviterId, userId))).returning();
  if (moved.length) await tx.insert(archivedCrewInvites).values(moved.map((i) => ({ ...i, archivedAt: now })));
}

/** Weekly Climb prizes still pending, or approved and held unpaid, become void; each is logged as the system's action. */
async function voidUnpaidAwards(tx: Tx, userId: string) {
  const unpaid = await tx.select().from(climbAwards).where(and(eq(climbAwards.userId, userId), inArray(climbAwards.status, ["pending", "approved"]))).for("update");
  if (!unpaid.length) return;
  const ids = unpaid.map((a) => a.id);
  await tx.update(climbAwards).set({ status: "void" }).where(inArray(climbAwards.id, ids));
  const actor = await systemActorId(tx);
  for (const a of unpaid) {
    await recordAdminAction(tx, {
      adminUserId: actor, action: "climb.award_void", targetType: "user", targetId: userId, reason: ACCOUNT_DELETED_REASON,
      before: { awardId: a.id, status: a.status }, after: { awardId: a.id, status: "void" },
    });
  }
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

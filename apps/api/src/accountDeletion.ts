/**
 * Deleting your own account (ADR 0010): after a fresh re-verification, refused while there's cash or an
 * unfinished party, then one transaction: crews handed over as on leave, the row archived, identities
 * disabled, bonus forfeited through the ledger. After it commits: the Everyone board, open sockets and
 * the Firebase user.
 */
import { eq } from "drizzle-orm";
import { archiveAccount, db, deletionBlockers, users, type User } from "@contestly/db";
import { disableFirebaseUser } from "@contestly/auth";
import {
  ADMIN_EVENTS_CHANNEL, DELETION_BLOCKER_MESSAGES, DELETION_REASONS, REVERIFY_REQUIRED, climbBoardKey, lagosDay, weekOf,
  type AdminEvent, type ChatMessage, type DeletionReason, type DeletionStatus,
} from "@contestly/shared";
import type { FastifyBaseLogger } from "fastify";
import { httpError } from "./httpError.js";
import { valkey } from "./redis.js";
import { clearReverified, reverifiedUntil } from "./reverify.js";
import { crewIdsOf, leaveCrewIn } from "./crews.js";
import { publishLine } from "./chats.js";

const blockerView = (code: keyof typeof DELETION_BLOCKER_MESSAGES) => ({ code, message: DELETION_BLOCKER_MESSAGES[code] });

/** GET /me/deletion: what the delete screen needs before asking anything. */
export async function deletionStatus(me: User): Promise<DeletionStatus> {
  const [until, blockers] = await Promise.all([reverifiedUntil(me.id), deletionBlockers(db, me.id)]);
  return { reverifiedUntil: until?.toISOString() ?? null, blockers: blockers.map(blockerView), reasons: [...DELETION_REASONS] };
}

export async function deleteAccount(me: User, reason: DeletionReason | undefined, log: FastifyBaseLogger) {
  if (!(await reverifiedUntil(me.id))) throw httpError(403, REVERIFY_REQUIRED);
  const { firebaseUids, lines } = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(users).where(eq(users.id, me.id)).for("update");
    if (locked.deletedAt) throw httpError(409, "already_deleted");
    const [blocker] = await deletionBlockers(tx, me.id);
    if (blocker) throw httpError(409, blocker, { message: DELETION_BLOCKER_MESSAGES[blocker] });
    const lines: ChatMessage[] = [];
    for (const crewId of await crewIdsOf(tx, me.id)) lines.push(...(await leaveCrewIn(tx, locked, crewId)).lines);
    const archived = await archiveAccount(tx, locked, reason ?? null);
    return { ...archived, lines };
  });

  await clearReverified(me.id);
  for (const l of lines) await publishLine(l);
  await valkey().zrem(climbBoardKey(weekOf(lagosDay())), me.id);
  const ev: AdminEvent = { kind: "user_deleted", userId: me.id };
  await valkey().publish(ADMIN_EVENTS_CHANNEL, JSON.stringify(ev));
  // Already unreachable (identities disabled); this stops Firebase refreshing the session. A failure is logged, not fatal.
  for (const uid of firebaseUids) {
    await disableFirebaseUser(uid).catch((err) => log.error({ err, userId: me.id, uid }, "account deleted, but disabling its Firebase user failed"));
  }
  return { deleted: true as const };
}

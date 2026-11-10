/**
 * A seat in a party: taking one (charged bonus first, then cash) and giving one up before the party
 * locks (refunded leg by leg). Each seat has its own id, and its entry is charged under a key made from
 * it, so leaving and rejoining charges a new entry and the refunds of the two never share a key.
 * Callers hold the party row lock (`for update`), as joins always do.
 */
import { randomUUID } from "node:crypto";
import { and, count, desc, eq } from "drizzle-orm";
import { BRAND_TEAM_MEMBER, HOST_MUST_CANCEL, NOT_IN_PARTY, PARTY_CLOSED, PARTY_LOCKED, WALLET_FROZEN, leaveWindow, type ChatMessage } from "@contestly/shared";
import type { Tx } from "./client.js";
import { chatMembers, partyChallengeInvitees, partyLeaves, partyPlayers, users, type Party } from "./schema.js";
import { isWalletFrozen } from "./payable.js";
import { isHostTeam } from "./host.js";
import { brandTeamBarredFrom } from "./brands/team.js";
import { partyThreadId, systemLine } from "./chat.js";
import * as ledger from "./ledger.js";

type Seat = Pick<typeof partyPlayers.$inferSelect, "partyId" | "userId" | "entryKey">;

/** The key a seat's entry was charged under. Seats from before leaving existed used one per party and player. */
export const entryChargeKey = (s: Seat) => s.entryKey ?? `party_entry:${s.partyId}:${s.userId}`;

/**
 * Take a seat: charge the entry (bonus first, then cash; InsufficientFunds if short) and seat the player. A frozen
 * wallet (a banned or suspended account, ADR 0014) takes no entry, whichever door it came through; nor does anyone on
 * the brand's team in a brand's party with a prize (brand_team_member).
 */
export async function takeSeat(tx: Tx, p: Pick<Party, "id" | "brandId" | "entryKobo" | "funding" | "prizeKind" | "hostPoolKobo">, userId: string, amountKobo: number) {
  const [u] = await tx.select({ bannedAt: users.bannedAt, bannedUntil: users.bannedUntil }).from(users).where(eq(users.id, userId));
  if (u && isWalletFrozen(u)) throw Object.assign(new Error(WALLET_FROZEN), { statusCode: 403 });
  // A brand's team never plays for its prizes (ADR 0017 §6): its free parties only. Settlement checks again.
  if ((await brandTeamBarredFrom(tx, p)).has(userId)) throw Object.assign(new Error(BRAND_TEAM_MEMBER), { statusCode: 403 });
  const id = randomUUID();
  const entryKey = `party_entry:${id}`;
  const paid = await ledger.charge(tx, { userId, amountKobo, type: "party_entry", refType: "party", refId: p.id, idempotencyKey: entryKey });
  await tx.insert(partyPlayers).values({ partyId: p.id, userId, id, entryKey });
  return paid;
}

export async function seatsTaken(tx: Tx, partyId: string): Promise<number> {
  const [{ n }] = await tx.select({ n: count() }).from(partyPlayers).where(eq(partyPlayers.partyId, partyId));
  return Number(n);
}

export type LeaveOutcome =
  /** `line`: the "<name> left" chat line, to publish once the transaction commits (none on a replay). */
  | { ok: true; replayed: boolean; refund: { toBonusKobo: number; toCashKobo: number }; taken: number; line?: ChatMessage }
  | { ok: false; status: 409; error: typeof HOST_MUST_CANCEL | typeof NOT_IN_PARTY | typeof PARTY_LOCKED | typeof PARTY_CLOSED };

/**
 * Give up a seat (CLAUDE.md, Parties): not the host; only while the party is open and outside the lock.
 * In the caller's transaction with the party row locked: the entry is refunded exactly as it was paid
 * (key from the seat's id, so a replay posts nothing), the seat is freed, the party chat is left, and the
 * leave is recorded. A player who already left gets that leave back (replayed), whatever the party's state.
 */
export async function leaveSeat(tx: Tx, p: Party, user: { id: string; displayName: string }, now = new Date()): Promise<LeaveOutcome> {
  // A brand's host team is never seated by hosting (ADR 0017 §6): a seated team member is a player and may leave.
  if (!p.brandId && (await isHostTeam(p, user.id, tx))) return { ok: false, status: 409, error: HOST_MUST_CANCEL };
  const [seat] = await tx.select().from(partyPlayers).where(and(eq(partyPlayers.partyId, p.id), eq(partyPlayers.userId, user.id)));
  if (!seat) {
    const [left] = await tx.select().from(partyLeaves).where(and(eq(partyLeaves.partyId, p.id), eq(partyLeaves.userId, user.id))).orderBy(desc(partyLeaves.leftAt)).limit(1);
    if (!left) return { ok: false, status: 409, error: NOT_IN_PARTY };
    return { ok: true, replayed: true, refund: { toBonusKobo: left.refundedBonusKobo, toCashKobo: left.refundedCashKobo }, taken: await seatsTaken(tx, p.id) };
  }
  const window = leaveWindow(p, now);
  if (window === "closed") return { ok: false, status: 409, error: PARTY_CLOSED };
  if (window === "locked") return { ok: false, status: 409, error: PARTY_LOCKED };
  return freeSeat(tx, p, seat, user, now, left(user));
}

/** How a seat ended: the line the party chat gets, and the answer a challenge's card shows for them (ADR 0019). */
interface SeatEnd { line: string; challengeAnswer: "left" | "expired" }
const left = (user: { displayName: string }): SeatEnd => ({ line: `${user.displayName} left`, challengeAnswer: "left" });

/**
 * The seat goes: its entry refunded as paid (keyed by the seat), the leave recorded, the party chat left, a line
 * written; in a challenge, the player's accepted answer becomes how it ended.
 */
async function freeSeat(tx: Tx, p: Party, seat: typeof partyPlayers.$inferSelect, user: { id: string; displayName: string }, now: Date, end: SeatEnd): Promise<LeaveOutcome & { ok: true }> {
  const { toBonus, toCash } = await ledger.refund(tx, { chargeKey: entryChargeKey(seat), type: "party_leave_refund", refType: "party", refId: p.id, idempotencyKey: `party_leave_refund:${seat.id}` });
  await tx.delete(partyPlayers).where(eq(partyPlayers.id, seat.id));
  await tx.insert(partyLeaves).values({ entryId: seat.id, partyId: p.id, userId: user.id, joinedAt: seat.joinedAt, refundedBonusKobo: toBonus, refundedCashKobo: toCash, leftAt: now });
  await tx.delete(chatMembers).where(and(eq(chatMembers.threadId, await partyThreadId(tx, p.id)), eq(chatMembers.userId, user.id)));
  await tx.update(partyChallengeInvitees).set({ answer: end.challengeAnswer, answeredAt: now })
    .where(and(eq(partyChallengeInvitees.partyId, p.id), eq(partyChallengeInvitees.userId, user.id), eq(partyChallengeInvitees.answer, "accepted")));
  const line = await systemLine(tx, p.id, end.line);
  return { ok: true, replayed: false, refund: { toBonusKobo: toBonus, toCashKobo: toCash }, taken: await seatsTaken(tx, p.id), line };
}

/**
 * A banned or suspended player's seat in someone else's open party (ADR 0014): freed and refunded as paid, the
 * leave's refund without its time lock (they can't be in the room anyway). Null when there's no seat, the party
 * isn't open any more (live and finished parties keep their rules), or they're its host (their party is cancelled instead).
 * Caller holds the party row lock.
 */
export async function removeSeat(tx: Tx, p: Party, user: { id: string; displayName: string }, now = new Date()) {
  if (p.status !== "open" || (!p.brandId && (await isHostTeam(p, user.id, tx)))) return null;
  const [seat] = await tx.select().from(partyPlayers).where(and(eq(partyPlayers.partyId, p.id), eq(partyPlayers.userId, user.id)));
  return seat ? freeSeat(tx, p, seat, user, now, left(user)) : null;
}

/**
 * A challenge's no-show at the join window's end (ADR 0019), the challenger as much as anyone: the seat freed and
 * refunded as paid, "<name> didn't make it", their answer expired. Null when there's no seat. Caller holds the party row lock.
 */
export async function dropNoShow(tx: Tx, p: Party, user: { id: string; displayName: string }, now = new Date()) {
  const [seat] = await tx.select().from(partyPlayers).where(and(eq(partyPlayers.partyId, p.id), eq(partyPlayers.userId, user.id)));
  return seat ? freeSeat(tx, p, seat, user, now, { line: `${user.displayName} didn't make it`, challengeAnswer: "expired" }) : null;
}

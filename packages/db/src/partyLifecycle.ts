/**
 * Cancelling a party with refunds: the one path every cancel takes (too few players, no playable set,
 * a room lost mid-round, an admin, the host). Runs inside the caller's transaction with the party row
 * locked; the caller tells the room. Idempotent: every refund is keyed per seat, the host's fund release
 * per party, so running it twice moves nothing the second time.
 */
import { and, count, eq, inArray, not } from "drizzle-orm";
import { NOT_HOST, PARTY_CLOSED, PARTY_LIVE, hostCancelMessage, type CancelledBy, type ChatMessage, type HostCancelResponse } from "@contestly/shared";
import { db, type Tx } from "./client.js";
import { ledgerAccounts, ledgerEntries, parties, partyPlayers, users, type Party } from "./schema.js";
import { recordAdminAction, systemActorId } from "./admin.js";
import { partyLifecycleLine, partyLineByKey } from "./chat.js";
import { isHostTeam } from "./host.js";
import * as ledger from "./ledger.js";
import { entryChargeKey } from "./seats.js";

/** Who cancelled, kept on the party. An admin's identity and reason live in admin_actions. */
export type CancelledByInput = { by: Exclude<CancelledBy, "host"> } | { by: "host"; userId: string; reason?: string | null };

/**
 * Refund every entry leg by leg, release exactly what was held for the host's cash prize, mark it cancelled
 * (and by whom), and write `message` in the party chat. Returns the seats refunded and that line, which
 * the caller publishes once the transaction commits.
 */
export async function refundAndCancel(tx: Tx, p: Party, message: string, cancelledBy: CancelledByInput = { by: "system" }): Promise<{ players: number; line: ChatMessage }> {
  const players = await tx.select().from(partyPlayers).where(eq(partyPlayers.partyId, p.id));
  // A seat charged under its own key (one per seat since leaving exists) is refunded under its own key too.
  for (const pl of players) await ledger.refund(tx, { chargeKey: entryChargeKey(pl), type: "party_refund", refType: "party", refId: p.id, idempotencyKey: pl.entryKey ? `party_refund:${pl.id}` : `party_refund:${p.id}:${pl.userId}` });
  await ledger.release(tx, { holdKey: `party_fund:${p.id}`, type: "party_refund", refType: "party", refId: p.id, idempotencyKey: `party_fund_refund:${p.id}` });
  await tx.update(parties).set({
    status: "cancelled", endedAt: new Date(), cancelledBy: cancelledBy.by,
    ...(cancelledBy.by === "host" ? { cancelledByUserId: cancelledBy.userId, cancelReason: cancelledBy.reason ?? null } : {}),
  }).where(eq(parties.id, p.id));
  const line = await partyLifecycleLine(tx, p.id, "cancelled", message);
  return { players: players.length, line };
}

export const UNRANKABLE_MESSAGE = "Nobody in this party could be placed, so it was cancelled. Entries have been refunded.";

/**
 * A finished round in which nobody can be ranked for prizes (everyone signed up was banned mid-game, say)
 * still has money in its pot: settlement must never leave it there (ADR 0013). Cancel it as the system,
 * refunding every seat the way it was paid, banned players included: a ban's wallet freeze (row 11) is what
 * holds their money, not the party. Logged as a system action naming the banned seats. Caller holds the party row.
 */
export async function cancelUnrankable(tx: Tx, p: Party) {
  const seats = await tx.select({ seatId: partyPlayers.id, userId: partyPlayers.userId, bannedAt: users.bannedAt, banReason: users.banReason }).from(partyPlayers)
    .innerJoin(users, eq(users.id, partyPlayers.userId)).where(eq(partyPlayers.partyId, p.id));
  const banned = seats.filter((s) => s.bannedAt).map((s) => ({ seatId: s.seatId, userId: s.userId, bannedAt: s.bannedAt!.toISOString(), banReason: s.banReason }));
  const out = await refundAndCancel(tx, p, UNRANKABLE_MESSAGE, { by: "system" });
  await recordAdminAction(tx, {
    adminUserId: await systemActorId(tx), action: "party.cancel_unplaceable", targetType: "party", targetId: p.id,
    reason: "settlement could place nobody; every seat refunded as paid", before: { status: p.status }, after: { status: "cancelled", seats: seats.length, bannedSeats: banned },
  });
  return { ...out, bannedSeats: banned.length };
}

/** What's in a party's pot right now (0 if it never had one). */
export async function potBalance(tx: Tx, partyId: string) {
  const [row] = await tx.select({ b: ledgerAccounts.balanceKobo }).from(ledgerAccounts).where(and(eq(ledgerAccounts.kind, "party_pot"), eq(ledgerAccounts.scope, partyId)));
  return row?.b ?? 0;
}

/**
 * Settlement found nobody it can place: if the pot has money in it, cancel (cancelUnrankable) and return
 * what happened; with an empty pot (a free party only guests played) there's nothing to do: null.
 */
export async function cancelIfUnplaceable(tx: Tx, p: Party) {
  if ((await potBalance(tx, p.id)) === 0) return null;
  return cancelUnrankable(tx, p);
}

export const ADMIN_CANCEL_MESSAGE = "This party was cancelled by Contestly. Everyone has been refunded.";

/**
 * An admin's cancel: refunds and cancels a scheduled or live party; anything already over is left alone.
 * The line comes back for the caller to publish after the commit; a replay (already cancelled by an admin)
 * gets it again with cancelled false, so a job that failed after its commit can still announce it.
 */
export async function adminCancelParty(tx: Tx, partyId: string): Promise<{ cancelled: boolean; refunded: number; line: ChatMessage | null }> {
  const [p] = await tx.select().from(parties).where(eq(parties.id, partyId)).for("update");
  if (p?.status === "cancelled" && p.cancelledBy === "admin") return { cancelled: false, refunded: 0, line: await partyLineByKey(tx, p.id, "cancelled") };
  if (!p || (p.status !== "open" && p.status !== "live")) return { cancelled: false, refunded: 0, line: null };
  const out = await refundAndCancel(tx, p, ADMIN_CANCEL_MESSAGE, { by: "admin" });
  return { cancelled: true, refunded: out.players, line: out.line };
}

/**
 * What a cancel gave back, read from the ledger (and the seats, which stay after a cancel), so a first
 * answer and a retry are the same.
 */
async function cancelRefunds(tx: Tx, partyId: string): Promise<HostCancelResponse["refunded"]> {
  const [{ n }] = await tx.select({ n: count() }).from(partyPlayers).where(eq(partyPlayers.partyId, partyId));
  const rows = await tx.select({ kind: ledgerAccounts.kind, amountKobo: ledgerEntries.amountKobo, key: ledgerEntries.idempotencyKey })
    .from(ledgerEntries).innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .where(and(eq(ledgerEntries.type, "party_refund"), eq(ledgerEntries.refType, "party"), eq(ledgerEntries.refId, partyId), inArray(ledgerAccounts.kind, [...ledger.USER_ACCOUNT_KINDS])));
  const seats = rows.filter((r) => !r.key.startsWith("party_fund_refund:"));
  const sum = (xs: typeof rows) => xs.reduce((a, r) => a + Number(r.amountKobo), 0);
  return {
    seats: Number(n),
    toBonusKobo: sum(seats.filter((r) => r.kind === "bonus")),
    toCashKobo: sum(seats.filter((r) => r.kind === "cash")),
    prizeReleasedKobo: sum(rows.filter((r) => r.key.startsWith("party_fund_refund:"))),
  };
}

export type HostCancelOutcome =
  | { ok: true; result: HostCancelResponse; party: Party; line?: ChatMessage; seatedUserIds: string[] }
  | { ok: false; status: 403 | 409; error: typeof NOT_HOST | typeof PARTY_LIVE | typeof PARTY_CLOSED };

/**
 * The host cancels their own party (CLAUDE.md, Parties): while it's open, inside the leave lock or not,
 * until it goes live. Same refund path as every cancel, in the caller's transaction with the row locked.
 * A host retrying a cancel they made gets the same result back; a party cancelled any other way is closed.
 */
export async function hostCancelParty(tx: Tx, partyId: string, userId: string, reason?: string): Promise<HostCancelOutcome | null> {
  const [p] = await tx.select().from(parties).where(eq(parties.id, partyId)).for("update");
  if (!p) return null;
  if (!isHostTeam(p, userId)) return { ok: false, status: 403, error: NOT_HOST };
  if (p.status === "cancelled" && p.cancelledBy === "host") {
    return { ok: true, result: { cancelled: true, replayed: true, refunded: await cancelRefunds(tx, p.id) }, party: p, seatedUserIds: [] };
  }
  if (p.status === "live") return { ok: false, status: 409, error: PARTY_LIVE };
  if (p.status !== "open") return { ok: false, status: 409, error: PARTY_CLOSED };
  const seated = await tx.select({ userId: partyPlayers.userId }).from(partyPlayers).where(and(eq(partyPlayers.partyId, p.id), not(eq(partyPlayers.userId, userId))));
  const { line } = await refundAndCancel(tx, p, hostCancelMessage(p), { by: "host", userId, reason });
  return { ok: true, result: { cancelled: true, replayed: false, refunded: await cancelRefunds(tx, p.id) }, party: p, line, seatedUserIds: seated.map((s) => s.userId) };
}

/** The room opened a question: the stall check measures from here (packages/db so the room and tests share it). */
export async function markRoundProgress(partyId: string, at = new Date()) {
  await db.update(parties).set({ roundProgressAt: at }).where(eq(parties.id, partyId));
}

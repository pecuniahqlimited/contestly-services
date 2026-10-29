/**
 * Cancelling a party with refunds: the one path every cancel takes (too few players, no playable set,
 * a room lost mid-round, an admin, the host). Runs inside the caller's transaction with the party row
 * locked; the caller tells the room. Idempotent: every refund is keyed per seat, the host's fund release
 * per party, so running it twice moves nothing the second time.
 */
import { and, count, eq, not } from "drizzle-orm";
import { NOT_HOST, PARTY_CLOSED, PARTY_LIVE, hostCancelMessage, type CancelledBy, type ChatMessage, type HostCancelResponse } from "@contestly/shared";
import type { Tx } from "./client.js";
import { ledgerAccounts, ledgerEntries, parties, partyPlayers, type Party } from "./schema.js";
import { systemLine } from "./chat.js";
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
  const line = await systemLine(tx, p.id, message);
  return { players: players.length, line };
}

export const ADMIN_CANCEL_MESSAGE = "This party was cancelled by Contestly. Everyone has been refunded.";

/** An admin's cancel: refunds and cancels a scheduled or live party; anything already over is left alone. */
export async function adminCancelParty(tx: Tx, partyId: string): Promise<{ cancelled: boolean; refunded: number }> {
  const [p] = await tx.select().from(parties).where(eq(parties.id, partyId)).for("update");
  if (!p || (p.status !== "open" && p.status !== "live")) return { cancelled: false, refunded: 0 };
  return { cancelled: true, refunded: (await refundAndCancel(tx, p, ADMIN_CANCEL_MESSAGE, { by: "admin" })).players };
}

/**
 * What a cancel gave back, read from the ledger (and the seats, which stay after a cancel), so a first
 * answer and a retry are the same.
 */
async function cancelRefunds(tx: Tx, partyId: string): Promise<HostCancelResponse["refunded"]> {
  const [{ n }] = await tx.select({ n: count() }).from(partyPlayers).where(eq(partyPlayers.partyId, partyId));
  const rows = await tx.select({ kind: ledgerAccounts.kind, amountKobo: ledgerEntries.amountKobo, key: ledgerEntries.idempotencyKey })
    .from(ledgerEntries).innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .where(and(eq(ledgerEntries.type, "party_refund"), eq(ledgerEntries.refType, "party"), eq(ledgerEntries.refId, partyId)));
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

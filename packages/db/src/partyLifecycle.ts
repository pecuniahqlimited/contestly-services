/**
 * Cancelling a party with refunds: the one path every cancel takes (too few players, no playable set,
 * a room lost mid-round, an admin). Runs inside the worker's transaction with the party row locked;
 * the worker tells the room. Idempotent: every refund is keyed per player, the host's fund release
 * per party, so running it twice moves nothing the second time.
 */
import { eq } from "drizzle-orm";
import type { Tx } from "./client.js";
import { parties, partyPlayers, type Party } from "./schema.js";
import { systemLine } from "./chat.js";
import * as ledger from "./ledger.js";

/** Refund every entry leg by leg, release exactly what was held for the host's cash prize, and mark it cancelled. Returns the players refunded. */
export async function refundAndCancel(tx: Tx, p: Party, message: string): Promise<number> {
  const players = await tx.select().from(partyPlayers).where(eq(partyPlayers.partyId, p.id));
  for (const pl of players) await ledger.refund(tx, { chargeKey: `party_entry:${p.id}:${pl.userId}`, type: "party_refund", refType: "party", refId: p.id, idempotencyKey: `party_refund:${p.id}:${pl.userId}` });
  await ledger.release(tx, { holdKey: `party_fund:${p.id}`, type: "party_refund", refType: "party", refId: p.id, idempotencyKey: `party_fund_refund:${p.id}` });
  await tx.update(parties).set({ status: "cancelled", endedAt: new Date() }).where(eq(parties.id, p.id));
  await systemLine(tx, p.id, message);
  return players.length;
}

export const ADMIN_CANCEL_MESSAGE = "This party was cancelled by Contestly. Everyone has been refunded.";

/** An admin's cancel: refunds and cancels a scheduled or live party; anything already over is left alone. */
export async function adminCancelParty(tx: Tx, partyId: string): Promise<{ cancelled: boolean; refunded: number }> {
  const [p] = await tx.select().from(parties).where(eq(parties.id, partyId)).for("update");
  if (!p || (p.status !== "open" && p.status !== "live")) return { cancelled: false, refunded: 0 };
  return { cancelled: true, refunded: await refundAndCancel(tx, p, ADMIN_CANCEL_MESSAGE) };
}

/**
 * What a ban or suspension does once it has committed (ADR 0014), run by the worker so every refund goes through
 * the ledger's own paths: the person's hosted open parties are cancelled and refunded (adminCancelParty, the one
 * cancel path), their seats in others' open parties are freed and refunded as paid (removeSeat), and their
 * withdrawals not yet sent are held for a payments admin (holdWithdrawalsOf), never reversed. Live parties keep
 * their own rules: rooms dropped the person, and settlement skips them for prizes. Safe to run again.
 */
import { and, eq, inArray } from "drizzle-orm";
import { adminCancelParty, db, isBanned, parties, partyPlayers, removeSeat, users, withdrawNudges, type Party } from "@contestly/db";
import { holdWithdrawalsOf } from "@contestly/payments";
import type { ChatMessage, SeatsChangedEvent } from "@contestly/shared";

export interface BanEffectDeps {
  /** A party cancelled here: tell its room and chat (the worker's announceCancelled). */
  announceCancelled: (partyId: string, line: ChatMessage) => Promise<void>;
  publishLine: (line: ChatMessage) => Promise<void>;
  emitSeats: (ev: SeatsChangedEvent) => Promise<unknown>;
}

export async function applyBanEffects(deps: BanEffectDeps, userId: string) {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u || !isBanned(u)) return { cancelled: 0, seatsFreed: 0, withdrawalsHeld: 0 }; // unbanned since: nothing to do

  const hosted = await db.select({ id: parties.id }).from(parties).where(and(eq(parties.createdByUserId, userId), eq(parties.status, "open")));
  let cancelled = 0;
  for (const { id } of hosted) {
    const out = await db.transaction((tx) => adminCancelParty(tx, id));
    if (out.line) await deps.announceCancelled(id, out.line);
    if (out.cancelled) cancelled++;
  }

  const seated = await db.select({ partyId: partyPlayers.partyId }).from(partyPlayers).innerJoin(parties, eq(parties.id, partyPlayers.partyId))
    .where(and(eq(partyPlayers.userId, userId), inArray(parties.status, ["open"])));
  let seatsFreed = 0;
  for (const { partyId } of seated) {
    const out = await db.transaction(async (tx) => {
      const [p] = await tx.select().from(parties).where(eq(parties.id, partyId)).for("update");
      return p ? { p, freed: await removeSeat(tx, p as Party, u) } : null;
    });
    if (!out?.freed) continue;
    seatsFreed++;
    await withdrawNudges(db, partyId, userId);
    if (out.freed.line) await deps.publishLine(out.freed.line);
    await deps.emitSeats({ partyId, status: "player_left", userId, seats: { taken: out.freed.taken, max: out.p.maxPlayers } });
  }

  const withdrawalsHeld = await holdWithdrawalsOf(userId);
  return { cancelled, seatsFreed, withdrawalsHeld };
}

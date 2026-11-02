/**
 * A payout we reversed that the provider later said was paid (ADR 0013). The person has the money twice, so
 * the moment it's heard (payouts.ts, freezeForContradiction), in the same transaction as the alert: their
 * withdrawals freeze, their unsent withdrawals are reversed, and the disputed amount is held (from their cash,
 * and the rest booked as owed). Resolving it is maker-checker: one admin with payments.finalize asks, a
 * different one confirms, and the provider is asked again at the confirm (confirmContradictionResolution).
 * Every step logged. Nobody acts on their own payout.
 */
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { db, ledger, payoutContradictions, payouts, recordAdminAction, users, type PayoutContradiction, type Tx } from "@contestly/db";
import { OWN_TRANSACTION, SECOND_ADMIN_REQUIRED } from "@contestly/shared";
import { lockPerson, paymentsError } from "./common.js";
import { bookFee, queryProvider } from "./payouts.js";

const iso = (d: Date | null) => d?.toISOString() ?? null;
export const contradictionView = (c: PayoutContradiction) => ({
  id: c.id, payoutId: c.payoutId, userId: c.userId, amountKobo: c.amountKobo, status: c.status, providerCheck: c.providerCheck,
  requestedBy: c.requestedByUserId, requestReason: c.requestReason, confirmedBy: c.confirmedByUserId,
  recoveredKobo: c.recoveredKobo, owedKobo: c.owedKobo, createdAt: c.createdAt.toISOString(), resolvedAt: iso(c.resolvedAt),
});

export async function listContradictions(open: boolean, limit: number) {
  const rows = await db.select().from(payoutContradictions).where(open ? ne(payoutContradictions.status, "resolved") : undefined).orderBy(desc(payoutContradictions.createdAt)).limit(limit);
  return rows.map(contradictionView);
}

async function lockContradiction(tx: Tx, id: string) {
  const [c] = await tx.select().from(payoutContradictions).where(eq(payoutContradictions.id, id)).for("update");
  if (!c) throw paymentsError(404, "not_found");
  return c;
}

/** The first admin asks to resolve it, with a reason. Nothing moves until a second admin confirms. */
export async function requestContradictionResolution(adminUserId: string, id: string, reason: string, now = new Date()) {
  return db.transaction(async (tx) => {
    const c = await lockContradiction(tx, id);
    if (c.userId === adminUserId) throw paymentsError(403, OWN_TRANSACTION);
    if (c.status !== "open") throw paymentsError(409, "contradiction_not_open", { status: c.status });
    const [after] = await tx.update(payoutContradictions).set({ status: "awaiting_second_admin", requestedByUserId: adminUserId, requestReason: reason, requestedAt: now })
      .where(eq(payoutContradictions.id, id)).returning();
    await recordAdminAction(tx, { adminUserId, action: "payments.contradiction_requested", targetType: "payout", targetId: c.payoutId, reason, before: { status: c.status }, after: { status: after.status, contradictionId: id } });
    return contradictionView(after);
  });
}

/** Withdrawals unfreeze once none of the person's contradictions is still open (what's owed keeps blocking them). */
async function unfreezeIfClear(tx: Tx, userId: string) {
  const [stillOpen] = await tx.select({ id: payoutContradictions.id }).from(payoutContradictions)
    .where(and(eq(payoutContradictions.userId, userId), inArray(payoutContradictions.status, ["open", "awaiting_second_admin"])));
  if (!stillOpen) await tx.update(users).set({ withdrawalsFrozenAt: null }).where(eq(users.id, userId));
  return !stillOpen;
}

/**
 * A second admin confirms, and the server asks the provider again first:
 * - still paid: the hold becomes the recovery (never back to cash): hold → payout_settled (and the fee as
 *   paid). What was booked as owed at the freeze stays owed. Withdrawals unfreeze if nothing else is open,
 *   and stay blocked by amount_owed while anything is owed.
 * - reversed or failed since: the contradiction dissolves. The hold goes back: what's still owed for it is
 *   cleared, the rest returns to their cash; withdrawals unfreeze. Logged with why.
 * - anything else: nothing changes (409 provider_not_definite); ask again later.
 * Idempotent on payout_recovery:<payout id> / contradiction_release:<payout id>.
 */
export async function confirmContradictionResolution(adminUserId: string, id: string, now = new Date()) {
  const [pre] = await db.select().from(payoutContradictions).where(eq(payoutContradictions.id, id));
  if (!pre) throw paymentsError(404, "not_found");
  const [payout] = await db.select().from(payouts).where(eq(payouts.id, pre.payoutId));
  const check = await queryProvider(payout);
  return db.transaction(async (tx) => {
    await lockPerson(tx, pre.userId); // the lock order: the person, then transaction rows, then accounts
    const c = await lockContradiction(tx, id);
    if (c.status !== "awaiting_second_admin") throw paymentsError(409, "contradiction_not_pending", { status: c.status });
    if (c.requestedByUserId === adminUserId) throw paymentsError(403, SECOND_ADMIN_REQUIRED);
    if (c.userId === adminUserId) throw paymentsError(403, OWN_TRANSACTION);
    const [p] = await tx.select().from(payouts).where(eq(payouts.id, c.payoutId)).for("update");
    const hold = ledger.contradictionHoldAccount(c.userId);
    const checkSeen = { status: check.status, providerStatus: check.providerStatus, amountKobo: check.amountKobo, feeKobo: check.feeKobo, at: now.toISOString() };

    if (check.status === "failed") {
      const owedNow = await ledger.owedKobo(tx, c.userId);
      const clear = Math.min(owedNow, c.owedKobo ?? 0);
      const legs: ledger.Leg[] = [{ account: hold, amountKobo: -c.amountKobo }];
      if (clear > 0) legs.push({ account: ledger.owedAccount(c.userId), amountKobo: clear });
      if (c.amountKobo - clear > 0) legs.push({ account: { userId: c.userId, kind: "cash" }, amountKobo: c.amountKobo - clear });
      await ledger.journal(tx, { type: "contradiction_released", refType: "contradiction", refId: c.id, idempotencyKey: `contradiction_release:${p.id}`, legs });
      const [after] = await tx.update(payoutContradictions).set({ status: "dissolved", confirmedByUserId: adminUserId, resolvedAt: now }).where(eq(payoutContradictions.id, id)).returning();
      const unfrozen = await unfreezeIfClear(tx, c.userId);
      await recordAdminAction(tx, {
        adminUserId, action: "payments.contradiction_dissolved", targetType: "payout", targetId: p.id, reason: c.requestReason,
        before: { status: c.status }, after: { contradictionId: id, why: "the provider now says the transfer failed or was reversed", providerCheck: checkSeen, owedClearedKobo: clear, toCashKobo: c.amountKobo - clear, unfrozen },
      });
      return contradictionView(after);
    }
    if (check.status !== "success") throw paymentsError(409, "provider_not_definite", { check: checkSeen });

    // Still paid: the hold becomes the recovery, mirroring a settle. The fee as paid, by the same journal as a settle.
    const userPaidFee = p.amountKobo - p.sentKobo;
    const legs: ledger.Leg[] = [{ account: hold, amountKobo: -c.amountKobo }, { account: { system: "payout_settled", scope: p.provider }, amountKobo: p.sentKobo }];
    if (userPaidFee > 0) legs.push({ account: { system: "payout_fees", scope: p.provider }, amountKobo: userPaidFee });
    await ledger.journal(tx, { type: "withdrawal_recovered", refType: "payout", refId: p.id, idempotencyKey: `payout_recovery:${p.id}`, legs });
    const feeKobo = await bookFee(tx, p, check.feeKobo);
    await tx.update(payouts).set({ feeKobo, updatedAt: now }).where(eq(payouts.id, p.id));
    const [after] = await tx.update(payoutContradictions).set({ status: "resolved", confirmedByUserId: adminUserId, resolvedAt: now }).where(eq(payoutContradictions.id, id)).returning();
    const unfrozen = await unfreezeIfClear(tx, c.userId);
    await recordAdminAction(tx, {
      adminUserId, action: "payments.contradiction_resolved", targetType: "payout", targetId: p.id, reason: c.requestReason,
      before: { status: c.status }, after: { contradictionId: id, requestedBy: c.requestedByUserId, providerCheck: checkSeen, heldFromCashKobo: c.recoveredKobo, owedKobo: c.owedKobo, feeKobo, unfrozen },
    });
    return contradictionView(after);
  });
}

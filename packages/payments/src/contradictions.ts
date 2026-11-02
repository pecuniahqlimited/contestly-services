/**
 * A payout we reversed that the provider later said was paid (ADR 0013). The person has the money twice, so
 * the moment it's heard their withdrawals freeze, in the same transaction as the alert (payouts.ts). Resolving
 * it is maker-checker: one admin with payments.finalize asks, a different one confirms. On confirm, in one
 * transaction: the debit is re-applied from their cash, up to what's there; the rest is recorded as owed
 * (payout_owed); the transfer is booked as settled (and its fee as paid); withdrawals unfreeze once nothing
 * else is open for them. Every step logged. Nobody acts on their own payout.
 */
import { and, desc, eq, ne } from "drizzle-orm";
import { db, ledger, payoutContradictions, payouts, recordAdminAction, users, type PayoutContradiction, type Tx } from "@contestly/db";
import { OWN_TRANSACTION, SECOND_ADMIN_REQUIRED } from "@contestly/shared";
import { paymentsError } from "./common.js";

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

/**
 * A second admin confirms: recover what the person's cash covers, record the rest as owed, book the transfer
 * as sent, and unfreeze them if this was their last open contradiction. Idempotent on payout_recovery:<payout id>.
 */
export async function confirmContradictionResolution(adminUserId: string, id: string, now = new Date()) {
  return db.transaction(async (tx) => {
    const c = await lockContradiction(tx, id);
    if (c.status !== "awaiting_second_admin") throw paymentsError(409, "contradiction_not_pending", { status: c.status });
    if (c.requestedByUserId === adminUserId) throw paymentsError(403, SECOND_ADMIN_REQUIRED);
    if (c.userId === adminUserId) throw paymentsError(403, OWN_TRANSACTION);
    const [p] = await tx.select().from(payouts).where(eq(payouts.id, c.payoutId)).for("update");
    const { cash } = await ledger.lockUserAccounts(tx, c.userId);
    const recovered = Math.min(cash.balanceKobo, p.amountKobo);
    const owed = p.amountKobo - recovered;
    const check = c.providerCheck as { feeKobo?: number | null };
    const feeKobo = typeof check.feeKobo === "number" ? check.feeKobo : p.feeKobo;
    const userPaidFee = p.amountKobo - p.sentKobo;

    // Mirrors a settle: what the person had back leaves again, the transfer is booked as sent, the fee as paid.
    const legs: ledger.Leg[] = [{ account: { system: "payout_settled", scope: p.provider }, amountKobo: p.sentKobo }];
    if (recovered > 0) legs.push({ account: { userId: c.userId, kind: "cash" }, amountKobo: -recovered });
    if (owed > 0) legs.push({ account: { system: "payout_owed", scope: p.provider }, amountKobo: -owed });
    if (userPaidFee > 0) legs.push({ account: { system: "payout_fees", scope: p.provider }, amountKobo: userPaidFee });
    await ledger.journal(tx, { type: "withdrawal_recovered", refType: "payout", refId: p.id, idempotencyKey: `payout_recovery:${p.id}`, legs });
    const platformPart = feeKobo - userPaidFee;
    if (platformPart !== 0) {
      await ledger.journal(tx, {
        type: "withdrawal_fee", refType: "payout", refId: p.id, idempotencyKey: `payout_fee:${p.id}`,
        legs: [{ account: { system: "payout_fees", scope: p.provider }, amountKobo: platformPart }, { account: { system: "platform_funds" }, amountKobo: -platformPart }],
      });
    }
    await tx.update(payouts).set({ feeKobo, updatedAt: now }).where(eq(payouts.id, p.id));
    const [after] = await tx.update(payoutContradictions).set({ status: "resolved", confirmedByUserId: adminUserId, resolvedAt: now, recoveredKobo: recovered, owedKobo: owed })
      .where(eq(payoutContradictions.id, id)).returning();
    const [stillOpen] = await tx.select({ id: payoutContradictions.id }).from(payoutContradictions)
      .where(and(eq(payoutContradictions.userId, c.userId), ne(payoutContradictions.status, "resolved")));
    if (!stillOpen) await tx.update(users).set({ withdrawalsFrozenAt: null }).where(eq(users.id, c.userId));
    await recordAdminAction(tx, {
      adminUserId, action: "payments.contradiction_resolved", targetType: "payout", targetId: p.id, reason: c.requestReason,
      before: { status: c.status, cashKobo: cash.balanceKobo }, after: { contradictionId: id, requestedBy: c.requestedByUserId, recoveredKobo: recovered, owedKobo: owed, feeKobo, unfrozen: !stillOpen },
    });
    return contradictionView(after);
  });
}

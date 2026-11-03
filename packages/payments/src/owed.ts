/**
 * What people owe after a duplicate payout their cash didn't cover (ADR 0013). It sits in their payout_owed
 * account; every later cash credit repays it first (ledger.journal does that, as its own movement); bonus
 * coins never do. Withdrawals wait while anything is owed (amount_owed); playing doesn't.
 *
 * Waiving it is maker-checker: one admin with payments.finalize asks with a reason, a different one
 * confirms, and the platform bears it (payout_owed ← platform_funds), oldest contradiction's debt first,
 * one journal per debt naming it (owed_waiver:<waiver>:<contradiction>). Never while any of the person's
 * contradictions is still open (a dissolve could otherwise hand back money the platform waived). Nobody
 * waives their own. Never more than is owed when it's confirmed. Every step logged.
 */
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { db, moneyTransaction, ledger, ledgerAccounts, owedWaivers, payoutContradictions, recordAdminAction, users, type OwedWaiver, type Tx } from "@contestly/db";
import { OWN_TRANSACTION, SECOND_ADMIN_REQUIRED } from "@contestly/shared";
import { lockPerson, paymentsError } from "./common.js";

const iso = (d: Date | null) => d?.toISOString() ?? null;
export const owedWaiverView = (w: OwedWaiver) => ({
  id: w.id, userId: w.userId, amountKobo: w.amountKobo, reason: w.reason, status: w.status, requestedBy: w.requestedByUserId,
  confirmedBy: w.confirmedByUserId, waivedKobo: w.waivedKobo, createdAt: w.createdAt.toISOString(), appliedAt: iso(w.appliedAt),
});

/** A waiver waits until none of the person's contradictions is open (409 contradiction_open). */
async function refuseWhileContradictionOpen(tx: Tx, userId: string) {
  const [open] = await tx.select({ id: payoutContradictions.id }).from(payoutContradictions)
    .where(and(eq(payoutContradictions.userId, userId), inArray(payoutContradictions.status, ["open", "awaiting_second_admin"])));
  if (open) throw paymentsError(409, "contradiction_open", { contradictionId: open.id });
}

/** Everyone who owes something, most first. */
export async function listOwed(limit: number) {
  const rows = await db.select({ userId: users.id, handle: users.handle, balance: ledgerAccounts.balanceKobo }).from(ledgerAccounts)
    .innerJoin(users, sql`${users.id}::text = ${ledgerAccounts.scope}`)
    .where(and(eq(ledgerAccounts.kind, "payout_owed"), lt(ledgerAccounts.balanceKobo, 0))).orderBy(ledgerAccounts.balanceKobo).limit(limit);
  return rows.map((r) => ({ userId: r.userId, handle: r.handle, amountKobo: -r.balance }));
}

export async function listOwedWaivers(limit: number) {
  return (await db.select().from(owedWaivers).orderBy(desc(owedWaivers.createdAt)).limit(limit)).map(owedWaiverView);
}

/** The first admin asks to waive what this person owes now. Nothing moves until a second admin confirms. */
export async function requestOwedWaiver(adminUserId: string, userId: string, reason: string) {
  if (userId === adminUserId) throw paymentsError(403, OWN_TRANSACTION);
  return moneyTransaction(async (tx) => {
    await lockPerson(tx, userId);
    await refuseWhileContradictionOpen(tx, userId);
    const owed = await ledger.owedKobo(tx, userId);
    if (owed <= 0) throw paymentsError(409, "nothing_owed");
    const [open] = await tx.select({ id: owedWaivers.id }).from(owedWaivers).where(and(eq(owedWaivers.userId, userId), eq(owedWaivers.status, "awaiting_second_admin")));
    if (open) throw paymentsError(409, "waiver_pending", { waiverId: open.id });
    const [w] = await tx.insert(owedWaivers).values({ userId, amountKobo: owed, reason, status: "awaiting_second_admin", requestedByUserId: adminUserId }).returning();
    await recordAdminAction(tx, { adminUserId, action: "payments.owed_waiver_requested", targetType: "user", targetId: userId, reason, before: { owedKobo: owed }, after: { waiverId: w.id } });
    return owedWaiverView(w);
  });
}

/** A second admin confirms: waives the smaller of the request and what's still owed (superseded if nothing is). */
export async function confirmOwedWaiver(adminUserId: string, waiverId: string, now = new Date()) {
  const [pre] = await db.select({ userId: owedWaivers.userId }).from(owedWaivers).where(eq(owedWaivers.id, waiverId));
  if (!pre) throw paymentsError(404, "not_found");
  return moneyTransaction(async (tx) => {
    await lockPerson(tx, pre.userId); // the lock order: the person, the waiver, then what they owe
    const [w] = await tx.select().from(owedWaivers).where(eq(owedWaivers.id, waiverId)).for("update");
    if (w.status !== "awaiting_second_admin") throw paymentsError(409, "waiver_not_pending", { status: w.status });
    if (w.requestedByUserId === adminUserId) throw paymentsError(403, SECOND_ADMIN_REQUIRED);
    if (w.userId === adminUserId) throw paymentsError(403, OWN_TRANSACTION);
    await refuseWhileContradictionOpen(tx, w.userId);
    const [treasury] = await tx.select({ id: users.id }).from(users).where(eq(users.handle, ledger.TREASURY_HANDLE));
    // Lock what they owe, so a credit repaying it at the same moment can't make the waiver overshoot.
    const [acct] = await tx.select().from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.userId, treasury.id), eq(ledgerAccounts.kind, "payout_owed"), eq(ledgerAccounts.scope, w.userId))).for("update");
    const owedNow = acct ? Math.max(0, -acct.balanceKobo) : 0;
    const waived = Math.min(w.amountKobo, owedNow);
    if (waived <= 0) {
      const [gone] = await tx.update(owedWaivers).set({ status: "superseded" }).where(eq(owedWaivers.id, w.id)).returning();
      await recordAdminAction(tx, { adminUserId, action: "payments.owed_waiver_superseded", targetType: "user", targetId: w.userId, reason: w.reason, before: { owedKobo: owedNow }, after: { waiverId: w.id } });
      return owedWaiverView(gone);
    }
    let left = waived;
    for (const d of await ledger.outstandingDebts(tx, w.userId)) {
      if (left <= 0) break;
      const amount = Math.min(left, d.outstanding);
      await ledger.journal(tx, {
        type: "owed_waived", refType: "contradiction", refId: d.contradictionId, idempotencyKey: `owed_waiver:${w.id}:${d.contradictionId}`,
        legs: [{ account: ledger.owedAccount(w.userId), amountKobo: amount }, { account: { system: "platform_funds" }, amountKobo: -amount }],
      });
      left -= amount;
    }
    if (left !== 0) throw new Error(`owed_waiver ${w.id}: ${left} kobo owed isn't attributed to any contradiction`);
    const [done] = await tx.update(owedWaivers).set({ status: "applied", confirmedByUserId: adminUserId, waivedKobo: waived, appliedAt: now }).where(eq(owedWaivers.id, w.id)).returning();
    await recordAdminAction(tx, {
      adminUserId, action: "payments.owed_waived", targetType: "user", targetId: w.userId, reason: w.reason,
      before: { owedKobo: owedNow }, after: { waiverId: w.id, waivedKobo: waived, owedKobo: owedNow - waived, requestedBy: w.requestedByUserId },
    });
    return owedWaiverView(done);
  });
}

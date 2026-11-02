/**
 * What people owe after a duplicate payout their cash didn't cover (ADR 0013). It sits in their payout_owed
 * account; every later cash credit repays it first (ledger.journal does that, as its own movement); bonus
 * coins never do. Withdrawals wait while anything is owed (amount_owed); playing doesn't.
 *
 * Waiving it is maker-checker: one admin with payments.finalize asks with a reason, a different one
 * confirms, and the platform bears it (payout_owed ← platform_funds, under owed_waiver:<id>). Nobody waives
 * their own. Never more than is owed when it's confirmed. Every step logged.
 */
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db, ledger, ledgerAccounts, owedWaivers, recordAdminAction, users, type OwedWaiver } from "@contestly/db";
import { OWN_TRANSACTION, SECOND_ADMIN_REQUIRED } from "@contestly/shared";
import { paymentsError } from "./common.js";

const iso = (d: Date | null) => d?.toISOString() ?? null;
export const owedWaiverView = (w: OwedWaiver) => ({
  id: w.id, userId: w.userId, amountKobo: w.amountKobo, reason: w.reason, status: w.status, requestedBy: w.requestedByUserId,
  confirmedBy: w.confirmedByUserId, waivedKobo: w.waivedKobo, createdAt: w.createdAt.toISOString(), appliedAt: iso(w.appliedAt),
});

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
  return db.transaction(async (tx) => {
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
  return db.transaction(async (tx) => {
    const [w] = await tx.select().from(owedWaivers).where(eq(owedWaivers.id, waiverId)).for("update");
    if (!w) throw paymentsError(404, "not_found");
    if (w.status !== "awaiting_second_admin") throw paymentsError(409, "waiver_not_pending", { status: w.status });
    if (w.requestedByUserId === adminUserId) throw paymentsError(403, SECOND_ADMIN_REQUIRED);
    if (w.userId === adminUserId) throw paymentsError(403, OWN_TRANSACTION);
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
    await ledger.journal(tx, {
      type: "owed_waived", refType: "owed", refId: w.userId, idempotencyKey: `owed_waiver:${w.id}`,
      legs: [{ account: ledger.owedAccount(w.userId), amountKobo: waived }, { account: { system: "platform_funds" }, amountKobo: -waived }],
    });
    const [done] = await tx.update(owedWaivers).set({ status: "applied", confirmedByUserId: adminUserId, waivedKobo: waived, appliedAt: now }).where(eq(owedWaivers.id, w.id)).returning();
    await recordAdminAction(tx, {
      adminUserId, action: "payments.owed_waived", targetType: "user", targetId: w.userId, reason: w.reason,
      before: { owedKobo: owedNow }, after: { waiverId: w.id, waivedKobo: waived, owedKobo: owedNow - waived, requestedBy: w.requestedByUserId },
    });
    return owedWaiverView(done);
  });
}

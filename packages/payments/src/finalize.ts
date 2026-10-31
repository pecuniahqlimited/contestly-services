/**
 * An admin finishing a stuck payout (submitted or unknown) or top-up (pending, mismatch or expired) by hand.
 * The server asks the provider fresh at the moment of asking (and again when a second admin confirms), keeps
 * that answer with the decision, and applies the choice through the same locked transitions as the automatic
 * path: a manual "failed" payout reverses once, a manual "success" settles once, a manual "success" top-up
 * credits once under the same ledger key. At or above a threshold a second admin must confirm (maker-checker).
 * Nobody finalizes or confirms their own top-up or withdrawal.
 */
import { and, eq } from "drizzle-orm";
import { db, getPaymentsConfig, paymentFinalizations, payouts, recordAdminAction, topups, type PaymentFinalization, type Payout, type Topup, type Tx } from "@contestly/db";
import { NOT_FINALIZABLE, OWN_TRANSACTION } from "@contestly/shared";
import { paymentsError } from "./common.js";
import { queryProvider, reverseLocked, settleLocked } from "./payouts.js";
import { creditLocked, failLocked, verifyWithProvider } from "./topups.js";
import type { ProviderCheck } from "./types.js";

export type FinalizeTarget = { type: "payout" | "topup"; id: string };
export type Outcome = "success" | "failed";

const FINALIZABLE = { payout: ["submitted", "unknown"], topup: ["pending", "mismatch", "expired"] } as const;

async function load(target: FinalizeTarget, tx: Tx | typeof db = db, lock = false): Promise<Payout | Topup> {
  const table = target.type === "payout" ? payouts : topups;
  const q = tx.select().from(table).where(eq(table.id, target.id));
  const [row] = lock ? await q.for("update") : await q;
  if (!row) throw paymentsError(404, "not_found");
  return row as Payout | Topup;
}

/** The provider's answer right now, in our terms (also what the console shows before an admin decides). */
export async function freshCheck(target: FinalizeTarget): Promise<ProviderCheck & { checkedAt: string }> {
  const row = await load(target);
  const check = target.type === "payout" ? await queryProvider(row as Payout) : await verifyWithProvider(row as Topup);
  return { ...check, checkedAt: new Date().toISOString() };
}

function assertFinalizable(target: FinalizeTarget, row: Payout | Topup, adminUserId: string) {
  if (row.userId === adminUserId) throw paymentsError(403, OWN_TRANSACTION);
  if (!(FINALIZABLE[target.type] as readonly string[]).includes(row.status)) throw paymentsError(409, NOT_FINALIZABLE, { status: row.status, finalizable: FINALIZABLE[target.type] });
}

async function applyLocked(tx: Tx, target: FinalizeTarget, outcome: Outcome, now: Date) {
  const row = await load(target, tx, true);
  if (!(FINALIZABLE[target.type] as readonly string[]).includes(row.status)) throw paymentsError(409, NOT_FINALIZABLE, { status: row.status });
  if (target.type === "payout") {
    const p = row as Payout;
    if (outcome === "success") await settleLocked(tx, p, "admin_finalize", null, now);
    else await reverseLocked(tx, p, "failed", "admin_finalize", now);
  } else {
    const t = row as Topup;
    if (outcome === "success") await creditLocked(tx, t, "admin_finalize", now);
    else await failLocked(tx, t, { reason: "admin_finalize" }, now);
  }
}

const view = (f: PaymentFinalization) => ({
  id: f.id, targetType: f.targetType, targetId: f.targetId, outcome: f.outcome, status: f.status, requestedBy: f.requestedByUserId, confirmedBy: f.confirmedByUserId,
  providerCheck: f.providerCheck as { status: string; providerStatus: string; amountKobo: number | null; checkedAt: string; error: string | null },
});

/** Ask to finalize. Below the threshold it applies at once; at or above it waits for a second admin. */
export async function requestFinalization(adminUserId: string, target: FinalizeTarget, outcome: Outcome, reason: string, now = new Date()) {
  assertFinalizable(target, await load(target), adminUserId);
  const check = await freshCheck(target);
  const cfg = await getPaymentsConfig();
  return db.transaction(async (tx) => {
    const row = await load(target, tx, true);
    assertFinalizable(target, row, adminUserId);
    const needsSecond = row.amountKobo >= cfg.finalize.secondAdminThresholdKobo;
    const [open] = await tx.select().from(paymentFinalizations).where(and(eq(paymentFinalizations.targetType, target.type), eq(paymentFinalizations.targetId, target.id), eq(paymentFinalizations.status, "awaiting_second_admin")));
    if (open) throw paymentsError(409, "finalization_pending", { finalizationId: open.id });
    const [f] = await tx.insert(paymentFinalizations).values({
      targetType: target.type, targetId: target.id, outcome, reason, providerCheck: check, requestedByUserId: adminUserId,
      status: needsSecond ? "awaiting_second_admin" : "applied", appliedAt: needsSecond ? null : now,
    }).returning();
    if (!needsSecond) await applyLocked(tx, target, outcome, now);
    await recordAdminAction(tx, {
      adminUserId, action: needsSecond ? "payments.finalize_requested" : "payments.finalize", targetType: target.type, targetId: target.id, reason,
      before: { status: row.status }, after: { outcome, finalizationId: f.id, providerCheck: check, awaitingSecondAdmin: needsSecond },
    });
    return view(f);
  });
}

/** A second admin confirms (and it applies), having seen their own fresh provider answer. */
export async function confirmFinalization(adminUserId: string, finalizationId: string, now = new Date()) {
  const [pending] = await db.select().from(paymentFinalizations).where(eq(paymentFinalizations.id, finalizationId));
  if (!pending) throw paymentsError(404, "not_found");
  const target: FinalizeTarget = { type: pending.targetType, id: pending.targetId };
  const check = await freshCheck(target);
  return db.transaction(async (tx) => {
    const [f] = await tx.select().from(paymentFinalizations).where(eq(paymentFinalizations.id, finalizationId)).for("update");
    if (f.status !== "awaiting_second_admin") throw paymentsError(409, "finalization_not_pending", { status: f.status });
    if (f.requestedByUserId === adminUserId) throw paymentsError(403, "second_admin_required");
    const row = await load(target, tx, true);
    if (row.userId === adminUserId) throw paymentsError(403, OWN_TRANSACTION);
    if (!(FINALIZABLE[target.type] as readonly string[]).includes(row.status)) {
      // Finished some other way meanwhile (a check, a webhook): this request no longer applies.
      const [gone] = await tx.update(paymentFinalizations).set({ status: "superseded" }).where(eq(paymentFinalizations.id, f.id)).returning();
      return view(gone);
    }
    await applyLocked(tx, target, f.outcome, now);
    const [done] = await tx.update(paymentFinalizations).set({ status: "applied", confirmedByUserId: adminUserId, appliedAt: now }).where(eq(paymentFinalizations.id, f.id)).returning();
    await recordAdminAction(tx, {
      adminUserId, action: "payments.finalize_confirmed", targetType: target.type, targetId: target.id, reason: f.reason,
      before: { status: row.status }, after: { outcome: f.outcome, finalizationId: f.id, requestedBy: f.requestedByUserId, providerCheck: check },
    });
    return view(done);
  });
}

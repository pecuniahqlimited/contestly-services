/**
 * An admin finishing a stuck payout (submitted or unknown) or top-up (pending, mismatch or expired) by hand.
 * The server asks the provider fresh at the moment of asking (and again when a second admin confirms), keeps
 * that answer with the decision, and applies the choice through the same locked transitions as the automatic
 * path: a manual "failed" payout reverses once, a manual "success" settles once, a manual "success" top-up
 * credits once under the same ledger key. Nobody finalizes or confirms their own top-up or withdrawal.
 *
 * The provider's answer is enforced, not just recorded (ADR 0013):
 * - A sent payout can't be finalized inside the resend window or the quiet period after its last send: a
 *   transfer still on its way looks "not found" or "pending", and reversing it would pay twice.
 * - One admin is enough only when the fresh answer is definite and agrees with the outcome, and the amount is
 *   under the threshold. Otherwise a second admin confirms, and both see why (secondAdminBecause).
 * - A top-up is credited by hand only with an amount the provider verified as paid; a different amount from
 *   what was asked needs the second admin. Never our own amount on trust.
 * - If the provider's answer has turned definite against the outcome by the time the second admin confirms,
 *   the request is superseded instead of applied.
 */
import { and, eq } from "drizzle-orm";
import { db, getPaymentsConfig, paymentFinalizations, payouts, recordAdminAction, topups, type PaymentFinalization, type Payout, type Topup, type Tx } from "@contestly/db";
import { CURRENCY, FINALIZE_TOO_SOON, NO_VERIFIED_AMOUNT, NOT_FINALIZABLE, OWN_TRANSACTION, SECOND_ADMIN_REQUIRED, type PaymentsConfig, type SecondAdminBecause } from "@contestly/shared";
import { paymentsError } from "./common.js";
import { queryProvider, reverseLocked, settleLocked } from "./payouts.js";
import { creditLocked, failLocked, verifyWithProvider } from "./topups.js";
import type { ProviderCheck } from "./types.js";

export type FinalizeTarget = { type: "payout" | "topup"; id: string };
export type Outcome = "success" | "failed";
type Checked = ProviderCheck & { checkedAt: string };

const FINALIZABLE = { payout: ["submitted", "unknown"], topup: ["pending", "mismatch", "expired"] } as const;

async function load(target: FinalizeTarget, tx: Tx | typeof db = db, lock = false): Promise<Payout | Topup> {
  const table = target.type === "payout" ? payouts : topups;
  const q = tx.select().from(table).where(eq(table.id, target.id));
  const [row] = lock ? await q.for("update") : await q;
  if (!row) throw paymentsError(404, "not_found");
  return row as Payout | Topup;
}

/** The provider's answer right now, in our terms (also what the console shows before an admin decides). */
export async function freshCheck(target: FinalizeTarget): Promise<Checked> {
  const row = await load(target);
  const check = target.type === "payout" ? await queryProvider(row as Payout) : await verifyWithProvider(row as Topup);
  return { ...check, checkedAt: new Date().toISOString() };
}

function assertFinalizable(target: FinalizeTarget, row: Payout | Topup, adminUserId: string) {
  if (row.userId === adminUserId) throw paymentsError(403, OWN_TRANSACTION);
  if (!(FINALIZABLE[target.type] as readonly string[]).includes(row.status)) throw paymentsError(409, NOT_FINALIZABLE, { status: row.status, finalizable: FINALIZABLE[target.type] });
}

/** A sent payout is off limits until both the resend window and the quiet period after its last send have passed. */
export function assertQuietSinceSend(p: Payout, cfg: PaymentsConfig, now: Date) {
  const lastSent = p.lastSentAt ?? p.submittedAt;
  if (!lastSent) return;
  const quietMs = Math.max(cfg.checks.resendAfterNotFoundSeconds * 1000, cfg.finalize.quietAfterSendMinutes * 60_000);
  const until = new Date(lastSent.getTime() + quietMs);
  if (now < until) throw paymentsError(409, FINALIZE_TOO_SOON, { lastSentAt: lastSent.toISOString(), until: until.toISOString() });
}

export interface Judgement { amountKobo: number; secondAdminBecause: SecondAdminBecause[] }

/**
 * What a manual finalize would apply and whether one admin is enough: only if the provider's fresh answer is
 * definite, agrees with the outcome, and the amount is under the threshold. Pure: the unit tests cover it.
 */
export function judge(target: FinalizeTarget["type"], row: Payout | Topup, outcome: Outcome, check: ProviderCheck, cfg: PaymentsConfig): Judgement {
  const because: SecondAdminBecause[] = [];
  const definite = check.status === "success" || check.status === "failed";
  const agrees = (outcome === "success" && check.status === "success") || (outcome === "failed" && check.status === "failed");
  if (!definite) because.push("check_not_definite");
  else if (!agrees) because.push("check_disagrees");
  let amountKobo = row.amountKobo;

  if (target === "topup" && outcome === "success") {
    // Credited only with what the provider says was paid, in naira, for this reference.
    if (check.status !== "success" || check.amountKobo === null) throw paymentsError(409, NO_VERIFIED_AMOUNT, { check: check.status });
    if (check.currency !== CURRENCY) throw paymentsError(409, NO_VERIFIED_AMOUNT, { currency: check.currency });
    const t = row as Topup;
    if ((check.reference !== null && check.reference !== t.reference) || (check.userId !== null && check.userId !== t.userId)) because.push("check_disagrees");
    if (check.amountKobo !== t.amountKobo) because.push("amount_differs");
    amountKobo = check.amountKobo;
  }
  if (target === "payout" && outcome === "success" && check.status === "success" && check.amountKobo !== null && check.amountKobo !== (row as Payout).sentKobo) because.push("amount_differs");
  if (amountKobo >= cfg.finalize.secondAdminThresholdKobo) because.push("over_threshold");
  return { amountKobo, secondAdminBecause: [...new Set(because)] };
}

async function applyLocked(tx: Tx, target: FinalizeTarget, outcome: Outcome, amountKobo: number, check: ProviderCheck, cfg: PaymentsConfig, now: Date) {
  const row = await load(target, tx, true);
  if (!(FINALIZABLE[target.type] as readonly string[]).includes(row.status)) throw paymentsError(409, NOT_FINALIZABLE, { status: row.status });
  if (target.type === "payout") {
    const p = row as Payout;
    assertQuietSinceSend(p, cfg, now);
    if (outcome === "success") await settleLocked(tx, p, "admin_finalize", check.status === "success" ? check.feeKobo : null, now);
    else await reverseLocked(tx, p, "failed", "admin_finalize", now);
  } else {
    const t = row as Topup;
    if (outcome === "success") await creditLocked(tx, t, "admin_finalize", now, amountKobo);
    else await failLocked(tx, t, { reason: "admin_finalize" }, now);
  }
}

type CheckView = { status: string; providerStatus: string; amountKobo: number | null; checkedAt: string; error: string | null };
const checkView = (c: Checked): CheckView => ({ status: c.status, providerStatus: c.providerStatus, amountKobo: c.amountKobo, checkedAt: c.checkedAt, error: c.error });
const view = (f: PaymentFinalization, confirmCheck: Checked | null = null) => ({
  id: f.id, targetType: f.targetType, targetId: f.targetId, outcome: f.outcome, status: f.status, requestedBy: f.requestedByUserId, confirmedBy: f.confirmedByUserId,
  amountKobo: f.amountKobo, providerCheck: f.providerCheck as CheckView, secondAdminBecause: f.secondAdminBecause as SecondAdminBecause[],
  confirmCheck: confirmCheck ? checkView(confirmCheck) : null,
});

/** Ask to finalize. With one admin's authority it applies at once; otherwise it waits for a second admin. */
export async function requestFinalization(adminUserId: string, target: FinalizeTarget, outcome: Outcome, reason: string, now = new Date()) {
  const cfg = await getPaymentsConfig();
  const first = await load(target);
  assertFinalizable(target, first, adminUserId);
  if (target.type === "payout") assertQuietSinceSend(first as Payout, cfg, now);
  const check = await freshCheck(target);
  return db.transaction(async (tx) => {
    const row = await load(target, tx, true);
    assertFinalizable(target, row, adminUserId);
    const { amountKobo, secondAdminBecause } = judge(target.type, row, outcome, check, cfg);
    const needsSecond = secondAdminBecause.length > 0;
    const [open] = await tx.select().from(paymentFinalizations).where(and(eq(paymentFinalizations.targetType, target.type), eq(paymentFinalizations.targetId, target.id), eq(paymentFinalizations.status, "awaiting_second_admin")));
    if (open) throw paymentsError(409, "finalization_pending", { finalizationId: open.id });
    const [f] = await tx.insert(paymentFinalizations).values({
      targetType: target.type, targetId: target.id, outcome, reason, providerCheck: check, amountKobo, secondAdminBecause, requestedByUserId: adminUserId,
      status: needsSecond ? "awaiting_second_admin" : "applied", appliedAt: needsSecond ? null : now,
    }).returning();
    if (!needsSecond) await applyLocked(tx, target, outcome, amountKobo, check, cfg, now);
    await recordAdminAction(tx, {
      adminUserId, action: needsSecond ? "payments.finalize_requested" : "payments.finalize", targetType: target.type, targetId: target.id, reason,
      before: { status: row.status }, after: { outcome, amountKobo, finalizationId: f.id, providerCheck: check, secondAdminBecause },
    });
    return view(f);
  });
}

/** True when the provider's answer is now definite and against the outcome (or, for a top-up, a different amount). */
function turnedAgainst(f: PaymentFinalization, check: ProviderCheck) {
  if (f.outcome === "failed") return check.status === "success";
  if (check.status === "failed") return true;
  return f.targetType === "topup" && (check.status !== "success" || check.amountKobo !== f.amountKobo);
}

/**
 * A second admin confirms, having seen the first admin's provider answer and why it needed them; the server
 * asks the provider again. Applied unless that answer has turned against the outcome (then superseded).
 */
export async function confirmFinalization(adminUserId: string, finalizationId: string, now = new Date()) {
  const [pending] = await db.select().from(paymentFinalizations).where(eq(paymentFinalizations.id, finalizationId));
  if (!pending) throw paymentsError(404, "not_found");
  const target: FinalizeTarget = { type: pending.targetType, id: pending.targetId };
  const cfg = await getPaymentsConfig();
  const check = await freshCheck(target);
  return db.transaction(async (tx) => {
    const [f] = await tx.select().from(paymentFinalizations).where(eq(paymentFinalizations.id, finalizationId)).for("update");
    if (f.status !== "awaiting_second_admin") throw paymentsError(409, "finalization_not_pending", { status: f.status });
    if (f.requestedByUserId === adminUserId) throw paymentsError(403, SECOND_ADMIN_REQUIRED);
    const row = await load(target, tx, true);
    if (row.userId === adminUserId) throw paymentsError(403, OWN_TRANSACTION);
    const finalizable = (FINALIZABLE[target.type] as readonly string[]).includes(row.status);
    if (!finalizable || turnedAgainst(f, check)) {
      // Finished some other way meanwhile, or the provider now says otherwise: this request no longer applies.
      const [gone] = await tx.update(paymentFinalizations).set({ status: "superseded" }).where(eq(paymentFinalizations.id, f.id)).returning();
      await recordAdminAction(tx, {
        adminUserId, action: "payments.finalize_superseded", targetType: target.type, targetId: target.id, reason: f.reason,
        before: { status: row.status }, after: { finalizationId: f.id, outcome: f.outcome, providerCheck: check, why: finalizable ? "provider_answer_changed" : "already_final" },
      });
      return view(gone, check);
    }
    await applyLocked(tx, target, f.outcome, f.amountKobo ?? row.amountKobo, check, cfg, now);
    const [done] = await tx.update(paymentFinalizations).set({ status: "applied", confirmedByUserId: adminUserId, appliedAt: now }).where(eq(paymentFinalizations.id, f.id)).returning();
    await recordAdminAction(tx, {
      adminUserId, action: "payments.finalize_confirmed", targetType: target.type, targetId: target.id, reason: f.reason,
      before: { status: row.status }, after: { outcome: f.outcome, amountKobo: f.amountKobo, finalizationId: f.id, requestedBy: f.requestedByUserId, secondAdminBecause: f.secondAdminBecause, requestCheck: f.providerCheck, providerCheck: check },
    });
    return view(done, check);
  });
}

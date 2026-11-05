/**
 * Withdrawals (ADR 0013): debit first, reverse only on a definite failure.
 *
 * requested ─ debit cash → payout_pending in the transaction that creates the row; no provider call before it commits.
 * awaiting_approval ─ over a threshold; an admin approves (→ requested) or rejects (reversed).
 * submitted ─ marked before the transfer is sent, so a crash after sending is never followed by a blind resend:
 *             anything submitted or unknown is queried by our reference first.
 * succeeded ─ definite success: payout_pending → payout_settled (and the fee to payout_fees). Final.
 * failed    ─ definite failure: payout_pending → the user's cash. Final.
 * unknown   ─ anything else: requeried with backoff until the provider is definite; never reversed, never
 *             timed out into either outcome; past a cutoff it alerts admins.
 *
 * Every transition locks the payout row. Settling and reversing share the ledger key payout_final:<id>, so at
 * most one of them can ever be written.
 *
 * Only the first send can be definitely refused. A resend (same reference, after the provider said "not
 * found") can be refused for reasons that say nothing about the first send (the first one emptied the balance,
 * say), so every refusal of a resend is unknown and queried again. A success heard after a reversal freezes the
 * person's withdrawals in the same transaction as its alert (payout_contradictions; contradictions.ts).
 */
import { randomUUID } from "node:crypto";
import { and, asc, count, eq, gte, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import { db, hasPaymentIssue, linkedIssueClearances, moneyTransaction, type LinkedIssueClearance, getPaymentsConfig, ledger, payoutAccounts, payoutContradictions, payouts, recordAdminAction, users, withdrawBlockReason, type Payout, type PayoutAccount, type Tx, type User, adminAlert } from "@contestly/db";
import {
  ACCOUNT_UNRESOLVED, feeFromTiers, normaliseEmail, SECOND_ADMIN_REQUIRED, BELOW_MINIMUM, CURRENCY, LIMIT_REACHED, OWN_TRANSACTION, PAYMENTS_PAUSED, PAYOUT_FINAL_STATUSES, WITHDRAW_NOT_ALLOWED, type PayoutView,
} from "@contestly/shared";
import { backoffMs, lockPerson, paymentsError, ONCE_PER_THING_SECONDS, type PaymentsDeps } from "./common.js";
import { currentSettings } from "./settings.js";
import { providerNamed } from "./providers/index.js";
import { payoutsToday } from "./limits.js";
import { unknownCheck, type ProviderCheck, type WebhookEvent } from "./types.js";

const HOUR_MS = 3600_000;
const TRANSFER_REASON = "Contestly withdrawal";
const isFinal = (p: Payout) => PAYOUT_FINAL_STATUSES.includes(p.status);
const last4 = (n: string) => n.slice(-4);

export const payoutView = (p: Payout, a: Pick<PayoutAccount, "bankName" | "accountNumber" | "accountName">): PayoutView => ({
  id: p.id, amountKobo: p.amountKobo, sentKobo: p.sentKobo, feeKobo: p.feeKobo, feeBearer: p.feeBearer, status: p.status,
  bankAccount: { bankName: a.bankName, accountNumberLast4: last4(a.accountNumber), accountName: a.accountName },
  createdAt: p.createdAt.toISOString(), finalAt: p.finalAt?.toISOString() ?? null,
});

type Linkable = Pick<User, "id" | "email" | "phoneHmac">;

/**
 * Deleted accounts sharing this person's email (normalised) or phone hash that carry a payment issue, by the
 * one rule retention keeps archives on (hasPaymentIssue: money owed, money held, a contradiction open; one
 * resolved and fully repaid, or dissolved, blocks nobody). Two indexed lookups, not an OR.
 */
export async function linkedIssueAccounts(conn: Tx | typeof db, user: Linkable): Promise<string[]> {
  if (!user.email && !user.phoneHmac) return [];
  const matched = and(isNotNull(users.deletedAt), ne(users.id, user.id), hasPaymentIssue(users.id));
  const byEmail = user.email ? await conn.select({ id: users.id }).from(users).where(and(eq(users.archivedEmailKey, normaliseEmail(user.email)), matched)) : [];
  const byPhone = user.phoneHmac ? await conn.select({ id: users.id }).from(users).where(and(eq(users.archivedPhoneHmac, user.phoneHmac), matched)) : [];
  return [...new Set([...byEmail, ...byPhone].map((a) => a.id))].sort();
}

/** The deleted accounts admins have cleared this person against (applied clearances). */
async function clearedAgainst(conn: Tx | typeof db, userId: string) {
  const rows = await conn.select({ ids: linkedIssueClearances.coveredUserIds }).from(linkedIssueClearances)
    .where(and(eq(linkedIssueClearances.userId, userId), eq(linkedIssueClearances.status, "applied")));
  return new Set(rows.flatMap((r) => r.ids));
}

/**
 * What withdrawBlockReason needs beyond the user row: what they owe, and whether a deleted account sharing
 * their email or phone carries a payment issue that no clearance for this account covers. Deleting frees the
 * email and phone for a new sign-up (ADR 0010); this keeps a debt from leaving with the old account.
 */
export async function withdrawContext(conn: Tx | typeof db, user: Linkable) {
  const owedKobo = await ledger.owedKobo(conn, user.id);
  const linked = await linkedIssueAccounts(conn, user);
  if (!linked.length) return { owedKobo, linkedIssue: false };
  const cleared = await clearedAgainst(conn, user.id);
  return { owedKobo, linkedIssue: linked.some((id) => !cleared.has(id)) };
}

const clearanceView = (c: LinkedIssueClearance) => ({
  id: c.id, userId: c.userId, coveredUserIds: c.coveredUserIds, reason: c.reason, status: c.status, requestedBy: c.requestedByUserId, confirmedBy: c.confirmedByUserId,
  createdAt: c.createdAt.toISOString(), appliedAt: c.appliedAt?.toISOString() ?? null,
});

/**
 * An admin has checked a new account against a deleted one with a payment issue and asks to let it withdraw.
 * Loosening, so maker-checker: nothing changes until a different admin confirms; neither is the account holder.
 */
export async function requestLinkedIssueClearance(adminUserId: string, userId: string, reason: string) {
  return moneyTransaction(async (tx) => {
    const u = await lockPerson(tx, userId);
    if (!u) throw paymentsError(404, "not_found");
    if (u.id === adminUserId) throw paymentsError(403, OWN_TRANSACTION);
    const [open] = await tx.select({ id: linkedIssueClearances.id }).from(linkedIssueClearances).where(and(eq(linkedIssueClearances.userId, userId), eq(linkedIssueClearances.status, "awaiting_second_admin")));
    if (open) throw paymentsError(409, "clearance_pending", { clearanceId: open.id });
    // It covers exactly the deleted accounts blocking them now; one matched later blocks again.
    const cleared = await clearedAgainst(tx, userId);
    const covering = (await linkedIssueAccounts(tx, u)).filter((id) => !cleared.has(id));
    if (!covering.length) throw paymentsError(409, "nothing_to_clear");
    const [c] = await tx.insert(linkedIssueClearances).values({ userId, coveredUserIds: covering, reason, status: "awaiting_second_admin", requestedByUserId: adminUserId }).returning();
    await recordAdminAction(tx, { adminUserId, action: "payments.linked_issue_clear_requested", targetType: "user", targetId: userId, reason, before: null, after: { clearanceId: c.id, coveredUserIds: covering } });
    return clearanceView(c);
  });
}

/** A second admin confirms: not whoever asked, not the account holder. Then the account may withdraw. Logged. */
export async function confirmLinkedIssueClearance(adminUserId: string, clearanceId: string, now = new Date()) {
  const [pre] = await db.select({ userId: linkedIssueClearances.userId }).from(linkedIssueClearances).where(eq(linkedIssueClearances.id, clearanceId));
  if (!pre) throw paymentsError(404, "not_found");
  return moneyTransaction(async (tx) => {
    const u = await lockPerson(tx, pre.userId);
    const [c] = await tx.select().from(linkedIssueClearances).where(eq(linkedIssueClearances.id, clearanceId)).for("update");
    if (c.status !== "awaiting_second_admin") throw paymentsError(409, "clearance_not_pending", { status: c.status });
    if (c.requestedByUserId === adminUserId) throw paymentsError(403, SECOND_ADMIN_REQUIRED);
    if (c.userId === adminUserId) throw paymentsError(403, OWN_TRANSACTION);
    const [done] = await tx.update(linkedIssueClearances).set({ status: "applied", confirmedByUserId: adminUserId, appliedAt: now }).where(eq(linkedIssueClearances.id, c.id)).returning();
    await recordAdminAction(tx, {
      adminUserId, action: "payments.linked_issue_cleared", targetType: "user", targetId: c.userId, reason: c.reason,
      before: null, after: { clearedAt: now.toISOString(), clearanceId: c.id, coveredUserIds: c.coveredUserIds, requestedBy: c.requestedByUserId },
    });
    return clearanceView(done);
  });
}

export interface WithdrawalRequest { amountKobo: number; bankAccountId: string; clientRequestId: string }

/**
 * Request a withdrawal. All checks and the debit in one transaction with the person's row locked, so two
 * requests at once can't overdraw or slip past a daily limit. A retry with the same clientRequestId returns
 * the first withdrawal.
 */
export async function requestPayout(user: User, req: WithdrawalRequest, deps: PaymentsDeps, now = new Date()): Promise<{ payout: Payout; replayed: boolean }> {
  const [settings, cfg] = await Promise.all([currentSettings(), getPaymentsConfig()]);
  if (settings.payoutsPaused) throw paymentsError(503, PAYMENTS_PAUSED, { what: "payouts" });
  const blocked = withdrawBlockReason(user, await withdrawContext(db, user));
  if (blocked) throw paymentsError(403, WITHDRAW_NOT_ALLOWED, { reason: blocked });
  if (req.amountKobo < cfg.payout.minKobo) throw paymentsError(422, BELOW_MINIMUM, { minKobo: cfg.payout.minKobo });
  if (req.amountKobo > cfg.payout.maxKobo) throw paymentsError(422, LIMIT_REACHED, { limit: "payout_max", maxKobo: cfg.payout.maxKobo });
  const provider = providerNamed(settings.payouts);
  if (!provider.payout) throw paymentsError(409, "provider_not_configured", { provider: provider.name });

  const out = await moneyTransaction(async (tx) => {
    // The person first (NO KEY UPDATE: FOR UPDATE deadlocked with a worker settling their earlier payout).
    const fresh = await lockPerson(tx, user.id);
    const [prior] = await tx.select().from(payouts).where(and(eq(payouts.userId, user.id), eq(payouts.clientRequestId, req.clientRequestId)));
    if (prior) return { payout: prior, replayed: true, hold: null as string | null, userHourCount: 0 };
    const blockedNow = withdrawBlockReason(fresh, await withdrawContext(tx, fresh));
    if (blockedNow) throw paymentsError(403, WITHDRAW_NOT_ALLOWED, { reason: blockedNow });

    const [account] = await tx.select().from(payoutAccounts).where(and(eq(payoutAccounts.id, req.bankAccountId), eq(payoutAccounts.userId, user.id)));
    if (!account || account.removedAt || account.provider !== provider.name) throw paymentsError(409, ACCOUNT_UNRESOLVED);

    const today = await payoutsToday(tx, user.id, now);
    const [lastHour] = await tx.select({ n: count() }).from(payouts).where(and(eq(payouts.userId, user.id), gte(payouts.createdAt, new Date(now.getTime() - HOUR_MS))));
    if (today.count + 1 > cfg.payout.dailyCount) throw paymentsError(409, LIMIT_REACHED, { limit: "payout_daily_count", dailyCount: cfg.payout.dailyCount });
    const todayTotal = today.totalKobo + req.amountKobo;
    if (todayTotal > cfg.payout.dailyAmountKobo) throw paymentsError(409, LIMIT_REACHED, { limit: "payout_daily_amount", dailyAmountKobo: cfg.payout.dailyAmountKobo, usedKobo: today.totalKobo });

    const feeKobo = feeFromTiers(provider.payout!.transferFeeTiers, req.amountKobo);
    const sentKobo = cfg.payout.feeBearer === "user" ? req.amountKobo - feeKobo : req.amountKobo;
    if (sentKobo <= 0) throw paymentsError(422, BELOW_MINIMUM, { minKobo: feeKobo + 1 });
    const userHourCount = Number(lastHour.n) + 1;
    const hold = req.amountKobo >= cfg.payout.approvalThresholdKobo ? "over_threshold"
      : todayTotal > cfg.payout.userDailyApprovalCeilingKobo ? "daily_ceiling"
      : userHourCount > cfg.velocity.userPayoutsPerHour ? "velocity" : null;

    const id = randomUUID();
    const [p] = await tx.insert(payouts).values({
      id, userId: user.id, clientRequestId: req.clientRequestId, payoutAccountId: account.id, amountKobo: req.amountKobo, sentKobo, feeKobo,
      feeBearer: cfg.payout.feeBearer, currency: CURRENCY, provider: provider.name, reference: `po-${id.replace(/-/g, "")}`,
      status: hold ? "awaiting_approval" : "requested", holdReason: hold, createdAt: now, updatedAt: now,
    }).returning();
    // The debit, before any provider call: cash → payout_pending (InsufficientFunds rolls it all back).
    await ledger.journal(tx, {
      type: "withdrawal", refType: "payout", refId: p.id, idempotencyKey: `payout_debit:${p.id}`,
      legs: [{ account: { userId: user.id, kind: "cash" }, amountKobo: -p.amountKobo }, { account: { system: "payout_pending", scope: p.provider }, amountKobo: p.amountKobo }],
    });
    return { payout: p, replayed: false, hold, userHourCount };
  });

  if (!out.replayed) {
    await velocityAlerts(out.payout, out.userHourCount, cfg.velocity, now);
    if (out.payout.status === "requested") await deps.enqueue({ kind: "payout_submit", payoutId: out.payout.id }, { jobId: `payout-submit-${out.payout.id}` });
  }
  return { payout: out.payout, replayed: out.replayed };
}

async function velocityAlerts(p: Payout, userHourCount: number, v: { payoutsPerHour: number; userPayoutsPerHour: number }, now: Date) {
  const hour = now.toISOString().slice(0, 13);
  const [all] = await db.select({ n: count() }).from(payouts).where(gte(payouts.createdAt, new Date(now.getTime() - HOUR_MS)));
  if (Number(all.n) > v.payoutsPerHour) await adminAlert({ severity: "warning", kind: "payments.payout_velocity", subject: "Withdrawals per hour are above the threshold", dedupeKey: `payout_velocity:${hour}`, details: { lastHour: Number(all.n), threshold: v.payoutsPerHour } });
  if (userHourCount > v.userPayoutsPerHour) await adminAlert({ severity: "warning", kind: "payments.user_payout_velocity", subject: "One person's withdrawals per hour are above the threshold", dedupeKey: `user_payout_velocity:${p.userId}:${hour}`, refType: "user", refId: p.userId, details: { lastHour: userHourCount, threshold: v.userPayoutsPerHour, payoutId: p.id } });
}

// ---- The locked transitions: every path (send, check, webhook, admin) ends in one of these. ----

const lockPayout = async (tx: Tx, id: string) => (await tx.select().from(payouts).where(eq(payouts.id, id)).for("update"))[0];

/**
 * Definite success: pending → settled (what reached the bank) and fees (what the user paid of the fee) under
 * payout_final:<id>; then the platform's part of the real fee under payout_fee:<id>.
 */
export async function settleLocked(tx: Tx, p: Payout, via: string, reportedFeeKobo: number | null, now: Date) {
  const userPaidFee = p.amountKobo - p.sentKobo;
  const legs: ledger.Leg[] = [{ account: { system: "payout_pending", scope: p.provider }, amountKobo: -p.amountKobo }, { account: { system: "payout_settled", scope: p.provider }, amountKobo: p.sentKobo }];
  if (userPaidFee > 0) legs.push({ account: { system: "payout_fees", scope: p.provider }, amountKobo: userPaidFee });
  await ledger.journal(tx, { type: "withdrawal_settled", refType: "payout", refId: p.id, idempotencyKey: `payout_final:${p.id}`, legs });
  const feeKobo = await bookFee(tx, p, reportedFeeKobo);
  await tx.update(payouts).set({ status: "succeeded", feeKobo, finalVia: via, finalAt: now, nextCheckAt: null, updatedAt: now }).where(eq(payouts.id, p.id));
}

/**
 * The rest of a sent payout's fee, once it's known to have gone out (a settle, or a contradiction resolved),
 * under payout_fee:<id>. Returns the fee booked (the provider's, else our estimate).
 * - The platform bears it: the whole fee from platform_funds.
 * - The user bears it: they paid our estimate already; the difference from what the provider actually
 *   charged goes to fee_variance, which may go either way (a lower real fee must not push platform_funds up).
 */
export async function bookFee(tx: Tx, p: Payout, reportedFeeKobo: number | null): Promise<number> {
  const userPaidFee = p.amountKobo - p.sentKobo;
  const feeKobo = reportedFeeKobo ?? p.feeKobo;
  const rest = feeKobo - userPaidFee;
  if (rest !== 0) {
    const from: ledger.AccountRef = userPaidFee > 0 ? { system: "fee_variance", scope: p.provider } : { system: "platform_funds" };
    await ledger.journal(tx, {
      type: "withdrawal_fee", refType: "payout", refId: p.id, idempotencyKey: `payout_fee:${p.id}`,
      legs: [{ account: { system: "payout_fees", scope: p.provider }, amountKobo: rest }, { account: from, amountKobo: -rest }],
    });
  }
  return feeKobo;
}

/** Definite failure (or an admin's rejection): payout_pending → the user's cash, under payout_final:<id>. */
export async function reverseLocked(tx: Tx, p: Payout, status: "failed" | "rejected", via: string, now: Date) {
  await ledger.journal(tx, {
    type: "withdrawal_returned", refType: "payout", refId: p.id, idempotencyKey: `payout_final:${p.id}`,
    legs: [{ account: { system: "payout_pending", scope: p.provider }, amountKobo: -p.amountKobo }, { account: { userId: p.userId, kind: "cash" }, amountKobo: p.amountKobo }],
  });
  await tx.update(payouts).set({ status, finalVia: via, finalAt: now, nextCheckAt: null, updatedAt: now }).where(eq(payouts.id, p.id));
}

const checkRecord = (c: ProviderCheck, via: string, at: Date) => ({ ...c, via, at: at.toISOString() });

export type PayoutOutcome = "succeeded" | "failed" | "unknown" | "unchanged";

/**
 * Apply a provider's answer to a payout, with the person's row and then the payout's locked (the lock order).
 * A webhook and a query racing make one transition.
 */
export async function applyOutcome(payoutId: string, check: ProviderCheck, via: string, now = new Date()): Promise<PayoutOutcome> {
  const cfg = await getPaymentsConfig();
  const [owner] = await db.select({ userId: payouts.userId }).from(payouts).where(eq(payouts.id, payoutId));
  return moneyTransaction(async (tx) => {
    await lockPerson(tx, owner.userId);
    const p = await lockPayout(tx, payoutId);
    const record = checkRecord(check, via, now);
    if (isFinal(p)) {
      if (p.status === "succeeded" && check.status === "failed") {
        // Never auto-fixed: the provider may have reversed it after paying. An admin works it out with the provider.
        await adminAlert({ severity: "critical", kind: "payments.payout_failed_after_success", subject: "A settled payout is now reported failed", dedupeKey: `payout_contradiction:${p.id}:failed`, refType: "payout", refId: p.id, details: { status: p.status, check: record }, dedupeWindowSeconds: ONCE_PER_THING_SECONDS }, tx);
      }
      if (p.status !== "succeeded") {
        const [c] = await tx.select().from(payoutContradictions).where(eq(payoutContradictions.payoutId, p.id));
        // A contradiction already worked out, and now the provider says the opposite again: an admin looks. Nothing moves.
        if (c?.status === "dissolved" && check.status === "success") {
          await adminAlert({ severity: "critical", kind: "payments.payout_success_after_dissolve", subject: "A payout is reported paid again after its contradiction dissolved", dedupeKey: `payout_success_after_dissolve:${p.id}`, refType: "payout", refId: p.id, details: { contradictionId: c.id, check: record }, dedupeWindowSeconds: ONCE_PER_THING_SECONDS }, tx);
        } else if (c?.status === "resolved" && check.status === "failed") {
          await adminAlert({ severity: "critical", kind: "payments.payout_reversed_after_resolve", subject: "A payout is reported reversed after its contradiction was resolved", dedupeKey: `payout_reversed_after_resolve:${p.id}`, refType: "payout", refId: p.id, details: { contradictionId: c.id, check: record }, dedupeWindowSeconds: ONCE_PER_THING_SECONDS }, tx);
        } else if (!c && check.status === "success") {
          await freezeForContradiction(tx, p, record, now);
        }
      }
      return "unchanged";
    }
    if (p.status !== "submitted" && p.status !== "unknown") return "unchanged"; // not sent yet: nothing a provider says applies
    if (check.status === "success" && check.amountKobo !== null && check.amountKobo !== p.sentKobo) {
      await adminAlert({ severity: "critical", kind: "payments.payout_amount_differs", subject: "The provider reports a different payout amount", dedupeKey: `payout_amount_differs:${p.id}`, refType: "payout", refId: p.id, details: { sentKobo: p.sentKobo, check: record }, dedupeWindowSeconds: ONCE_PER_THING_SECONDS }, tx);
      return markUnknown(tx, p, record, cfg, now);
    }
    if (check.status === "success") {
      await tx.update(payouts).set({ lastCheck: record }).where(eq(payouts.id, p.id));
      await settleLocked(tx, p, via, check.feeKobo, now);
      return "succeeded";
    }
    if (check.status === "failed") {
      await tx.update(payouts).set({ lastCheck: record }).where(eq(payouts.id, p.id));
      await reverseLocked(tx, p, "failed", via, now);
      return "failed";
    }
    return markUnknown(tx, p, record, cfg, now);
  });
}

/**
 * We gave the money back and the provider says it went out: the person has it twice. In this transaction (the
 * person's row is already locked), with the alert:
 * - their withdrawals freeze;
 * - every withdrawal of theirs not yet sent (requested, awaiting approval, queued while paused) is reversed to
 *   their cash, marked "contradiction";
 * - the disputed amount is secured in their contradiction_hold: what their cash covers is moved out of cash
 *   (so it can't be spent on entries either), the rest is booked as owed at once (repaid first from any cash
 *   that reaches them later, including a withdrawal in flight that comes back).
 * A withdrawal already sent (submitted, unknown) is left to finish; it's counted in the alert.
 * An admin and a second admin resolve it, after asking the provider again (contradictions.ts).
 */
async function freezeForContradiction(tx: Tx, p: Payout, record: Record<string, unknown>, now: Date) {
  const [c] = await tx.insert(payoutContradictions).values({ payoutId: p.id, userId: p.userId, amountKobo: p.amountKobo, providerCheck: record, createdAt: now }).onConflictDoNothing().returning();
  if (!c) return; // heard before: already frozen and held
  await tx.update(users).set({ withdrawalsFrozenAt: now }).where(and(eq(users.id, p.userId), isNull(users.withdrawalsFrozenAt)));
  const unsent = await tx.select().from(payouts).where(and(eq(payouts.userId, p.userId), inArray(payouts.status, ["requested", "awaiting_approval"]))).orderBy(asc(payouts.id)).for("update");
  for (const q of unsent) {
    await tx.update(payouts).set({ holdReason: "contradiction" }).where(eq(payouts.id, q.id));
    await reverseLocked(tx, q, "rejected", "contradiction", now);
  }
  const inFlight = await tx.select({ id: payouts.id, status: payouts.status, amountKobo: payouts.amountKobo }).from(payouts).where(and(eq(payouts.userId, p.userId), inArray(payouts.status, ["submitted", "unknown"])));
  const { cash } = await ledger.lockUserAccounts(tx, p.userId);
  const held = Math.min(cash.balanceKobo, p.amountKobo);
  const owed = p.amountKobo - held;
  const legs: ledger.Leg[] = [{ account: ledger.contradictionHoldAccount(p.userId), amountKobo: p.amountKobo }];
  if (held > 0) legs.push({ account: { userId: p.userId, kind: "cash" }, amountKobo: -held });
  if (owed > 0) legs.push({ account: ledger.owedAccount(p.userId), amountKobo: -owed });
  await ledger.journal(tx, { type: "contradiction_held", refType: "contradiction", refId: c.id, idempotencyKey: `contradiction_hold:${p.id}`, legs });
  await tx.update(payoutContradictions).set({ recoveredKobo: held, owedKobo: owed }).where(eq(payoutContradictions.id, c.id));
  await adminAlert({ severity: "critical", kind: "payments.payout_success_after_reversal", subject: "Duplicate payout: a reversed withdrawal was paid; withdrawals frozen", dedupeKey: `payout_contradiction:${p.id}:success`, refType: "payout", refId: p.id,
    details: { status: p.status, check: record, withdrawalsFrozen: true, heldFromCashKobo: held, owedKobo: owed, reversedUnsent: unsent.map((q) => q.id), inFlight }, dedupeWindowSeconds: ONCE_PER_THING_SECONDS }, tx);
}

/** Only a first send can be definitely refused: a refusal of a resend says nothing about the first send, so it's unknown. */
export function onResend(check: ProviderCheck): ProviderCheck {
  if (check.status !== "failed") return check;
  return { ...check, status: "unknown", providerStatus: `resend_refused: ${check.providerStatus}`, error: "a resend was refused; the first send may have gone through" };
}

async function markUnknown(tx: Tx, p: Payout, record: Record<string, unknown>, cfg: Awaited<ReturnType<typeof getPaymentsConfig>>, now: Date): Promise<PayoutOutcome> {
  const checks = p.checks + 1;
  await tx.update(payouts).set({ status: "unknown", lastCheck: record, checks, nextCheckAt: new Date(now.getTime() + backoffMs(checks, cfg.checks.payoutFirstCheckSeconds, cfg.checks.payoutMaxBackoffSeconds)), updatedAt: now }).where(eq(payouts.id, p.id));
  const since = p.submittedAt ?? p.createdAt;
  if (now.getTime() - since.getTime() > cfg.checks.unknownAlertAfterMinutes * 60_000) {
    await adminAlert({ severity: "warning", kind: "payments.payout_unknown_too_long", subject: "A payout is still unknown past the cutoff", dedupeKey: `payout_unknown_too_long:${p.id}`, refType: "payout", refId: p.id, details: { since: since.toISOString(), checks, lastCheck: record }, dedupeWindowSeconds: ONCE_PER_THING_SECONDS }, tx);
  }
  return "unknown";
}

async function ask(f: () => Promise<ProviderCheck>, reference: string): Promise<ProviderCheck> {
  try { return await f(); } catch (e) { return unknownCheck(reference, (e as Error).message); }
}
export const queryProvider = (p: Payout) => ask(async () => {
  const provider = providerNamed(p.provider).payout;
  return provider ? provider.queryTransfer(p.reference) : unknownCheck(p.reference, "provider has no payouts");
}, p.reference);

/**
 * The worker's send. Something already submitted or unknown is checked, never sent blind. A paused rail
 * leaves it requested (still debited; the sweep tries again). A wallet frozen since the request goes to an admin.
 */
export async function submitPayout(payoutId: string, now = new Date()): Promise<PayoutOutcome> {
  const [p] = await db.select().from(payouts).where(eq(payouts.id, payoutId));
  if (!p) return "unchanged";
  if (p.status === "submitted" || p.status === "unknown") return checkPayout(payoutId, "check", now);
  if (p.status !== "requested") return "unchanged";
  if ((await currentSettings()).payoutsPaused) return "unchanged";
  const [account] = await db.select().from(payoutAccounts).where(eq(payoutAccounts.id, p.payoutAccountId));

  const go = await moneyTransaction(async (tx): Promise<number | false> => {
    // The person, then the payout: a freeze committing meanwhile is seen here, never after the send.
    const u = await lockPerson(tx, p.userId);
    const row = await lockPayout(tx, payoutId);
    if (row.status !== "requested") return false;
    const blocked = withdrawBlockReason(u, await withdrawContext(tx, u));
    if (blocked) {
      await holdBlocked(tx, p.id, blocked, now);
      return false;
    }
    await tx.update(payouts).set({ status: "submitted", submittedAt: row.submittedAt ?? now, sendAttempts: row.sendAttempts + 1, lastSentAt: now, nextCheckAt: new Date(now.getTime() + 60_000), updatedAt: now }).where(eq(payouts.id, p.id));
    return row.sendAttempts + 1;
  });
  if (!go) return "unchanged";
  const answer = await send(p, account);
  return applyOutcome(payoutId, go > 1 ? onResend(answer) : answer, "send", now);
}

/** A requested withdrawal the account can no longer make waits for an admin (approve or reject), never reversed by itself. */
async function holdBlocked(tx: Tx, payoutId: string, blocked: string, now: Date) {
  await tx.update(payouts).set({ status: "awaiting_approval", holdReason: `blocked:${blocked}`, updatedAt: now }).where(eq(payouts.id, payoutId));
  await adminAlert({ severity: "warning", kind: "payments.payout_held_blocked", subject: "A withdrawal is held: the account can't withdraw", dedupeKey: `payout_held_blocked:${payoutId}`, refType: "payout", refId: payoutId, details: { reason: blocked }, dedupeWindowSeconds: ONCE_PER_THING_SECONDS }, tx);
}

/**
 * A ban or suspension committed (ADR 0014): their withdrawals not yet sent are held at once, the same hold the
 * send would make, rather than waiting for the worker's next send. One already with the provider is left to finish.
 * Returns how many were held.
 */
export async function holdWithdrawalsOf(userId: string, now = new Date()): Promise<number> {
  return moneyTransaction(async (tx) => {
    const u = await lockPerson(tx, userId);
    const blocked = withdrawBlockReason(u, await withdrawContext(tx, u));
    if (!blocked) return 0;
    const open = await tx.select({ id: payouts.id }).from(payouts).where(and(eq(payouts.userId, userId), eq(payouts.status, "requested"))).orderBy(asc(payouts.id)).for("update");
    for (const p of open) await holdBlocked(tx, p.id, blocked, now);
    return open.length;
  });
}

const send = (p: Payout, account: PayoutAccount) => ask(async () => {
  const provider = providerNamed(p.provider).payout;
  return provider ? provider.sendTransfer({ reference: p.reference, amountKobo: p.sentKobo, recipientCode: account.recipientCode, reason: TRANSFER_REASON }) : unknownCheck(p.reference, "provider has no payouts");
}, p.reference);

/**
 * Ask the provider about a submitted or unknown payout and apply the answer. "Not found" means the provider
 * may never have got it: after a long quiet period (resendAfterNotFoundSeconds) it's sent again with the same
 * reference (the provider's idempotency key), to the same account only if the person still has it, and any
 * refusal of that resend is unknown (onResend).
 */
export async function checkPayout(payoutId: string, via: "check" | "webhook", now = new Date(), claim: WebhookEvent | null = null): Promise<PayoutOutcome> {
  const [p] = await db.select().from(payouts).where(eq(payouts.id, payoutId));
  if (!p) return "unchanged";
  if (claim && claim.amountKobo !== null && claim.amountKobo !== p.sentKobo) {
    await adminAlert({ severity: "warning", kind: "payments.payout_webhook_amount_differs", subject: "A transfer webhook claims a different amount", dedupeKey: `payout_webhook_amount_differs:${p.id}`, refType: "payout", refId: p.id, details: { sentKobo: p.sentKobo, claim }, dedupeWindowSeconds: ONCE_PER_THING_SECONDS });
  }
  if (p.status !== "submitted" && p.status !== "unknown" && !isFinal(p)) return "unchanged";
  const check = await queryProvider(p);
  if (check.status !== "not_found" || isFinal(p)) return applyOutcome(payoutId, check, via, now);

  const cfg = await getPaymentsConfig();
  const quietFor = now.getTime() - (p.lastSentAt ?? p.createdAt).getTime();
  if (quietFor < cfg.checks.resendAfterNotFoundSeconds * 1000 || (await currentSettings()).payoutsPaused) return applyOutcome(payoutId, check, via, now);
  const [account] = await db.select().from(payoutAccounts).where(eq(payoutAccounts.id, p.payoutAccountId));
  if (!account || account.removedAt || account.userId !== p.userId) {
    // The person removed the account since the first send: never send there again. It stays unknown for an admin.
    await adminAlert({ severity: "warning", kind: "payments.payout_resend_account_removed", subject: "A payout wasn't resent: the recipient account was removed", dedupeKey: `payout_resend_account_removed:${p.id}`, refType: "payout", refId: p.id, details: { payoutAccountId: p.payoutAccountId, check }, dedupeWindowSeconds: ONCE_PER_THING_SECONDS });
    return applyOutcome(payoutId, unknownCheck(p.reference, "not resent: the recipient account was removed", "not_resent"), via, now);
  }
  const resend = await moneyTransaction(async (tx) => {
    const row = await lockPayout(tx, payoutId);
    if (isFinal(row) || row.lastSentAt?.getTime() !== p.lastSentAt?.getTime()) return false; // someone else moved it
    await tx.update(payouts).set({ sendAttempts: row.sendAttempts + 1, lastSentAt: now, updatedAt: now }).where(eq(payouts.id, p.id));
    return true;
  });
  if (!resend) return "unchanged";
  return applyOutcome(payoutId, onResend(await send(p, account)), "resend", now);
}

// ---- Admin approval ----

const notAwaiting = () => paymentsError(409, "not_awaiting_approval");

/** The person who owns a payout, locked first (the lock order), or a 404. */
async function lockOwner(tx: Tx, payoutId: string) {
  const [owner] = await tx.select({ userId: payouts.userId }).from(payouts).where(eq(payouts.id, payoutId));
  if (!owner) throw paymentsError(404, "not_found");
  await lockPerson(tx, owner.userId);
}

export async function approvePayout(adminUserId: string, payoutId: string, deps: PaymentsDeps) {
  const p = await moneyTransaction(async (tx) => {
    await lockOwner(tx, payoutId);
    const row = await lockPayout(tx, payoutId);
    if (!row) throw paymentsError(404, "not_found");
    if (row.userId === adminUserId) throw paymentsError(403, OWN_TRANSACTION);
    if (row.status !== "awaiting_approval") throw notAwaiting();
    const now = new Date();
    const [after] = await tx.update(payouts).set({ status: "requested", decidedByUserId: adminUserId, decidedAt: now, updatedAt: now }).where(eq(payouts.id, row.id)).returning();
    await recordAdminAction(tx, { adminUserId, action: "payments.payout_approve", targetType: "payout", targetId: row.id, before: { status: row.status, holdReason: row.holdReason }, after: { status: after.status } });
    return after;
  });
  await deps.enqueue({ kind: "payout_submit", payoutId: p.id }, { jobId: `payout-submit-${p.id}-approved` });
  return p;
}

export async function rejectPayout(adminUserId: string, payoutId: string, reason: string) {
  return moneyTransaction(async (tx) => {
    await lockOwner(tx, payoutId);
    const row = await lockPayout(tx, payoutId);
    if (!row) throw paymentsError(404, "not_found");
    if (row.userId === adminUserId) throw paymentsError(403, OWN_TRANSACTION);
    if (row.status !== "awaiting_approval") throw notAwaiting();
    const now = new Date();
    await tx.update(payouts).set({ decidedByUserId: adminUserId, decidedAt: now }).where(eq(payouts.id, row.id));
    await reverseLocked(tx, row, "rejected", "admin_reject", now);
    await recordAdminAction(tx, { adminUserId, action: "payments.payout_reject", targetType: "payout", targetId: row.id, reason, before: { status: row.status }, after: { status: "rejected" } });
    return (await tx.select().from(payouts).where(eq(payouts.id, row.id)))[0];
  });
}

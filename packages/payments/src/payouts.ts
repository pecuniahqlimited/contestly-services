/**
 * Withdrawals (ADR 0012): debit first, reverse only on a definite failure.
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
 */
import { randomUUID } from "node:crypto";
import { and, count, eq, gte, notInArray, sql } from "drizzle-orm";
import { db, getPaymentsConfig, ledger, payoutAccounts, payouts, recordAdminAction, users, withdrawBlockReason, type Payout, type PayoutAccount, type Tx, type User } from "@contestly/db";
import {
  ACCOUNT_UNRESOLVED, BELOW_MINIMUM, CURRENCY, LIMIT_REACHED, OWN_TRANSACTION, PAYMENTS_PAUSED, PAYOUT_FINAL_STATUSES, WITHDRAW_NOT_ALLOWED, type PayoutView,
} from "@contestly/shared";
import { backoffMs, lagosDayStart, paymentsError, raiseAlert, type PaymentsDeps } from "./common.js";
import { currentSettings } from "./settings.js";
import { providerNamed } from "./providers/index.js";
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

export interface WithdrawalRequest { amountKobo: number; bankAccountId: string; clientRequestId: string }

/**
 * Request a withdrawal. All checks and the debit in one transaction with the person's row locked, so two
 * requests at once can't overdraw or slip past a daily limit. A retry with the same clientRequestId returns
 * the first withdrawal.
 */
export async function requestPayout(user: User, req: WithdrawalRequest, deps: PaymentsDeps, now = new Date()): Promise<{ payout: Payout; replayed: boolean }> {
  const [settings, cfg] = await Promise.all([currentSettings(), getPaymentsConfig()]);
  if (settings.payoutsPaused) throw paymentsError(503, PAYMENTS_PAUSED, { what: "payouts" });
  const blocked = withdrawBlockReason(user);
  if (blocked) throw paymentsError(403, WITHDRAW_NOT_ALLOWED, { reason: blocked });
  if (req.amountKobo < cfg.payout.minKobo) throw paymentsError(422, BELOW_MINIMUM, { minKobo: cfg.payout.minKobo });
  if (req.amountKobo > cfg.payout.maxKobo) throw paymentsError(422, LIMIT_REACHED, { limit: "payout_max", maxKobo: cfg.payout.maxKobo });
  const provider = providerNamed(settings.payouts);
  if (!provider.payout) throw paymentsError(409, "provider_not_configured", { provider: provider.name });

  const out = await db.transaction(async (tx) => {
    const [fresh] = await tx.select().from(users).where(eq(users.id, user.id)).for("update");
    const [prior] = await tx.select().from(payouts).where(and(eq(payouts.userId, user.id), eq(payouts.clientRequestId, req.clientRequestId)));
    if (prior) return { payout: prior, replayed: true, hold: null as string | null, userHourCount: 0 };
    const blockedNow = withdrawBlockReason(fresh);
    if (blockedNow) throw paymentsError(403, WITHDRAW_NOT_ALLOWED, { reason: blockedNow });

    const [account] = await tx.select().from(payoutAccounts).where(and(eq(payoutAccounts.id, req.bankAccountId), eq(payoutAccounts.userId, user.id)));
    if (!account || account.removedAt || account.provider !== provider.name) throw paymentsError(409, ACCOUNT_UNRESOLVED);

    const live = and(eq(payouts.userId, user.id), notInArray(payouts.status, ["failed", "rejected"]));
    const [today] = await tx.select({ n: count(), total: sql<number>`coalesce(sum(${payouts.amountKobo}), 0)::bigint` }).from(payouts).where(and(live, gte(payouts.createdAt, lagosDayStart(now))));
    const [lastHour] = await tx.select({ n: count() }).from(payouts).where(and(eq(payouts.userId, user.id), gte(payouts.createdAt, new Date(now.getTime() - HOUR_MS))));
    if (Number(today.n) + 1 > cfg.payout.dailyCount) throw paymentsError(409, LIMIT_REACHED, { limit: "payout_daily_count", dailyCount: cfg.payout.dailyCount });
    const todayTotal = Number(today.total) + req.amountKobo;
    if (todayTotal > cfg.payout.dailyAmountKobo) throw paymentsError(409, LIMIT_REACHED, { limit: "payout_daily_amount", dailyAmountKobo: cfg.payout.dailyAmountKobo, usedKobo: Number(today.total) });

    const feeKobo = provider.payout!.transferFeeKobo(req.amountKobo);
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
  if (Number(all.n) > v.payoutsPerHour) await raiseAlert(db, { severity: "warning", kind: "payout_velocity", dedupeKey: `payout_velocity:${hour}`, detail: { lastHour: Number(all.n), threshold: v.payoutsPerHour } });
  if (userHourCount > v.userPayoutsPerHour) await raiseAlert(db, { severity: "warning", kind: "user_payout_velocity", dedupeKey: `user_payout_velocity:${p.userId}:${hour}`, refType: "user", refId: p.userId, detail: { lastHour: userHourCount, threshold: v.userPayoutsPerHour, payoutId: p.id } });
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
  const feeKobo = reportedFeeKobo ?? p.feeKobo;
  const platformPart = feeKobo - userPaidFee;
  if (platformPart !== 0) {
    await ledger.journal(tx, {
      type: "withdrawal_fee", refType: "payout", refId: p.id, idempotencyKey: `payout_fee:${p.id}`,
      legs: [{ account: { system: "payout_fees", scope: p.provider }, amountKobo: platformPart }, { account: { system: "platform_funds" }, amountKobo: -platformPart }],
    });
  }
  await tx.update(payouts).set({ status: "succeeded", feeKobo, finalVia: via, finalAt: now, nextCheckAt: null, updatedAt: now }).where(eq(payouts.id, p.id));
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

/** Apply a provider's answer to a payout, with its row locked. A webhook and a query racing make one transition. */
export async function applyOutcome(payoutId: string, check: ProviderCheck, via: string, now = new Date()): Promise<PayoutOutcome> {
  const cfg = await getPaymentsConfig();
  return db.transaction(async (tx) => {
    const p = await lockPayout(tx, payoutId);
    const record = checkRecord(check, via, now);
    if (isFinal(p)) {
      const contradicts = (p.status === "succeeded" && check.status === "failed") || (p.status !== "succeeded" && check.status === "success");
      if (contradicts) {
        // Never auto-fixed: money may already have gone both ways. An admin works it out with the provider.
        await raiseAlert(tx, { severity: "critical", kind: p.status === "succeeded" ? "payout_failed_after_success" : "payout_success_after_reversal", dedupeKey: `payout_contradiction:${p.id}:${check.status}`, refType: "payout", refId: p.id, detail: { status: p.status, check: record } });
      }
      return "unchanged";
    }
    if (p.status !== "submitted" && p.status !== "unknown") return "unchanged"; // not sent yet: nothing a provider says applies
    if (check.status === "success" && check.amountKobo !== null && check.amountKobo !== p.sentKobo) {
      await raiseAlert(tx, { severity: "critical", kind: "payout_amount_differs", dedupeKey: `payout_amount_differs:${p.id}`, refType: "payout", refId: p.id, detail: { sentKobo: p.sentKobo, check: record } });
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

async function markUnknown(tx: Tx, p: Payout, record: Record<string, unknown>, cfg: Awaited<ReturnType<typeof getPaymentsConfig>>, now: Date): Promise<PayoutOutcome> {
  const checks = p.checks + 1;
  await tx.update(payouts).set({ status: "unknown", lastCheck: record, checks, nextCheckAt: new Date(now.getTime() + backoffMs(checks, cfg.checks.payoutFirstCheckSeconds, cfg.checks.payoutMaxBackoffSeconds)), updatedAt: now }).where(eq(payouts.id, p.id));
  const since = p.submittedAt ?? p.createdAt;
  if (now.getTime() - since.getTime() > cfg.checks.unknownAlertAfterMinutes * 60_000) {
    await raiseAlert(tx, { severity: "critical", kind: "payout_unknown_too_long", dedupeKey: `payout_unknown_too_long:${p.id}`, refType: "payout", refId: p.id, detail: { since: since.toISOString(), checks, lastCheck: record } });
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
  const [[u], [account]] = await Promise.all([db.select().from(users).where(eq(users.id, p.userId)), db.select().from(payoutAccounts).where(eq(payoutAccounts.id, p.payoutAccountId))]);

  const go = await db.transaction(async (tx) => {
    const row = await lockPayout(tx, payoutId);
    if (row.status !== "requested") return false;
    const blocked = withdrawBlockReason(u);
    if (blocked) {
      await tx.update(payouts).set({ status: "awaiting_approval", holdReason: `blocked:${blocked}`, updatedAt: now }).where(eq(payouts.id, p.id));
      await raiseAlert(tx, { severity: "warning", kind: "payout_held_blocked", dedupeKey: `payout_held_blocked:${p.id}`, refType: "payout", refId: p.id, detail: { reason: blocked } });
      return false;
    }
    await tx.update(payouts).set({ status: "submitted", submittedAt: row.submittedAt ?? now, sendAttempts: row.sendAttempts + 1, lastSentAt: now, nextCheckAt: new Date(now.getTime() + 60_000), updatedAt: now }).where(eq(payouts.id, p.id));
    return true;
  });
  if (!go) return "unchanged";
  return applyOutcome(payoutId, await send(p, account), "send", now);
}

const send = (p: Payout, account: PayoutAccount) => ask(async () => {
  const provider = providerNamed(p.provider).payout;
  return provider ? provider.sendTransfer({ reference: p.reference, amountKobo: p.sentKobo, recipientCode: account.recipientCode, reason: TRANSFER_REASON }) : unknownCheck(p.reference, "provider has no payouts");
}, p.reference);

/**
 * Ask the provider about a submitted or unknown payout and apply the answer. "Not found" means the provider
 * never got it: after a quiet period it's sent again with the same reference (the provider's idempotency key).
 */
export async function checkPayout(payoutId: string, via: "check" | "webhook", now = new Date(), claim: WebhookEvent | null = null): Promise<PayoutOutcome> {
  const [p] = await db.select().from(payouts).where(eq(payouts.id, payoutId));
  if (!p) return "unchanged";
  if (claim && claim.amountKobo !== null && claim.amountKobo !== p.sentKobo) {
    await raiseAlert(db, { severity: "warning", kind: "payout_webhook_amount_differs", dedupeKey: `payout_webhook_amount_differs:${p.id}`, refType: "payout", refId: p.id, detail: { sentKobo: p.sentKobo, claim } });
  }
  if (p.status !== "submitted" && p.status !== "unknown" && !isFinal(p)) return "unchanged";
  const check = await queryProvider(p);
  if (check.status !== "not_found" || isFinal(p)) return applyOutcome(payoutId, check, via, now);

  const cfg = await getPaymentsConfig();
  const quietFor = now.getTime() - (p.lastSentAt ?? p.createdAt).getTime();
  if (quietFor < cfg.checks.resendAfterNotFoundSeconds * 1000 || (await currentSettings()).payoutsPaused) return applyOutcome(payoutId, check, via, now);
  const [account] = await db.select().from(payoutAccounts).where(eq(payoutAccounts.id, p.payoutAccountId));
  const resend = await db.transaction(async (tx) => {
    const row = await lockPayout(tx, payoutId);
    if (isFinal(row) || row.lastSentAt?.getTime() !== p.lastSentAt?.getTime()) return false; // someone else moved it
    await tx.update(payouts).set({ sendAttempts: row.sendAttempts + 1, lastSentAt: now, updatedAt: now }).where(eq(payouts.id, p.id));
    return true;
  });
  if (!resend) return "unchanged";
  return applyOutcome(payoutId, await send(p, account), "resend", now);
}

// ---- Admin approval ----

const notAwaiting = () => paymentsError(409, "not_awaiting_approval");

export async function approvePayout(adminUserId: string, payoutId: string, deps: PaymentsDeps) {
  const p = await db.transaction(async (tx) => {
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
  return db.transaction(async (tx) => {
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

/**
 * Payments (row 10, ADR 0013): top-ups in, withdrawals out, through pluggable providers. Everything the
 * app and the admin console see is in our own types and statuses; provider codes never leave a provider.
 */
import { z } from "zod";

export const CURRENCY = "NGN" as const;

/**
 * A top-up: pending until its provider confirms it server to server and a fresh verify agrees with our
 * record. succeeded is the only state that credited. mismatch waits for an admin. expired: nothing came in
 * by the cutoff (a late confirmation can still credit it through the same checks).
 */
export const TOPUP_STATUSES = ["pending", "succeeded", "failed", "mismatch", "expired"] as const;
export type TopupStatus = (typeof TOPUP_STATUSES)[number];

/**
 * A withdrawal. The user's cash is debited when it's requested, before any provider call.
 * awaiting_approval: over a threshold, an admin decides. requested: debited, waiting to be sent.
 * submitted: being sent (or sent, answer not in yet). unknown: the provider gave no definite answer; we
 * keep asking it. succeeded / failed / rejected are final; failed and rejected gave the money back.
 */
export const PAYOUT_STATUSES = ["awaiting_approval", "requested", "submitted", "unknown", "succeeded", "failed", "rejected"] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];
export const PAYOUT_FINAL_STATUSES: readonly PayoutStatus[] = ["succeeded", "failed", "rejected"];
/** Debited and not final: the money sits in payout_pending. */
export const PAYOUT_OPEN_STATUSES: readonly PayoutStatus[] = ["awaiting_approval", "requested", "submitted", "unknown"];

export const FEE_BEARERS = ["platform", "user"] as const;
export type FeeBearer = (typeof FEE_BEARERS)[number];

/** The admin's payment permissions. Dev admins have all four; otherwise each is granted per admin. */
export const PAYMENT_PERMISSIONS = ["payments.view", "payments.approve", "payments.finalize", "payments.config"] as const;
export type PaymentPermission = (typeof PAYMENT_PERMISSIONS)[number];

// Error codes the app and console handle.
export const INSUFFICIENT_FUNDS = "insufficient_funds";
export const WITHDRAW_NOT_ALLOWED = "withdraw_not_allowed";
export const BELOW_MINIMUM = "below_minimum";
export const LIMIT_REACHED = "limit_reached";
export const ACCOUNT_UNRESOLVED = "account_unresolved";
export const PAYMENTS_PAUSED = "payments_paused";
export const PROVIDER_UNAVAILABLE = "payment_provider_unavailable";
export const NAME_MISMATCH = "account_name_mismatch";
export const MISSING_PERMISSION = "missing_permission";
/** An admin acting on their own top-up or withdrawal. */
export const OWN_TRANSACTION = "own_transaction";
export const NOT_FINALIZABLE = "not_finalizable";

/** Why a withdrawal is refused (details.reason with withdraw_not_allowed). */
export const WITHDRAW_BLOCK_REASONS = ["guest", "email_unverified", "phone_unverified", "deleted", "frozen", "system"] as const;
export type WithdrawBlockReason = (typeof WITHDRAW_BLOCK_REASONS)[number];
/** Which limit was hit (details.limit with limit_reached). */
export const PAYMENT_LIMITS = ["topup_max", "topup_daily", "payout_max", "payout_daily_amount", "payout_daily_count"] as const;

const kobo = z.number().int().nonnegative();
const positiveKobo = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** Admin config (app_config "payments"): limits, thresholds and the requery clock. Providers and pauses are versioned separately. */
export const paymentsConfigSchema = z.object({
  topup: z.object({ minKobo: positiveKobo, maxKobo: positiveKobo, dailyCapKobo: positiveKobo }),
  payout: z.object({
    minKobo: positiveKobo,
    maxKobo: positiveKobo,
    dailyAmountKobo: positiveKobo,
    dailyCount: z.number().int().positive(),
    /** One withdrawal at or above this goes to an admin first. */
    approvalThresholdKobo: positiveKobo,
    /** A user's withdrawals today (this one included) above this go to an admin first. */
    userDailyApprovalCeilingKobo: positiveKobo,
    feeBearer: z.enum(FEE_BEARERS),
  }),
  /** A manual finalize at or above this needs a second admin to confirm it. */
  finalize: z.object({ secondAdminThresholdKobo: positiveKobo }),
  /** Alerts (and, per user, approval) above these. */
  velocity: z.object({ payoutsPerHour: z.number().int().positive(), userPayoutsPerHour: z.number().int().positive() }),
  checks: z.object({
    topupFirstCheckSeconds: z.number().int().positive(),
    /** After this a pending top-up gets a final verify and, if still nothing, expires. */
    topupCutoffMinutes: z.number().int().positive(),
    payoutFirstCheckSeconds: z.number().int().positive(),
    payoutMaxBackoffSeconds: z.number().int().positive(),
    /** An unknown payout older than this alerts admins; it keeps being checked and never resolves itself. */
    unknownAlertAfterMinutes: z.number().int().positive(),
    /** A transfer the provider says it never got is sent again (same reference) only after this long. */
    resendAfterNotFoundSeconds: z.number().int().positive(),
  }),
}).refine((c) => c.topup.minKobo <= c.topup.maxKobo && c.payout.minKobo <= c.payout.maxKobo, { message: "min must not exceed max" });
export type PaymentsConfig = z.infer<typeof paymentsConfigSchema>;

export const DEFAULT_PAYMENTS_CONFIG: PaymentsConfig = {
  topup: { minKobo: 10_000, maxKobo: 50_000_000, dailyCapKobo: 100_000_000 },
  payout: { minKobo: 100_000, maxKobo: 50_000_000, dailyAmountKobo: 50_000_000, dailyCount: 5, approvalThresholdKobo: 10_000_000, userDailyApprovalCeilingKobo: 20_000_000, feeBearer: "platform" },
  finalize: { secondAdminThresholdKobo: 5_000_000 },
  velocity: { payoutsPerHour: 500, userPayoutsPerHour: 3 },
  checks: { topupFirstCheckSeconds: 60, topupCutoffMinutes: 24 * 60, payoutFirstCheckSeconds: 30, payoutMaxBackoffSeconds: 3600, unknownAlertAfterMinutes: 24 * 60, resendAfterNotFoundSeconds: 300 },
};

// ---- The app ----

export const createTopupSchema = z.object({ amountKobo: positiveKobo });
export const topupSchema = z.object({
  reference: z.string(), amountKobo: kobo, currency: z.literal(CURRENCY), status: z.enum(TOPUP_STATUSES),
  /** Where to send the person to pay; null once it's no longer payable. */
  checkoutUrl: z.string().nullable(),
  createdAt: z.string(), creditedAt: z.string().nullable(),
});
export type TopupView = z.infer<typeof topupSchema>;

export const bankSchema = z.object({ code: z.string(), name: z.string() });
export const banksResponseSchema = z.object({ banks: z.array(bankSchema) });
export const resolveAccountSchema = z.object({ bankCode: z.string().min(1).max(20), accountNumber: z.string().regex(/^\d{10}$/, "a 10-digit account number") });
export const resolveAccountResponseSchema = z.object({
  bankCode: z.string(), bankName: z.string(), accountNumber: z.string(), accountName: z.string(),
  /** Send back with the name the person confirmed, to save the account (valid for 10 minutes). */
  resolveToken: z.string(),
});
export const addBankAccountSchema = z.object({ resolveToken: z.string().min(1), accountName: z.string().min(1) });
export const bankAccountSchema = z.object({
  id: z.string().uuid(), bankCode: z.string(), bankName: z.string(), accountNumberLast4: z.string(), accountName: z.string(),
  /** False when payouts moved to another provider: resolve the account again to use it. */
  usable: z.boolean(), createdAt: z.string(),
});
export const bankAccountsResponseSchema = z.object({ accounts: z.array(bankAccountSchema) });

export const withdrawalRequestSchema = z.object({
  amountKobo: positiveKobo, bankAccountId: z.string().uuid(),
  /** The app's id for this request: a retry or a double tap with the same id gets the same withdrawal. */
  clientRequestId: z.string().uuid(),
});
export const payoutSchema = z.object({
  id: z.string().uuid(), amountKobo: kobo,
  /** What reaches the bank (amount minus the fee when the user bears it). */
  sentKobo: kobo, feeKobo: kobo, feeBearer: z.enum(FEE_BEARERS),
  status: z.enum(PAYOUT_STATUSES),
  bankAccount: z.object({ bankName: z.string(), accountNumberLast4: z.string(), accountName: z.string() }),
  createdAt: z.string(), finalAt: z.string().nullable(),
});
export type PayoutView = z.infer<typeof payoutSchema>;
export const payoutsResponseSchema = z.object({ payouts: z.array(payoutSchema) });

// ---- The admin console ----

const reason = z.string().trim().min(3).max(500);
export const adminPaymentSettingsBodySchema = z.object({
  collections: z.string().min(1), payouts: z.string().min(1), topupsPaused: z.boolean(), payoutsPaused: z.boolean(), reason,
});
export const adminPaymentsConfigBodySchema = z.object({ config: paymentsConfigSchema, reason });
export const adminFinalizeBodySchema = z.object({ outcome: z.enum(["success", "failed"]), reason });
export const adminPaymentPermissionsBodySchema = z.object({ permissions: z.array(z.enum(PAYMENT_PERMISSIONS)), reason });
export const adminPaymentListQuerySchema = z.object({ status: z.string().optional(), userId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });

export const paymentSettingsSchema = z.object({
  version: z.number().int().nullable(), collections: z.string(), payouts: z.string(), topupsPaused: z.boolean(), payoutsPaused: z.boolean(),
  pausedBy: z.enum(["admin", "system"]).nullable(), reason: z.string().nullable(), updatedAt: z.string().nullable(),
});
export type PaymentSettingsView = z.infer<typeof paymentSettingsSchema>;
/** A provider's answer, in our terms, as an admin sees it before finalizing. */
export const providerCheckSchema = z.object({ status: z.string(), providerStatus: z.string(), amountKobo: z.number().nullable(), checkedAt: z.string(), error: z.string().nullable() });
export const adminFinalizeResponseSchema = z.object({
  finalization: z.object({
    id: z.string().uuid(), targetType: z.enum(["topup", "payout"]), targetId: z.string().uuid(), outcome: z.enum(["success", "failed"]),
    status: z.enum(["awaiting_second_admin", "applied", "superseded"]), requestedBy: z.string().uuid(), confirmedBy: z.string().uuid().nullable(),
    providerCheck: providerCheckSchema,
  }),
});

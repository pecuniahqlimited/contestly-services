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
/** 409: topping up sends the account's verified email to the provider; there isn't one. The app asks them to add one. */
export const EMAIL_REQUIRED = "email_required";
/** 422: the provider refused to start the payment (details.message says why). Nothing was charged. */
export const TOPUP_REFUSED = "topup_refused";
/** 409: a sent payout can't be finalized by hand inside the resend window or the quiet period after its last send. */
export const FINALIZE_TOO_SOON = "finalize_too_soon";
/** 409: a top-up is credited by hand only with an amount the provider verified as paid. */
export const NO_VERIFIED_AMOUNT = "no_verified_amount";
/** 403: the second admin of a maker-checker pair must be someone else. */
export const SECOND_ADMIN_REQUIRED = "second_admin_required";
/** 409: what the request was decided against has changed since (the provider's answer, the config): ask again. */
export const CHANGED_SINCE_REQUEST = "changed_since_request";

/** Why a manual finalize needs a second admin. */
export const SECOND_ADMIN_BECAUSE = ["over_threshold", "check_not_definite", "check_disagrees", "amount_differs"] as const;
export type SecondAdminBecause = (typeof SECOND_ADMIN_BECAUSE)[number];

/** Why a withdrawal is refused (details.reason with withdraw_not_allowed). */
export const WITHDRAW_BLOCK_REASONS = ["guest", "email_unverified", "phone_unverified", "deleted", "frozen", "payment_review", "amount_owed", "linked_payment_issue", "system"] as const;
export type WithdrawBlockReason = (typeof WITHDRAW_BLOCK_REASONS)[number];
/** Why a person owes: a payout we reversed was paid after all, and their cash didn't cover it. */
export const OWED_REASONS = ["duplicate_payout"] as const;
/**
 * What the wallet shows when something is owed. Every new cash credit repays it first; withdrawals wait
 * until it's clear; playing doesn't. The app: "₦X owed from a duplicate payout. Contact support if this looks wrong."
 */
export const owedSchema = z.object({ amountKobo: z.number().int().positive(), reason: z.enum(OWED_REASONS) });
export type Owed = z.infer<typeof owedSchema>;

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
  finalize: z.object({
    /** A manual finalize at or above this needs a second admin to confirm it (so does one the provider's answer doesn't back). */
    secondAdminThresholdKobo: positiveKobo,
    /** A sent payout can't be finalized by hand until this long after its last send (and never inside the resend window). */
    quietAfterSendMinutes: z.number().int().positive().default(30),
  }),
  /** Alerts (and, per user, approval) above these. */
  velocity: z.object({ payoutsPerHour: z.number().int().positive(), userPayoutsPerHour: z.number().int().positive() }),
  invariants: z.object({
    /** An acknowledged breach stops pausing payouts for this many days; after that it pauses again if it's still there. */
    acknowledgmentDays: z.number().int().positive(),
  }).default({ acknowledgmentDays: 7 }),
  webhooks: z.object({
    /** A stored webhook still unprocessed after this many attempts is dead-lettered, with an alert. */
    maxAttempts: z.number().int().positive(),
    /** Rejected webhooks in an hour at or above this alert (a wrong secret after a key rotation fails them all). */
    rejectionsAlertPerHour: z.number().int().positive(),
  }).default({ maxAttempts: 50, rejectionsAlertPerHour: 20 }),
  checks: z.object({
    topupFirstCheckSeconds: z.number().int().positive(),
    /** After this a pending top-up gets a final verify and, if still nothing, expires. */
    topupCutoffMinutes: z.number().int().positive(),
    payoutFirstCheckSeconds: z.number().int().positive(),
    payoutMaxBackoffSeconds: z.number().int().positive(),
    /** An unknown payout older than this alerts admins; it keeps being checked and never resolves itself. */
    unknownAlertAfterMinutes: z.number().int().positive(),
    /**
     * A transfer the provider says it never got is sent again (same reference) only after this long. Long on
     * purpose: a provider's lookup can lag its send, and every refusal of a resend is treated as unknown.
     */
    resendAfterNotFoundSeconds: z.number().int().positive(),
  }),
}).refine((c) => c.topup.minKobo <= c.topup.maxKobo && c.payout.minKobo <= c.payout.maxKobo, { message: "min must not exceed max" });
export type PaymentsConfig = z.infer<typeof paymentsConfigSchema>;

/**
 * Defaults. The minimum withdrawal is ₦1,000: Paystack charged ₦10 to send ₦100 in test (platform-paid by
 * default), so smaller withdrawals would cost the platform a tenth of what they move. ADR 0013.
 */
export const DEFAULT_PAYMENTS_CONFIG: PaymentsConfig = {
  topup: { minKobo: 10_000, maxKobo: 50_000_000, dailyCapKobo: 100_000_000 },
  payout: { minKobo: 100_000, maxKobo: 50_000_000, dailyAmountKobo: 50_000_000, dailyCount: 5, approvalThresholdKobo: 10_000_000, userDailyApprovalCeilingKobo: 20_000_000, feeBearer: "platform" },
  finalize: { secondAdminThresholdKobo: 5_000_000, quietAfterSendMinutes: 30 },
  velocity: { payoutsPerHour: 500, userPayoutsPerHour: 3 },
  invariants: { acknowledgmentDays: 7 },
  webhooks: { maxAttempts: 50, rejectionsAlertPerHour: 20 },
  checks: { topupFirstCheckSeconds: 60, topupCutoffMinutes: 24 * 60, payoutFirstCheckSeconds: 30, payoutMaxBackoffSeconds: 3600, unknownAlertAfterMinutes: 24 * 60, resendAfterNotFoundSeconds: 30 * 60 },
};

// ---- The app ----

export const createTopupSchema = z.object({ amountKobo: positiveKobo });

/** A transfer fee by amount: up to and including `upToKobo` (null: anything above the last tier). */
export const feeTierSchema = z.object({ upToKobo: positiveKobo.nullable(), feeKobo: kobo });
export type FeeTier = z.infer<typeof feeTierSchema>;
/** The fee for an amount from tiers in ascending order; the last tier has no upper bound. */
export function feeFromTiers(tiers: readonly FeeTier[], amountKobo: number): number {
  const tier = tiers.find((t) => t.upToKobo === null || amountKobo <= t.upToKobo);
  if (!tier) throw new Error("fee tiers must end with an open tier (upToKobo null)");
  return tier.feeKobo;
}

/** GET /wallet/limits?amountKobo=: what the person can top up and withdraw right now, and the transfer fee. */
export const walletLimitsQuerySchema = z.object({ amountKobo: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() });
export const walletLimitsSchema = z.object({
  topup: z.object({
    paused: z.boolean(),
    minKobo: kobo, maxKobo: kobo,
    /** Today's cap (Lagos day) and what's left of it: pending and credited top-ups count. */
    dailyCapKobo: kobo, remainingTodayKobo: kobo,
  }),
  withdrawal: z.object({
    paused: z.boolean(),
    minKobo: kobo, maxKobo: kobo,
    dailyAmountKobo: kobo, remainingAmountTodayKobo: kobo,
    dailyCount: z.number().int().nonnegative(), remainingCountToday: z.number().int().nonnegative(),
  }),
  fee: z.object({
    /** Who pays the transfer fee: the platform, or the person (it comes off what reaches the bank). */
    bearer: z.enum(FEE_BEARERS),
    /** The current payout provider's published fee tiers (empty when payouts aren't configured). */
    tiers: z.array(feeTierSchema),
    /** For ?amountKobo=: the estimated fee, and what reaches the bank. The real fee replaces it when the provider reports it. */
    estimate: z.object({ amountKobo: kobo, feeKobo: kobo, sentKobo: z.number().int() }).nullable(),
  }),
});
export type WalletLimits = z.infer<typeof walletLimitsSchema>;
export const topupSchema = z.object({
  reference: z.string(), amountKobo: kobo, currency: z.literal(CURRENCY), status: z.enum(TOPUP_STATUSES),
  /** Where to send the person to pay; null once it's no longer payable. */
  checkoutUrl: z.string().nullable(),
  /** The last attempt was declined; the checkout is still open, so the app can say "try again or another card". */
  attemptFailed: z.boolean(),
  createdAt: z.string(), creditedAt: z.string().nullable(),
  /** What reached the wallet, once credited: the amount the provider verified (an admin may credit a verified amount that differs). */
  creditedKobo: kobo.nullable(),
});
export type TopupView = z.infer<typeof topupSchema>;
export const topupsResponseSchema = z.object({ topups: z.array(topupSchema) });

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
    /** What it applies (a top-up: the amount the provider verified). */
    amountKobo: z.number().int().nullable(),
    /** The provider's answer when it was asked for, and why a second admin must confirm (both admins see it). */
    providerCheck: providerCheckSchema,
    secondAdminBecause: z.array(z.enum(SECOND_ADMIN_BECAUSE)),
    /** The provider's answer when the second admin confirmed. */
    confirmCheck: providerCheckSchema.nullable(),
  }),
});

/** A loosening change to payments config or settings, waiting for (or confirmed by) a second admin. */
export const paymentConfigChangeSchema = z.object({
  id: z.string().uuid(), kind: z.enum(["config", "settings"]), loosens: z.array(z.string()), reason: z.string(),
  status: z.enum(["awaiting_second_admin", "applied", "superseded"]), requestedBy: z.string().uuid(), confirmedBy: z.string().uuid().nullable(),
  before: z.unknown(), proposed: z.unknown(), createdAt: z.string(),
});
export type PaymentConfigChangeView = z.infer<typeof paymentConfigChangeSchema>;

/** An invariant breach admins acknowledged: the same kind on the same items, no larger, doesn't pause payouts again. */
export const invariantAcknowledgmentSchema = z.object({
  id: z.string().uuid(), kind: z.string(), items: z.record(z.number()), detail: z.unknown(), reason: z.string(),
  status: z.enum(["awaiting_second_admin", "applied"]), requestedBy: z.string().uuid(), confirmedBy: z.string().uuid().nullable(),
  createdAt: z.string(), appliedAt: z.string().nullable(),
});
export const acknowledgeBreachBodySchema = z.object({ kind: z.string().min(1).max(100), reason: z.string().trim().min(3).max(500) });

/** A grant of payments permissions (or a revoke of payments.config from one of the last two holders) waiting for (or confirmed by) a second payments.config holder. */
export const permissionGrantSchema = z.object({
  id: z.string().uuid(), userId: z.string().uuid(), change: z.enum(["grant", "revoke"]), permissions: z.array(z.enum(PAYMENT_PERMISSIONS)), reason: z.string(),
  status: z.enum(["awaiting_second_admin", "applied", "superseded"]), requestedBy: z.string().uuid(), confirmedBy: z.string().uuid().nullable(),
  createdAt: z.string(), appliedAt: z.string().nullable(),
});

/** Waiving what someone owes: payments.finalize, a second admin, a reason. */
export const owedWaiverSchema = z.object({
  id: z.string().uuid(), userId: z.string().uuid(), amountKobo: z.number().int(), reason: z.string(),
  status: z.enum(["awaiting_second_admin", "applied", "superseded"]), requestedBy: z.string().uuid(), confirmedBy: z.string().uuid().nullable(),
  /** What was actually waived (no more than is owed when confirmed). */
  waivedKobo: z.number().int().nullable(), createdAt: z.string(), appliedAt: z.string().nullable(),
});
export const owedListSchema = z.object({ owed: z.array(z.object({ userId: z.string().uuid(), handle: z.string(), amountKobo: z.number().int() })) });

/** A reversed payout the provider says was paid, and how it was resolved. */
export const payoutContradictionSchema = z.object({
  id: z.string().uuid(), payoutId: z.string().uuid(), userId: z.string().uuid(), amountKobo: z.number().int(),
  status: z.enum(["open", "awaiting_second_admin", "resolved", "dissolved"]), providerCheck: z.unknown(),
  requestedBy: z.string().uuid().nullable(), requestReason: z.string().nullable(), confirmedBy: z.string().uuid().nullable(),
  recoveredKobo: z.number().int().nullable(), owedKobo: z.number().int().nullable(), createdAt: z.string(), resolvedAt: z.string().nullable(),
  /** In lists: where the disputed amount came from and where its debt stands. */
  debt: z.object({ heldFromCashKobo: z.number().int(), owedKobo: z.number().int(), repaidKobo: z.number().int(), waivedKobo: z.number().int(), outstandingKobo: z.number().int() }).optional(),
});

// ---------------------------------------------------------------- waiting for a second admin

/** Every kind of two-admin request (ADR 0013). */
export const PENDING_REQUEST_KINDS = [
  "finalization", "owed_waiver", "contradiction_resolution", "permission_grant", "config_change", "admin_ban", "linked_issue_clearance", "invariant_acknowledgment",
] as const;
export type PendingRequestKind = (typeof PENDING_REQUEST_KINDS)[number];

export const adminPendingQuerySchema = z.object({ kind: z.enum(PENDING_REQUEST_KINDS).optional() });
export const adminPendingItemSchema = z.object({
  kind: z.enum(PENDING_REQUEST_KINDS),
  /** The request's id (what its confirm route takes). */
  id: z.string().uuid(),
  requestedBy: z.object({ id: z.string().uuid(), handle: z.string() }),
  reason: z.string(),
  requestedAt: z.string(),
  /** What it acts on: a payout, a top-up, a user, the payments config or settings, an invariant kind. */
  target: z.object({ type: z.enum(["payout", "topup", "user", "config", "settings", "invariant"]), id: z.string() }),
  /** Where a second admin confirms it. */
  confirm: z.object({ method: z.literal("POST"), path: z.string() }),
  /** What confirming takes (null: any admin). */
  permission: z.enum(PAYMENT_PERMISSIONS).nullable(),
});
export type AdminPendingItem = z.infer<typeof adminPendingItemSchema>;
/** GET /admin/payments/pending: oldest first; only what the viewer could confirm, never what they asked for themselves. */
export const adminPendingResponseSchema = z.object({ pending: z.array(adminPendingItemSchema) });

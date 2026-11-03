/**
 * Top-ups (ADR 0013). Our server makes the reference and the pending row before the provider is asked. The
 * wallet is credited only by confirmTopup(): a fresh server-to-server verify with the provider that created
 * it, matching our row exactly (reference, amount, currency, user) and, when a webhook triggered it, the
 * webhook too. That verify is the provider's confirmation, whether a webhook, the worker's scheduled check
 * or an admin's replay asked for it; the app's polling only reads our row and never credits. The credit
 * happens with the row locked, under ledger key topup:<provider>:<reference>, so however many webhooks,
 * checks or admin replays arrive, at most one credits.
 *
 * A failed attempt isn't final: the checkout stays payable (another card, another channel), so the top-up
 * stays pending, marked attempt_failed, until its cutoff, and the check at the cutoff is the final one.
 */
import { randomBytes } from "node:crypto";
import { and, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { db, moneyTransaction, getPaymentsConfig, ledger, topups, users, type Topup, type Tx, type User } from "@contestly/db";
import { BELOW_MINIMUM, CURRENCY, EMAIL_REQUIRED, LIMIT_REACHED, PAYMENTS_PAUSED, PROVIDER_UNAVAILABLE, SIGN_UP_REQUIRED, TOPUP_REFUSED, type TopupView } from "@contestly/shared";
import { backoffMs, lagosDayStart, paymentsError, raiseAlert } from "./common.js";
import { currentSettings } from "./settings.js";
import { providerNamed } from "./providers/index.js";
import { ProviderRefusal, unknownCheck, type ProviderCheck, type WebhookEvent } from "./types.js";

/** Paystack allows letters, digits, "-", "." and "=" in a reference; ours is tp- and 24 hex digits. */
const newReference = () => `tp-${randomBytes(12).toString("hex")}`;

export const topupView = (t: Topup): TopupView => ({
  reference: t.reference, amountKobo: t.amountKobo, currency: CURRENCY, status: t.status,
  checkoutUrl: t.status === "pending" ? t.checkoutUrl : null, attemptFailed: t.status === "pending" && !!t.attemptFailedAt, createdAt: t.createdAt.toISOString(), creditedAt: t.creditedAt?.toISOString() ?? null,
});

export interface CreateTopupOptions { returnUrl: string | null; now?: Date }

/**
 * Who can top up: a signed-up, live account (else sign_up_required) with a verified email, which is what the
 * provider is sent (else email_required, so the app can ask them to add one). Never a placeholder address.
 */
export function topupEmail(user: Pick<User, "isGuest" | "isSystem" | "deletedAt" | "email" | "emailVerifiedAt">): string {
  if (user.isGuest || user.isSystem || user.deletedAt) throw paymentsError(403, SIGN_UP_REQUIRED);
  if (!user.email || !user.emailVerifiedAt) throw paymentsError(409, EMAIL_REQUIRED);
  return user.email;
}

/** A top-up still pending with no checkout after this long never reached the person (a crash mid-start): it's failed by the sweep. */
export const START_GRACE_MS = 5 * 60_000;

/**
 * Start a top-up: limits, the pending row (committed first), then the provider's checkout. The row is only
 * scheduled for checks once a checkout exists; if the provider refuses (or doesn't answer), no money can
 * have moved, so the row is failed at once with the reason and nothing keeps verifying it.
 */
export async function createTopup(user: User, amountKobo: number, opts: CreateTopupOptions): Promise<Topup> {
  const email = topupEmail(user);
  const now = opts.now ?? new Date();
  const [settings, cfg] = await Promise.all([currentSettings(), getPaymentsConfig()]);
  if (settings.topupsPaused) throw paymentsError(503, PAYMENTS_PAUSED, { what: "topups" });
  if (amountKobo < cfg.topup.minKobo) throw paymentsError(422, BELOW_MINIMUM, { minKobo: cfg.topup.minKobo });
  if (amountKobo > cfg.topup.maxKobo) throw paymentsError(422, LIMIT_REACHED, { limit: "topup_max", maxKobo: cfg.topup.maxKobo });
  const provider = providerNamed(settings.collections);
  if (!provider.collection) throw paymentsError(409, "provider_not_configured", { provider: provider.name });

  const row = await moneyTransaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, user.id)).for("no key update"); // one top-up start at a time per person (the daily cap holds), without blocking FK checks
    const [{ total }] = await tx.select({ total: sql<number>`coalesce(sum(${topups.amountKobo}), 0)::bigint` }).from(topups)
      .where(and(eq(topups.userId, user.id), gte(topups.createdAt, lagosDayStart(now)), inArray(topups.status, ["pending", "succeeded"])));
    if (Number(total) + amountKobo > cfg.topup.dailyCapKobo) throw paymentsError(409, LIMIT_REACHED, { limit: "topup_daily", dailyCapKobo: cfg.topup.dailyCapKobo, usedKobo: Number(total) });
    const [t] = await tx.insert(topups).values({
      userId: user.id, amountKobo, currency: CURRENCY, provider: provider.name, reference: newReference(), status: "pending",
      nextCheckAt: null, createdAt: now, updatedAt: now,
    }).returning();
    return t;
  });

  let checkoutUrl: string;
  try {
    ({ checkoutUrl } = await provider.collection.createTopup({ reference: row.reference, amountKobo, currency: CURRENCY, userId: user.id, email, returnUrl: opts.returnUrl }));
  } catch (e) {
    // No checkout reached the person, so nothing can have been paid. Failed now; reconciliation would still see a stray payment.
    const refused = e instanceof ProviderRefusal;
    await db.update(topups).set({ status: "failed", nextCheckAt: null, problem: { stage: "start", refused, httpStatus: refused ? e.httpStatus : null, message: (e as Error).message }, updatedAt: new Date() }).where(eq(topups.id, row.id));
    if (refused) throw paymentsError(422, TOPUP_REFUSED, { message: e.message, reference: row.reference });
    throw Object.assign(paymentsError(502, PROVIDER_UNAVAILABLE, { reference: row.reference }), { cause: e });
  }
  const [t] = await db.update(topups).set({ checkoutUrl, nextCheckAt: new Date(Date.now() + cfg.checks.topupFirstCheckSeconds * 1000), updatedAt: new Date() }).where(eq(topups.id, row.id)).returning();
  return t;
}

/** Top-ups whose start never finished (no checkout after START_GRACE_MS): failed, since nobody could have paid. */
export async function failUnstartedTopups(now = new Date()) {
  const gone = await db.update(topups).set({ status: "failed", problem: { stage: "start", message: "no checkout was created" }, updatedAt: now })
    .where(and(eq(topups.status, "pending"), isNull(topups.checkoutUrl), lt(topups.createdAt, new Date(now.getTime() - START_GRACE_MS)))).returning({ id: topups.id });
  return gone.length;
}

/** The app polls this after checkout: our record only; it never asks the provider and never credits. */
export async function topupForUser(userId: string, reference: string): Promise<Topup | null> {
  const [t] = await db.select().from(topups).where(and(eq(topups.reference, reference), eq(topups.userId, userId)));
  return t ?? null;
}

export type ConfirmVia = "webhook" | "check" | "admin_verify";

/** A fresh verify with the provider that created the top-up. Never throws. */
export async function verifyWithProvider(t: Topup): Promise<ProviderCheck> {
  try {
    const p = providerNamed(t.provider);
    if (!p.collection) return unknownCheck(t.reference, "provider has no collections");
    return await p.collection.verifyTopup(t.reference);
  } catch (e) {
    return unknownCheck(t.reference, (e as Error).message);
  }
}

/** What disagrees between a successful verify (and the webhook, if one triggered it) and our row. Empty: it all matches. */
export function topupProblems(t: Topup, check: ProviderCheck, claim?: WebhookEvent | null): string[] {
  const problems: string[] = [];
  if (check.reference !== t.reference) problems.push(`verify reference ${check.reference}`);
  if (check.amountKobo !== t.amountKobo) problems.push(`verify amount ${check.amountKobo}`);
  if (check.currency !== t.currency) problems.push(`verify currency ${check.currency}`);
  if (check.userId !== t.userId) problems.push(`verify user ${check.userId}`);
  if (claim) {
    if (claim.reference !== t.reference) problems.push(`webhook reference ${claim.reference}`);
    if (claim.amountKobo !== t.amountKobo) problems.push(`webhook amount ${claim.amountKobo}`);
    if (claim.currency !== t.currency) problems.push(`webhook currency ${claim.currency}`);
    if (claim.userId !== null && claim.userId !== t.userId) problems.push(`webhook user ${claim.userId}`);
  }
  return problems;
}

const checkRecord = (c: ProviderCheck, via: string, at: Date) => ({ ...c, via, at: at.toISOString() });

/**
 * Credit a locked top-up once (ledger key topup:<provider>:<reference>) and mark it succeeded. The amount is
 * what the provider verified as paid: our own amount on the automatic path (it must match), and on an admin's
 * finalize the verified amount even when it differs (which needed a second admin).
 */
export async function creditLocked(tx: Tx, t: Topup, via: string, now: Date, verifiedKobo: number = t.amountKobo) {
  await ledger.journal(tx, {
    type: "topup", refType: "topup", refId: t.id, idempotencyKey: `topup:${t.provider}:${t.reference}`,
    legs: [{ account: { userId: t.userId, kind: "cash" }, amountKobo: verifiedKobo }, { account: { system: "topup_in", scope: t.provider }, amountKobo: -verifiedKobo }],
  });
  await tx.update(topups).set({ status: "succeeded", creditedKobo: verifiedKobo, creditedAt: now, creditedVia: via, nextCheckAt: null, updatedAt: now }).where(eq(topups.id, t.id));
}

export async function failLocked(tx: Tx, t: Topup, problem: Record<string, unknown>, now: Date) {
  await tx.update(topups).set({ status: "failed", problem, nextCheckAt: null, updatedAt: now }).where(eq(topups.id, t.id));
}

export type ConfirmOutcome = "credited" | "already_credited" | "mismatch" | "failed" | "still_pending" | "expired" | "held_for_admin";

/**
 * The one way a top-up is credited by the system: verify fresh with its provider, then, with the row locked,
 * credit only a matching success. Safe to call any number of times, from anywhere, concurrently.
 */
export async function confirmTopup(topupId: string, via: ConfirmVia, claim: WebhookEvent | null = null, now = new Date()): Promise<ConfirmOutcome> {
  const [before] = await db.select().from(topups).where(eq(topups.id, topupId));
  if (!before) throw paymentsError(404, "not_found");
  if (before.status === "succeeded") return "already_credited";
  const check = await verifyWithProvider(before);
  const cfg = await getPaymentsConfig();

  return moneyTransaction(async (tx) => {
    const [t] = await tx.select().from(topups).where(eq(topups.id, topupId)).for("update");
    const record = checkRecord(check, via, now);
    if (t.status === "succeeded") return "already_credited";
    if (t.status === "mismatch") {
      await tx.update(topups).set({ lastCheck: record, updatedAt: now }).where(eq(topups.id, t.id));
      return "held_for_admin";
    }
    if (t.status === "failed") {
      if (check.status === "success") {
        // We called it failed and the provider now says paid: never auto-credited; an admin looks.
        await tx.update(topups).set({ status: "mismatch", problem: { reason: "success_after_failed", check: record }, lastCheck: record, updatedAt: now }).where(eq(topups.id, t.id));
        await raiseAlert(tx, { severity: "critical", kind: "topup_success_after_failed", dedupeKey: `topup_success_after_failed:${t.id}`, refType: "topup", refId: t.id, detail: { reference: t.reference, check: record } });
        return "mismatch";
      }
      return "failed";
    }
    // pending or expired: a late success still credits through the same checks.
    if (check.status === "success") {
      const problems = topupProblems(t, check, claim);
      if (problems.length) {
        await tx.update(topups).set({ status: "mismatch", problem: { problems, check: record, claim }, lastCheck: record, nextCheckAt: null, updatedAt: now }).where(eq(topups.id, t.id));
        await raiseAlert(tx, { severity: "critical", kind: "topup_mismatch", dedupeKey: `topup_mismatch:${t.id}`, refType: "topup", refId: t.id, detail: { reference: t.reference, problems } });
        return "mismatch";
      }
      await tx.update(topups).set({ lastCheck: record }).where(eq(topups.id, t.id));
      await creditLocked(tx, t, via, now);
      return "credited";
    }
    const cutoff = new Date(t.createdAt.getTime() + cfg.checks.topupCutoffMinutes * 60_000);
    const next = new Date(Math.min(now.getTime() + backoffMs(t.checks + 1, cfg.checks.topupFirstCheckSeconds, 3600), cutoff.getTime()));
    if (check.status === "failed") {
      // A declined attempt: the person can still pay on the same checkout until it expires. Final only at the cutoff.
      if (t.status === "pending" && now < cutoff) {
        await tx.update(topups).set({ attemptFailedAt: now, lastCheck: record, checks: t.checks + 1, nextCheckAt: next, updatedAt: now }).where(eq(topups.id, t.id));
        return "still_pending";
      }
      await failLocked(tx, t, { reason: "provider_failed", check: record }, now);
      return "failed";
    }
    // pending, not_found, unknown: keep checking until the cutoff; the check at the cutoff is the final one.
    if (t.status === "pending" && now >= cutoff) {
      await tx.update(topups).set({ status: "expired", lastCheck: record, checks: t.checks + 1, nextCheckAt: null, updatedAt: now }).where(eq(topups.id, t.id));
      return "expired";
    }
    await tx.update(topups).set({ lastCheck: record, checks: t.checks + 1, nextCheckAt: t.status === "pending" ? next : null, updatedAt: now }).where(eq(topups.id, t.id));
    return t.status === "expired" ? "expired" : "still_pending";
  });
}

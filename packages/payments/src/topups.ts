/**
 * Top-ups (ADR 0012). Our server makes the reference and the pending row before the provider is asked. The
 * wallet is credited only by confirmTopup(): a fresh verify with the provider that created it, matching our
 * row exactly (reference, amount, currency, user) and, when a webhook triggered it, the webhook too. The
 * credit happens with the row locked, under ledger key topup:<provider>:<reference>, so however many
 * webhooks, checks or admin replays arrive, at most one credits.
 */
import { randomBytes } from "node:crypto";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db, getPaymentsConfig, ledger, topups, users, type Topup, type Tx, type User } from "@contestly/db";
import { BELOW_MINIMUM, CURRENCY, LIMIT_REACHED, PAYMENTS_PAUSED, PROVIDER_UNAVAILABLE, SIGN_UP_REQUIRED, type TopupView } from "@contestly/shared";
import { canBePaidCash } from "@contestly/db";
import { backoffMs, lagosDayStart, paymentsError, raiseAlert } from "./common.js";
import { currentSettings } from "./settings.js";
import { providerNamed } from "./providers/index.js";
import { unknownCheck, type ProviderCheck, type WebhookEvent } from "./types.js";

/** Paystack allows letters, digits, "-", "." and "=" in a reference; ours is tp- and 24 hex digits. */
const newReference = () => `tp-${randomBytes(12).toString("hex")}`;

export const topupView = (t: Topup): TopupView => ({
  reference: t.reference, amountKobo: t.amountKobo, currency: CURRENCY, status: t.status,
  checkoutUrl: t.status === "pending" ? t.checkoutUrl : null, createdAt: t.createdAt.toISOString(), creditedAt: t.creditedAt?.toISOString() ?? null,
});

export interface CreateTopupOptions { returnUrl: string | null; now?: Date }

/** Start a top-up: limits, the pending row (committed first), then the provider's checkout. */
export async function createTopup(user: User, amountKobo: number, opts: CreateTopupOptions): Promise<Topup> {
  if (!canBePaidCash(user) || !user.email) throw paymentsError(403, SIGN_UP_REQUIRED);
  const now = opts.now ?? new Date();
  const [settings, cfg] = await Promise.all([currentSettings(), getPaymentsConfig()]);
  if (settings.topupsPaused) throw paymentsError(503, PAYMENTS_PAUSED, { what: "topups" });
  if (amountKobo < cfg.topup.minKobo) throw paymentsError(422, BELOW_MINIMUM, { minKobo: cfg.topup.minKobo });
  if (amountKobo > cfg.topup.maxKobo) throw paymentsError(422, LIMIT_REACHED, { limit: "topup_max", maxKobo: cfg.topup.maxKobo });
  const provider = providerNamed(settings.collections);
  if (!provider.collection) throw paymentsError(409, "provider_not_configured", { provider: provider.name });

  const row = await db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, user.id)).for("update"); // one top-up start at a time per person: the daily cap holds
    const [{ total }] = await tx.select({ total: sql<number>`coalesce(sum(${topups.amountKobo}), 0)::bigint` }).from(topups)
      .where(and(eq(topups.userId, user.id), gte(topups.createdAt, lagosDayStart(now)), inArray(topups.status, ["pending", "succeeded"])));
    if (Number(total) + amountKobo > cfg.topup.dailyCapKobo) throw paymentsError(409, LIMIT_REACHED, { limit: "topup_daily", dailyCapKobo: cfg.topup.dailyCapKobo, usedKobo: Number(total) });
    const [t] = await tx.insert(topups).values({
      userId: user.id, amountKobo, currency: CURRENCY, provider: provider.name, reference: newReference(), status: "pending",
      nextCheckAt: new Date(now.getTime() + cfg.checks.topupFirstCheckSeconds * 1000), createdAt: now, updatedAt: now,
    }).returning();
    return t;
  });

  try {
    const { checkoutUrl } = await provider.collection.createTopup({ reference: row.reference, amountKobo, currency: CURRENCY, userId: user.id, email: user.email, returnUrl: opts.returnUrl });
    const [t] = await db.update(topups).set({ checkoutUrl, updatedAt: new Date() }).where(eq(topups.id, row.id)).returning();
    return t;
  } catch (e) {
    // The person never got a checkout, so nothing can have been paid. Marked failed; reconciliation would still see a stray payment.
    await db.update(topups).set({ status: "failed", nextCheckAt: null, problem: { stage: "start", error: (e as Error).message }, updatedAt: new Date() }).where(eq(topups.id, row.id));
    throw paymentsError(502, PROVIDER_UNAVAILABLE);
  }
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

/** Credit a locked top-up once (ledger key topup:<provider>:<reference>) and mark it succeeded. */
export async function creditLocked(tx: Tx, t: Topup, via: string, now: Date) {
  await ledger.journal(tx, {
    type: "topup", refType: "topup", refId: t.id, idempotencyKey: `topup:${t.provider}:${t.reference}`,
    legs: [{ account: { userId: t.userId, kind: "cash" }, amountKobo: t.amountKobo }, { account: { system: "topup_in", scope: t.provider }, amountKobo: -t.amountKobo }],
  });
  await tx.update(topups).set({ status: "succeeded", creditedAt: now, creditedVia: via, nextCheckAt: null, updatedAt: now }).where(eq(topups.id, t.id));
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

  return db.transaction(async (tx) => {
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
    if (check.status === "failed") {
      await failLocked(tx, t, { reason: "provider_failed", check: record }, now);
      return "failed";
    }
    // pending, not_found, unknown: keep checking until the cutoff; the check at the cutoff is the final one.
    const cutoff = new Date(t.createdAt.getTime() + cfg.checks.topupCutoffMinutes * 60_000);
    if (t.status === "pending" && now >= cutoff) {
      await tx.update(topups).set({ status: "expired", lastCheck: record, checks: t.checks + 1, nextCheckAt: null, updatedAt: now }).where(eq(topups.id, t.id));
      return "expired";
    }
    const next = new Date(Math.min(now.getTime() + backoffMs(t.checks + 1, cfg.checks.topupFirstCheckSeconds, 3600), cutoff.getTime()));
    await tx.update(topups).set({ lastCheck: record, checks: t.checks + 1, nextCheckAt: t.status === "pending" ? next : null, updatedAt: now }).where(eq(topups.id, t.id));
    return t.status === "expired" ? "expired" : "still_pending";
  });
}

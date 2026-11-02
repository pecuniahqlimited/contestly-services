/** What the admin console reads about payments, and its small writes (each logged). */
import { and, count, desc, eq, isNull, type SQL } from "drizzle-orm";
import {
  db, getPaymentsConfig, paymentAlerts, paymentFinalizations, paymentReconItems, paymentReconRuns, paymentWebhookEvents, payoutAccounts, payouts, recordAdminAction, topups,
} from "@contestly/db";
import { paymentsError } from "./common.js";
import { configuredProviderNames, knownProviderNames } from "./providers/index.js";
import { currentSettings } from "./settings.js";
import { confirmTopup } from "./topups.js";
import { listAcknowledgments } from "./invariants.js";

const iso = (d: Date | null) => d?.toISOString() ?? null;

export async function paymentsOverview() {
  const [settings, config, topupCounts, payoutCounts, [alerts], acknowledged] = await Promise.all([
    currentSettings(), getPaymentsConfig(),
    db.select({ status: topups.status, n: count() }).from(topups).groupBy(topups.status),
    db.select({ status: payouts.status, n: count() }).from(payouts).groupBy(payouts.status),
    db.select({ n: count() }).from(paymentAlerts).where(isNull(paymentAlerts.acknowledgedAt)),
    listAcknowledgments(50),
  ]);
  return {
    settings, config, providers: { known: knownProviderNames(), configured: configuredProviderNames() },
    topups: Object.fromEntries(topupCounts.map((r) => [r.status, Number(r.n)])),
    payouts: Object.fromEntries(payoutCounts.map((r) => [r.status, Number(r.n)])),
    openAlerts: Number(alerts.n),
    /** Breaches admins acknowledged (and ones waiting for a second admin): shown on the payments page. */
    acknowledgedBreaches: acknowledged,
  };
}

export interface ListQuery { status?: string; userId?: string; limit: number }

export async function listTopups(q: ListQuery) {
  const where: SQL[] = [];
  if (q.status) where.push(eq(topups.status, q.status as never));
  if (q.userId) where.push(eq(topups.userId, q.userId));
  const rows = await db.select().from(topups).where(where.length ? and(...where) : undefined).orderBy(desc(topups.createdAt)).limit(q.limit);
  return rows.map((t) => ({
    id: t.id, userId: t.userId, reference: t.reference, provider: t.provider, amountKobo: t.amountKobo, currency: t.currency, status: t.status,
    checks: t.checks, lastCheck: t.lastCheck, problem: t.problem, creditedVia: t.creditedVia, createdAt: t.createdAt.toISOString(), creditedAt: iso(t.creditedAt), nextCheckAt: iso(t.nextCheckAt),
  }));
}

export async function listPayouts(q: ListQuery) {
  const where: SQL[] = [];
  if (q.status) where.push(eq(payouts.status, q.status as never));
  if (q.userId) where.push(eq(payouts.userId, q.userId));
  const rows = await db.select({ p: payouts, a: payoutAccounts }).from(payouts).innerJoin(payoutAccounts, eq(payoutAccounts.id, payouts.payoutAccountId))
    .where(where.length ? and(...where) : undefined).orderBy(desc(payouts.createdAt)).limit(q.limit);
  return rows.map(({ p, a }) => ({
    id: p.id, userId: p.userId, reference: p.reference, provider: p.provider, amountKobo: p.amountKobo, sentKobo: p.sentKobo, feeKobo: p.feeKobo, feeBearer: p.feeBearer,
    status: p.status, holdReason: p.holdReason, sendAttempts: p.sendAttempts, checks: p.checks, lastCheck: p.lastCheck, finalVia: p.finalVia,
    bankAccount: { bankName: a.bankName, accountNumber: a.accountNumber, accountName: a.accountName },
    createdAt: p.createdAt.toISOString(), submittedAt: iso(p.submittedAt), finalAt: iso(p.finalAt), nextCheckAt: iso(p.nextCheckAt),
  }));
}

export async function listWebhooks(limit: number) {
  const rows = await db.select().from(paymentWebhookEvents).orderBy(desc(paymentWebhookEvents.receivedAt)).limit(limit);
  return rows.map((w) => ({
    id: w.id, provider: w.provider, eventId: w.eventId, type: w.type, reference: w.reference, deliveries: w.deliveries, receivedAt: w.receivedAt.toISOString(),
    processedAt: iso(w.processedAt), outcome: w.outcome, attempts: w.attempts, deadLetteredAt: iso(w.deadLetteredAt), body: w.body,
  }));
}

export async function listAlerts(open: boolean, limit: number) {
  const rows = await db.select().from(paymentAlerts).where(open ? isNull(paymentAlerts.acknowledgedAt) : undefined).orderBy(desc(paymentAlerts.createdAt)).limit(limit);
  return rows.map((a) => ({ id: a.id, severity: a.severity, kind: a.kind, refType: a.refType, refId: a.refId, detail: a.detail, createdAt: a.createdAt.toISOString(), acknowledgedBy: a.acknowledgedByUserId, acknowledgedAt: iso(a.acknowledgedAt) }));
}

export async function listReconciliation(limit: number) {
  const runs = await db.select().from(paymentReconRuns).orderBy(desc(paymentReconRuns.startedAt)).limit(limit);
  const items = await db.select().from(paymentReconItems).orderBy(desc(paymentReconItems.createdAt)).limit(limit * 20);
  return runs.map((r) => ({
    id: r.id, provider: r.provider, day: r.day, startedAt: r.startedAt.toISOString(), finishedAt: iso(r.finishedAt), error: r.error, counts: r.counts,
    items: items.filter((i) => i.runId === r.id).map((i) => ({ id: i.id, object: i.object, kind: i.kind, reference: i.reference, ours: i.ours, theirs: i.theirs, resolvedBy: i.resolvedByUserId, resolvedAt: iso(i.resolvedAt), note: i.note })),
  }));
}

export const finalizationsFor = (targetId: string) => db.select().from(paymentFinalizations).where(eq(paymentFinalizations.targetId, targetId)).orderBy(desc(paymentFinalizations.createdAt));

export async function acknowledgeAlert(adminUserId: string, id: string) {
  return db.transaction(async (tx) => {
    const [a] = await tx.select().from(paymentAlerts).where(eq(paymentAlerts.id, id)).for("update");
    if (!a) throw paymentsError(404, "not_found");
    if (a.acknowledgedAt) return a;
    const [after] = await tx.update(paymentAlerts).set({ acknowledgedByUserId: adminUserId, acknowledgedAt: new Date() }).where(eq(paymentAlerts.id, id)).returning();
    await recordAdminAction(tx, { adminUserId, action: "payments.alert_ack", targetType: "payment_alert", targetId: id, before: { acknowledgedAt: null }, after: { kind: a.kind } });
    return after;
  });
}

/** An admin's note on a reconciliation difference: what they found and did. It changes nothing else. */
export async function resolveReconItem(adminUserId: string, id: string, note: string) {
  return db.transaction(async (tx) => {
    const [i] = await tx.select().from(paymentReconItems).where(eq(paymentReconItems.id, id)).for("update");
    if (!i) throw paymentsError(404, "not_found");
    const [after] = await tx.update(paymentReconItems).set({ resolvedByUserId: adminUserId, resolvedAt: new Date(), note }).where(eq(paymentReconItems.id, id)).returning();
    await recordAdminAction(tx, { adminUserId, action: "payments.recon_resolve", targetType: "payment_recon_item", targetId: id, reason: note, before: { resolvedAt: iso(i.resolvedAt), note: i.note }, after: { note } });
    return after;
  });
}

/** Replay the normal verify for a top-up (a missed webhook, a reconciliation finding). Same checks; credits at most once. */
export async function adminVerifyTopup(adminUserId: string, topupId: string, reason: string) {
  const [t] = await db.select().from(topups).where(eq(topups.id, topupId));
  if (!t) throw paymentsError(404, "not_found");
  const outcome = await confirmTopup(topupId, "admin_verify");
  await recordAdminAction(db, { adminUserId, action: "payments.topup_verify", targetType: "topup", targetId: topupId, reason, before: { status: t.status }, after: { outcome } });
  return outcome;
}

/**
 * Webhooks: authenticate first (each provider its own way), store the raw event, acknowledge, and let the
 * worker process it. An event is marked processed only once it has had its effect; one whose top-up the
 * provider's verify still calls pending is tried again later. A webhook is only a hint: processing it runs the same fresh verify (top-ups) or query
 * (payouts) as every other path, so a forged, replayed or wrong webhook can't move money on its own.
 */
import { and, count, desc, eq, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db, getPaymentsConfig, paymentWebhookEvents, paymentWebhookRejections, payouts, topups } from "@contestly/db";
import { backoffMs, paymentsError, raiseAlert, type PaymentsDeps } from "./common.js";
import { configuredProviderNames, knownProviderNames, providerNamed } from "./providers/index.js";
import { confirmTopup } from "./topups.js";
import { checkPayout } from "./payouts.js";
import type { Headers } from "./types.js";

export interface IngestOptions {
  /** PAYMENTS_WEBHOOK_IP_ALLOWLIST: refuse a webhook from outside the provider's published addresses. */
  ipAllowlist: boolean;
  clientIp: string;
}

/**
 * Authenticate and store. Throws 404 for a provider we don't have, 409 for one not configured here, 403 off
 * the allow-list, 401 for a bad signature; each refusal is recorded first (recordRejection).
 */
export async function ingestWebhook(providerName: string, rawBody: Buffer, headers: Headers, opts: IngestOptions, deps: PaymentsDeps) {
  const refuse = async (status: number, reason: string) => {
    await recordRejection(providerName, opts.clientIp, reason, rawBody);
    return paymentsError(status, reason);
  };
  if (!knownProviderNames().includes(providerName)) throw await refuse(404, "not_found");
  if (!configuredProviderNames().includes(providerName)) throw await refuse(409, "provider_not_configured");
  const provider = providerNamed(providerName);
  if (opts.ipAllowlist && !provider.webhookIps.includes(opts.clientIp)) throw await refuse(403, "webhook_ip_refused");
  const ev = provider.parseWebhook(rawBody, headers);
  if (!ev) throw await refuse(401, "invalid_signature");
  const [row] = await db.insert(paymentWebhookEvents)
    .values({ provider: providerName, eventId: ev.eventId, type: ev.name, reference: ev.reference, body: rawBody.toString("utf8") })
    .onConflictDoUpdate({ target: [paymentWebhookEvents.provider, paymentWebhookEvents.eventId], set: { deliveries: sql`${paymentWebhookEvents.deliveries} + 1` } })
    .returning();
  // A redelivery of an event already processed changes nothing; one that never finished processing is tried again.
  if (!row.processedAt) await deps.enqueue({ kind: "webhook", eventId: row.id }, { jobId: `webhook-${row.id}-${row.deliveries}` });
  return { eventId: row.id, duplicate: row.deliveries > 1 };
}

/**
 * The worker: find what the event is about and run the normal path for it. Records the outcome. One that
 * leaves its top-up still pending, or throws, counts an attempt and is retried (a new job id each time);
 * after webhooks.maxAttempts it's dead-lettered with an alert. A throw is recorded, then rethrown.
 */
export async function processWebhookEvent(eventRowId: string, now = new Date()): Promise<string> {
  const [row] = await db.select().from(paymentWebhookEvents).where(eq(paymentWebhookEvents.id, eventRowId));
  if (!row) return "missing";
  if (row.processedAt) return row.outcome ?? "processed";
  if (row.deadLetteredAt) return "dead_lettered";
  const cfg = await getPaymentsConfig();
  try {
    const outcome = await handleEvent(row, now);
    if (outcome === STILL_PENDING) return await retryLater(row, outcome, cfg.webhooks.maxAttempts, now);
    await db.update(paymentWebhookEvents).set({ processedAt: now, outcome, attempts: row.attempts + 1, nextAttemptAt: null }).where(eq(paymentWebhookEvents.id, row.id));
    return outcome;
  } catch (e) {
    await retryLater(row, `error: ${(e as Error).message}`.slice(0, 500), cfg.webhooks.maxAttempts, now);
    throw e;
  }
}

/** Count the attempt and schedule the next, or dead-letter it (with an alert) once it has had them all. */
async function retryLater(row: typeof paymentWebhookEvents.$inferSelect, outcome: string, maxAttempts: number, now: Date) {
  const attempts = row.attempts + 1;
  if (attempts >= maxAttempts) {
    await db.transaction(async (tx) => {
      await tx.update(paymentWebhookEvents).set({ outcome, attempts, nextAttemptAt: null, deadLetteredAt: now }).where(eq(paymentWebhookEvents.id, row.id));
      await raiseAlert(tx, { severity: "warning", kind: "webhook_dead_lettered", dedupeKey: `webhook_dead_lettered:${row.id}`, refType: "webhook", refId: row.id, detail: { provider: row.provider, reference: row.reference, attempts, lastOutcome: outcome } });
    });
    return "dead_lettered";
  }
  await db.update(paymentWebhookEvents).set({ outcome, attempts, nextAttemptAt: new Date(now.getTime() + backoffMs(attempts, RETRY_FIRST_SECONDS, RETRY_MAX_SECONDS)) }).where(eq(paymentWebhookEvents.id, row.id));
  return outcome;
}

async function handleEvent(row: typeof paymentWebhookEvents.$inferSelect, now: Date): Promise<string> {
  const ev = providerNamed(row.provider).readWebhook(Buffer.from(row.body, "utf8"));
  let outcome: string;
  if (ev.type === "topup" && ev.reference) {
    const [t] = await db.select().from(topups).where(and(eq(topups.provider, row.provider), eq(topups.reference, ev.reference)));
    outcome = t ? `topup:${await confirmTopup(t.id, "webhook", ev, now)}` : await unknownReference(row.provider, "topup", ev.reference, row.id);
  } else if (ev.type === "transfer" && ev.reference) {
    const [p] = await db.select().from(payouts).where(and(eq(payouts.provider, row.provider), eq(payouts.reference, ev.reference)));
    outcome = p ? `payout:${await checkPayout(p.id, "webhook", now, ev)}` : await unknownReference(row.provider, "payout", ev.reference, row.id);
  } else {
    outcome = "ignored";
  }
  // STILL_PENDING: the provider's verify doesn't agree yet (it can lag its own webhook): not processed; retried.
  return outcome;
}

const STILL_PENDING = "topup:still_pending";
const RETRY_FIRST_SECONDS = 60;
const RETRY_MAX_SECONDS = 3600;
/** An event stored but never processed (a lost job, a worker that died mid-way) is picked up after this. */
const ORPHAN_AFTER_MS = 5 * 60_000;

/**
 * Stored events still to process: ones whose top-up was still pending (from next_attempt_at), and ones whose
 * job never ran. Each is retried until its top-up stops being pending (credited, failed or expired at the cutoff).
 */
export async function dueWebhookEvents(now: Date, limit: number) {
  return db.select({ id: paymentWebhookEvents.id, attempts: paymentWebhookEvents.attempts }).from(paymentWebhookEvents).where(and(
    isNull(paymentWebhookEvents.processedAt), isNull(paymentWebhookEvents.deadLetteredAt),
    or(lte(paymentWebhookEvents.nextAttemptAt, now), and(isNull(paymentWebhookEvents.nextAttemptAt), lt(paymentWebhookEvents.receivedAt, new Date(now.getTime() - ORPHAN_AFTER_MS)))),
  )).limit(limit);
}

async function unknownReference(provider: string, object: string, reference: string, eventId: string) {
  await raiseAlert(db, { severity: "warning", kind: "webhook_unknown_reference", dedupeKey: `webhook_unknown_reference:${provider}:${reference}`, refType: "webhook", refId: eventId, detail: { provider, object, reference } });
  return "unknown_reference";
}

/** At most this many rejections are stored per hour (a flood is counted by the cap being hit, not stored). */
export const REJECTIONS_PER_HOUR_CAP = 1000;
/** Rejections are kept this long (the sweep deletes older ones). */
export const REJECTIONS_KEPT_DAYS = 30;
const HEAD_BYTES = 500;

/**
 * Record a refused webhook: provider (as given, truncated), source IP, reason and the first 500 bytes, never
 * the whole body; at most REJECTIONS_PER_HOUR_CAP an hour. At webhooks.rejectionsAlertPerHour in an hour,
 * an alert (once an hour): every webhook failing at once usually means a wrong secret after a key rotation.
 */
export async function recordRejection(provider: string, sourceIp: string, reason: string, rawBody: Buffer, now = new Date()) {
  const hourAgo = new Date(now.getTime() - 3600_000);
  const [{ n }] = await db.select({ n: count() }).from(paymentWebhookRejections).where(gte(paymentWebhookRejections.createdAt, hourAgo));
  if (Number(n) >= REJECTIONS_PER_HOUR_CAP) return false;
  const head = rawBody.subarray(0, HEAD_BYTES).toString("utf8").replace(/\u0000/g, "");
  await db.insert(paymentWebhookRejections).values({ provider: provider.slice(0, 50), sourceIp: sourceIp.slice(0, 64), reason, head, createdAt: now });
  const threshold = (await getPaymentsConfig()).webhooks.rejectionsAlertPerHour;
  if (Number(n) + 1 >= threshold) {
    await raiseAlert(db, { severity: "warning", kind: "webhook_rejections", dedupeKey: `webhook_rejections:${now.toISOString().slice(0, 13)}`, detail: { lastHour: Number(n) + 1, threshold, latest: { provider, reason, sourceIp } } });
  }
  return true;
}

/** For the console's webhooks page: rejections in the last hour and day, and the latest few. */
export async function rejectionSummary(limit = 20, now = new Date()) {
  const since = (ms: number) => db.select({ n: count() }).from(paymentWebhookRejections).where(gte(paymentWebhookRejections.createdAt, new Date(now.getTime() - ms)));
  const [[hour], [day], latest] = await Promise.all([since(3600_000), since(24 * 3600_000), db.select().from(paymentWebhookRejections).orderBy(desc(paymentWebhookRejections.createdAt)).limit(limit)]);
  return { lastHour: Number(hour.n), lastDay: Number(day.n), latest: latest.map((r) => ({ id: r.id, provider: r.provider, sourceIp: r.sourceIp, reason: r.reason, head: r.head, at: r.createdAt.toISOString() })) };
}

/** The retention: rejections older than REJECTIONS_KEPT_DAYS go. */
export async function pruneRejections(now = new Date()) {
  const gone = await db.delete(paymentWebhookRejections).where(lt(paymentWebhookRejections.createdAt, new Date(now.getTime() - REJECTIONS_KEPT_DAYS * 24 * 3600_000))).returning({ id: paymentWebhookRejections.id });
  return gone.length;
}

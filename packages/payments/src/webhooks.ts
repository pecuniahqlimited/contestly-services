/**
 * Webhooks: authenticate first (each provider its own way), store the raw event, acknowledge, and let the
 * worker process it. An event is marked processed only once it has had its effect; one whose top-up the
 * provider's verify still calls pending is tried again later. A webhook is only a hint: processing it runs the same fresh verify (top-ups) or query
 * (payouts) as every other path, so a forged, replayed or wrong webhook can't move money on its own.
 */
import { and, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db, paymentWebhookEvents, payouts, topups } from "@contestly/db";
import { backoffMs, paymentsError, raiseAlert, type PaymentsDeps } from "./common.js";
import { knownProviderNames, providerNamed } from "./providers/index.js";
import { confirmTopup } from "./topups.js";
import { checkPayout } from "./payouts.js";
import type { Headers } from "./types.js";

export interface IngestOptions {
  /** PAYMENTS_WEBHOOK_IP_ALLOWLIST: refuse a webhook from outside the provider's published addresses. */
  ipAllowlist: boolean;
  clientIp: string;
}

/** Authenticate and store. Throws 404 for a provider we don't have, 403 off the allow-list, 401 for a bad signature. */
export async function ingestWebhook(providerName: string, rawBody: Buffer, headers: Headers, opts: IngestOptions, deps: PaymentsDeps) {
  if (!knownProviderNames().includes(providerName)) throw paymentsError(404, "not_found");
  const provider = providerNamed(providerName);
  if (opts.ipAllowlist && !provider.webhookIps.includes(opts.clientIp)) throw paymentsError(403, "webhook_ip_refused");
  const ev = provider.parseWebhook(rawBody, headers);
  if (!ev) throw paymentsError(401, "invalid_signature");
  const [row] = await db.insert(paymentWebhookEvents)
    .values({ provider: providerName, eventId: ev.eventId, type: ev.name, reference: ev.reference, body: rawBody.toString("utf8") })
    .onConflictDoUpdate({ target: [paymentWebhookEvents.provider, paymentWebhookEvents.eventId], set: { deliveries: sql`${paymentWebhookEvents.deliveries} + 1` } })
    .returning();
  // A redelivery of an event already processed changes nothing; one that never finished processing is tried again.
  if (!row.processedAt) await deps.enqueue({ kind: "webhook", eventId: row.id }, { jobId: `webhook-${row.id}-${row.deliveries}` });
  return { eventId: row.id, duplicate: row.deliveries > 1 };
}

/** The worker: find what the event is about and run the normal path for it. Records the outcome. */
export async function processWebhookEvent(eventRowId: string, now = new Date()): Promise<string> {
  const [row] = await db.select().from(paymentWebhookEvents).where(eq(paymentWebhookEvents.id, eventRowId));
  if (!row) return "missing";
  if (row.processedAt) return row.outcome ?? "processed";
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
  if (outcome === STILL_PENDING) {
    // The provider's verify doesn't agree yet (it can lag its own webhook): not processed; the sweep brings it back.
    const attempts = row.attempts + 1;
    await db.update(paymentWebhookEvents).set({ outcome, attempts, nextAttemptAt: new Date(now.getTime() + backoffMs(attempts, RETRY_FIRST_SECONDS, RETRY_MAX_SECONDS)) }).where(eq(paymentWebhookEvents.id, row.id));
    return outcome;
  }
  await db.update(paymentWebhookEvents).set({ processedAt: now, outcome, attempts: row.attempts + 1, nextAttemptAt: null }).where(eq(paymentWebhookEvents.id, row.id));
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
    isNull(paymentWebhookEvents.processedAt),
    or(lte(paymentWebhookEvents.nextAttemptAt, now), and(isNull(paymentWebhookEvents.nextAttemptAt), lt(paymentWebhookEvents.receivedAt, new Date(now.getTime() - ORPHAN_AFTER_MS)))),
  )).limit(limit);
}

async function unknownReference(provider: string, object: string, reference: string, eventId: string) {
  await raiseAlert(db, { severity: "warning", kind: "webhook_unknown_reference", dedupeKey: `webhook_unknown_reference:${provider}:${reference}`, refType: "webhook", refId: eventId, detail: { provider, object, reference } });
  return "unknown_reference";
}

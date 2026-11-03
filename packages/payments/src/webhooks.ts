/**
 * Webhooks: authenticate first (each provider its own way), store the raw event, acknowledge, and let the
 * worker process it. An event is marked processed only once it has had its effect; one whose top-up the
 * provider's verify still calls pending is tried again later. A webhook is only a hint: processing it runs the same fresh verify (top-ups) or query
 * (payouts) as every other path, so a forged, replayed or wrong webhook can't move money on its own.
 */
import { and, count, desc, eq, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db, getPaymentsConfig, paymentWebhookEvents, paymentWebhookRejections, payouts, topups, adminAlert } from "@contestly/db";
import { backoffMs, paymentsError, ONCE_PER_THING_SECONDS, type PaymentsDeps } from "./common.js";
import { allowListedWebhookIps, configuredProviderNames, knownProviderNames, providerNamed } from "./providers/index.js";
import { confirmTopup } from "./topups.js";
import { checkPayout } from "./payouts.js";
import type { Headers } from "./types.js";

export interface IngestOptions {
  /** PAYMENTS_WEBHOOK_IP_ALLOWLIST: refuse a webhook from outside the provider's published addresses. */
  ipAllowlist: boolean;
  clientIp: string;
  /** What to do with a refusal (tests pass their own); the API's by default. */
  gate?: RejectionGate;
}

/**
 * Authenticate and store. Throws 404 for a provider we don't have, 409 for one not configured here, 403 off
 * the allow-list, 401 for a bad signature, 429 when one address keeps sending refused webhooks; each refusal
 * goes through the in-memory gate first, which decides whether it's stored (recordRejection).
 */
export async function ingestWebhook(providerName: string, rawBody: Buffer, headers: Headers, opts: IngestOptions, deps: PaymentsDeps) {
  const gate = opts.gate ?? rejectionGate;
  const refuse = async (status: number, reason: string) => {
    const decision = gate.decide(opts.clientIp);
    if (decision === "throttle") return paymentsError(429, "too_many_refusals");
    if (decision === "record") await recordRejection(providerName, opts.clientIp, reason, rawBody, gate.counts().thisHour);
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
      await adminAlert({ severity: "warning", kind: "payments.webhook_dead_lettered", subject: "A webhook was dead-lettered after its retries", dedupeKey: `webhook_dead_lettered:${row.id}`, refType: "webhook", refId: row.id, details: { provider: row.provider, reference: row.reference, attempts, lastOutcome: outcome }, dedupeWindowSeconds: ONCE_PER_THING_SECONDS }, tx);
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
  await adminAlert({ severity: "warning", kind: "payments.webhook_unknown_reference", subject: "A webhook names a reference we don't have", dedupeKey: `webhook_unknown_reference:${provider}:${reference}`, refType: "webhook", refId: eventId, details: { provider, object, reference }, dedupeWindowSeconds: ONCE_PER_THING_SECONDS });
  return "unknown_reference";
}

/** At most this many rejections are stored per hour (past it, they're counted in memory, not stored). */
export const REJECTIONS_PER_HOUR_CAP = 1000;
/** Rejections are kept this long (the sweep deletes older ones). */
export const REJECTIONS_KEPT_DAYS = 30;
const HEAD_BYTES = 500;
const MINUTE_MS = 60_000;

export type GateDecision = "record" | "count" | "throttle";
export interface RejectionGateOptions { perIpPerMinute: number; perHourCap: number; exemptIps: () => string[] }

/**
 * Decides, in memory and before any database work, what happens to a refused webhook (ADR 0013):
 * - throttle: more than perIpPerMinute refusals from this address this minute (a provider's own allow-listed
 *   addresses are exempt): answered 429, never stored;
 * - count: this hour's perHourCap rows are already stored: refused as usual, only counted ("and N more");
 * - record: stored (recordRejection).
 * Per process: with several API instances each keeps its own counts.
 */
export function makeRejectionGate(opts: RejectionGateOptions) {
  let hour = "";
  let recorded = 0;
  let notRecorded = 0;
  let perIp = new Map<string, { minute: number; n: number }>();
  return {
    decide(ip: string, now = new Date()): GateDecision {
      const h = now.toISOString().slice(0, 13);
      if (h !== hour) { hour = h; recorded = 0; notRecorded = 0; perIp = new Map(); }
      const minute = Math.floor(now.getTime() / MINUTE_MS);
      if (!opts.exemptIps().includes(ip)) {
        const seen = perIp.get(ip);
        const n = seen && seen.minute === minute ? seen.n + 1 : 1;
        perIp.set(ip, { minute, n });
        if (n > opts.perIpPerMinute) { notRecorded++; return "throttle"; }
      }
      if (recorded >= opts.perHourCap) { notRecorded++; return "count"; }
      recorded++;
      return "record";
    },
    /** Refusals this hour (stored and not) and how many weren't stored. */
    counts(now = new Date()) {
      const current = now.toISOString().slice(0, 13) === hour;
      return { thisHour: current ? recorded + notRecorded : 0, notRecordedThisHour: current ? notRecorded : 0 };
    },
  };
}
export type RejectionGate = ReturnType<typeof makeRejectionGate>;

/** The API's gate. PAYMENTS_WEBHOOK_REFUSALS_PER_IP_PER_MINUTE (default 30). */
export const rejectionGate = makeRejectionGate({
  perIpPerMinute: Number(process.env.PAYMENTS_WEBHOOK_REFUSALS_PER_IP_PER_MINUTE) || 30,
  perHourCap: REJECTIONS_PER_HOUR_CAP,
  exemptIps: allowListedWebhookIps,
});

/**
 * Store a refused webhook the gate let through: provider (as given, truncated), source IP, reason and the
 * first 500 bytes, never the whole body. When this hour's refusals reach webhooks.rejectionsAlertPerHour, an
 * alert (once an hour): every webhook failing at once usually means a wrong secret after a key rotation.
 */
export async function recordRejection(provider: string, sourceIp: string, reason: string, rawBody: Buffer, refusalsThisHour: number, now = new Date()) {
  const head = rawBody.subarray(0, HEAD_BYTES).toString("utf8").replace(/\u0000/g, "");
  await db.insert(paymentWebhookRejections).values({ provider: provider.slice(0, 50), sourceIp: sourceIp.slice(0, 64), reason, head, createdAt: now });
  const threshold = (await getPaymentsConfig()).webhooks.rejectionsAlertPerHour;
  if (refusalsThisHour >= threshold) {
    await adminAlert({ severity: "warning", kind: "payments.webhook_rejections", subject: "Rejected webhooks this hour are above the threshold", dedupeKey: `webhook_rejections:${now.toISOString().slice(0, 13)}`, details: { thisHour: refusalsThisHour, threshold, latest: { provider, reason, sourceIp } } });
  }
}

/** For the console's webhooks page: rejections in the last hour and day, and the latest few. */
export async function rejectionSummary(limit = 20, now = new Date(), gate: RejectionGate = rejectionGate) {
  const since = (ms: number) => db.select({ n: count() }).from(paymentWebhookRejections).where(gte(paymentWebhookRejections.createdAt, new Date(now.getTime() - ms)));
  const [[hour], [day], latest] = await Promise.all([since(3600_000), since(24 * 3600_000), db.select().from(paymentWebhookRejections).orderBy(desc(paymentWebhookRejections.createdAt)).limit(limit)]);
  // notRecordedThisHour: refused but not stored (throttled, or past the hourly cap): "and N more refused".
  return { lastHour: Number(hour.n), lastDay: Number(day.n), notRecordedThisHour: gate.counts(now).notRecordedThisHour, latest: latest.map((r) => ({ id: r.id, provider: r.provider, sourceIp: r.sourceIp, reason: r.reason, head: r.head, at: r.createdAt.toISOString() })) };
}

/** The retention: rejections older than REJECTIONS_KEPT_DAYS go. */
export async function pruneRejections(now = new Date()) {
  const gone = await db.delete(paymentWebhookRejections).where(lt(paymentWebhookRejections.createdAt, new Date(now.getTime() - REJECTIONS_KEPT_DAYS * 24 * 3600_000))).returning({ id: paymentWebhookRejections.id });
  return gone.length;
}

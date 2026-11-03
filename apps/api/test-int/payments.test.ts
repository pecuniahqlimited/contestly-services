/**
 * Payments (row 10, ADR 0013) against the real database and the mock provider. The rule under test: no
 * glitch, retry, race or bad provider answer creates money or loses it. Top-ups credit once, only on a
 * verified confirmation; withdrawals debit first, reverse only on a definite failure, and settle once;
 * admins finalize through the same transitions; switching providers strands nothing; the invariant job and
 * reconciliation catch what they should.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, count, desc, eq, gte, inArray, like, notInArray, sql as sqlRaw } from "drizzle-orm";
import {
  accountHasPaymentIssue, devAdminHandles, grantDevAdmins, adminActions, adminBanRequests, linkedIssueClearances, owedWaivers, paymentFinalizations, paymentPermissionGrants, adminAlert, adminAlerts, adminPermissions, afterCommit, archiveAccount, clearExpiredArchives, moneyTransaction, invariantAcknowledgments, cancelIfUnplaceable, db, deletionBlockers, partyPlayers, potBalance, takeSeat, getPaymentsConfig, ledger, ledgerAccounts, ledgerEntries, parties, paymentConfigChanges, paymentReconItems, paymentSettings, paymentWebhookEvents, paymentWebhookRejections,
  payoutAccounts, payoutContradictions, payouts, setPaymentsConfig, sql, systemActorId, topups, users, type Payout, type Tx, type User,
} from "@contestly/db";
import {
  DEFAULT_PAYMENTS_CONFIG, adminFreshCheckResponseSchema, adminPaymentsOverviewSchema, adminPayoutsResponseSchema, adminPendingResponseSchema, adminReconciliationResponseSchema,
  adminTopupsResponseSchema, adminWebhooksResponseSchema, kobo, type PaymentsConfig, type PaymentsJob,
} from "@contestly/shared";
import {
  addBankAccount, applyOutcome, checkPayout, findBreaches, closeProviders, confirmTopup, createTopup, mockControlsOrNull, pausePayoutsBySystem, processWebhookEvent, reconcileDay,
  approvePayout, breakGlassGrantConfig, linkedIssueAccounts, confirmFinalization, confirmOwedWaiver, ITEM_CAP, requestLinkedIssueClearance, setPermissions, permissionsOf, pruneRejections, type Breach, rejectPayout, requestFinalization, requestOwedWaiver, ingestWebhook, makeRejectionGate, rejectionSummary, REJECTIONS_KEPT_DAYS, requestPayout, resetProviders, resolveAccount, runInvariants, settleLocked, submitPayout, sweepDue, type KeyValue, type MockControls, type MockDelivery, type PaymentsDeps,
} from "@contestly/payments";
import { PAYSTACK_TRANSFER_FEE_TIERS, paystackTransferFeeKobo } from "@contestly/payments";
import { partyQueue } from "@contestly/queue";
import { buildApp } from "../src/app.js";
import { settle } from "../../worker/src/partySettle.js";
import { as, makeUser, tag, testApp } from "./harness.js";

let app: Awaited<ReturnType<typeof testApp>>["app"];
let mock: MockControls;
let admin: User, admin2: User, viewer: User;

const queued: PaymentsJob[] = [];
const deps: PaymentsDeps = { async enqueue(job) { queued.push(job); } };
const store = new Map<string, string>();
const kv: KeyValue = { get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v); }, del: async (k) => { store.delete(k); } };

const MIN = 60_000;
const later = (ms: number) => new Date(Date.now() + ms);
const cash = async (u: User) => (await ledger.balances(u.id)).cashKobo;
let n = 0;
const nextName = (p: string) => `${p}${++n}`;

async function settings(change: Partial<{ collections: string; payouts: string; topupsPaused: boolean; payoutsPaused: boolean }>) {
  const [cur] = await db.select().from(paymentSettings).orderBy(desc(paymentSettings.version)).limit(1);
  await db.insert(paymentSettings).values({ collections: cur?.collections ?? "mock", payouts: cur?.payouts ?? "mock", topupsPaused: false, payoutsPaused: false, ...change, changedBy: "admin", createdByUserId: admin.id, reason: "test" });
}
async function config(patch: (c: PaymentsConfig) => void) {
  const c = structuredClone(DEFAULT_PAYMENTS_CONFIG);
  patch(c);
  await setPaymentsConfig(c);
}

async function fund(u: User, amountKobo: number) {
  await db.transaction((tx) => ledger.post(tx, { userId: u.id, kind: "cash", amountKobo, type: "topup", idempotencyKey: `t:pay:${tag}:${u.id}:${amountKobo}:${Date.now()}` }));
}
/** A person who can withdraw: verified email and phone, some cash, and a confirmed mock bank account. */
async function withdrawer(name: string, cashKobo = kobo(10_000), extra: Partial<typeof users.$inferInsert> = {}) {
  const u = await makeUser(nextName(name), { phone: `+23480${randomUUID().replace(/\D/g, "").slice(0, 8)}`, phoneVerifiedAt: new Date(), ...extra });
  if (cashKobo) await fund(u, cashKobo);
  const r = await resolveAccount(u.id, { bankCode: "001", accountNumber: `01${String(Date.now()).slice(-8)}` }, kv);
  const account = await addBankAccount(u.id, { resolveToken: r.resolveToken, accountName: r.accountName }, kv);
  return { u, account };
}
const request = (u: User, accountId: string, amountKobo: number, clientRequestId = randomUUID()) => requestPayout(u, { amountKobo, bankAccountId: accountId, clientRequestId }, deps);
const reload = async (id: string) => (await db.select().from(payouts).where(eq(payouts.id, id)))[0];
const entriesFor = (prefix: string) => db.select().from(ledgerEntries).where(like(ledgerEntries.idempotencyKey, `${prefix}%`));

/** Post a provider's webhook to the API, as the provider would. */
const postWebhook = (d: MockDelivery, provider = "mock") => app.inject({ method: "POST", url: `/webhooks/${provider}`, headers: d.headers, payload: d.rawBody });
/** Process every stored, unprocessed webhook for a reference (what the worker does). */
async function processWebhooks(reference: string) {
  const rows = await db.select().from(paymentWebhookEvents).where(eq(paymentWebhookEvents.reference, reference));
  return Promise.all(rows.map((r) => processWebhookEvent(r.id)));
}
/** A thing's alerts (main's admin_alerts, kinds "payments.…"). */
const alertsFor = (refId: string) => db.select().from(adminAlerts).where(eq(adminAlerts.refId, refId));

beforeAll(async () => {
  // Never a real provider here, whatever .env holds (a Paystack test key for paystack:check, say).
  delete process.env.PAYSTACK_SECRET_KEY;
  delete process.env.PAYMENTS_PROVIDER;
  resetProviders();
  ({ app } = await testApp());
  mock = mockControlsOrNull()!;
  admin = await makeUser("payadmin", { isAdmin: true });
  admin2 = await makeUser("payadmin2", { isAdmin: true });
  viewer = await makeUser("payviewer", { isAdmin: true });
  // admin and admin2 hold everything; viewer only payments.view. Granted the way the console does it.
  await db.insert(adminPermissions).values([admin, admin2].flatMap((a) => (["payments.view", "payments.approve", "payments.finalize", "payments.config"] as const).map((permission) => ({ userId: a.id, permission }))));
  await db.insert(adminPermissions).values({ userId: viewer.id, permission: "payments.view" });
  await settings({});
  await config(() => {});
});

afterAll(async () => {
  await app.close();
  await closeProviders();
  await sql.end();
});

describe("top-ups: credited once, only on a verified confirmation", () => {
  const start = async (u: User, amountKobo: number) => {
    const res = await app.inject({ method: "POST", url: "/wallet/topups", headers: as(u), payload: { amountKobo } });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { reference: string; status: string; checkoutUrl: string };
  };
  const topupRow = async (reference: string) => (await db.select().from(topups).where(eq(topups.reference, reference)))[0];

  it("the server makes the reference; the client's redirect (and polling) never credits", async () => {
    const u = await makeUser(nextName("tpredirect"));
    const t = await start(u, kobo(500));
    expect(t.reference).toMatch(/^tp-[0-9a-f]{24}$/);
    expect(t.status).toBe("pending");
    expect(t.checkoutUrl).toContain(`/payments/mock/checkout/${t.reference}`);
    await mock.completeCheckout(t.reference, "pay"); // paid at the provider, but no webhook and no check yet
    const polled = await app.inject({ method: "GET", url: `/wallet/topups/${t.reference}`, headers: as(u) });
    expect(polled.json().status).toBe("pending");
    expect(await cash(u)).toBe(0);
    // Nobody else's reference is visible.
    expect((await app.inject({ method: "GET", url: `/wallet/topups/${t.reference}`, headers: as(admin) })).statusCode).toBe(404);
  });

  it("a webhook plus a fresh verify credits once", async () => {
    const u = await makeUser(nextName("tpok"));
    const t = await start(u, kobo(500));
    const [d] = await mock.completeCheckout(t.reference, "pay");
    expect((await postWebhook(d)).statusCode).toBe(200);
    expect(await processWebhooks(t.reference)).toEqual(["topup:credited"]);
    expect(await cash(u)).toBe(kobo(500));
    const row = await topupRow(t.reference);
    expect(row.status).toBe("succeeded");
    expect(row.creditedVia).toBe("webhook");
    expect((await app.inject({ method: "GET", url: `/wallet/topups/${t.reference}`, headers: as(u) })).json().status).toBe("succeeded");
  });

  it("a duplicate webhook, a redelivery and concurrent confirmations credit once", async () => {
    const u = await makeUser(nextName("tpdup"));
    const t = await start(u, kobo(500) + 27); // the mock delivers its webhook twice
    const deliveries = await mock.completeCheckout(t.reference, "pay");
    expect(deliveries).toHaveLength(2);
    const answers = [];
    for (const d of deliveries) answers.push((await postWebhook(d)).json());
    expect(answers[1].duplicate).toBe(true);
    const row = await topupRow(t.reference);
    await Promise.all([processWebhooks(t.reference), ...Array.from({ length: 5 }, () => confirmTopup(row.id, "webhook")), confirmTopup(row.id, "check")]);
    expect(await cash(u)).toBe(kobo(500) + 27);
    expect(await entriesFor(`topup:mock:${t.reference}`)).toHaveLength(2); // one journal: the person's leg and topup_in's
    expect(await confirmTopup(row.id, "admin_verify")).toBe("already_credited");
  });

  it("a webhook with a bad signature is refused and not stored", async () => {
    const u = await makeUser(nextName("tpsig"));
    const t = await start(u, kobo(500) + 26);
    const [d] = await mock.completeCheckout(t.reference, "pay");
    const res = await postWebhook(d);
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_signature");
    expect(await db.select().from(paymentWebhookEvents).where(eq(paymentWebhookEvents.reference, t.reference))).toHaveLength(0);
    expect((await topupRow(t.reference)).status).toBe("pending");
  });

  it("a wrong amount, currency or user (from the provider or in the webhook) is a mismatch for an admin, never a credit", async () => {
    for (const [scenario, why] of [[21, "verify amount"], [22, "verify currency"], [23, "verify user"]] as const) {
      const u = await makeUser(nextName("tpmis"));
      const t = await start(u, kobo(500) + scenario);
      const [d] = await mock.completeCheckout(t.reference, "pay");
      await postWebhook(d);
      await processWebhooks(t.reference);
      const row = await topupRow(t.reference);
      expect(row.status, why).toBe("mismatch");
      expect(JSON.stringify(row.problem)).toContain(why);
      expect(await cash(u)).toBe(0);
      expect((await alertsFor(row.id)).map((a) => a.kind)).toContain("payments.topup_mismatch");
      expect(await confirmTopup(row.id, "check")).toBe("held_for_admin");
    }
    // The provider's verify agrees, but the (validly signed) webhook claims another amount.
    const u = await makeUser(nextName("tpclaim"));
    const t = await start(u, kobo(500));
    await mock.completeCheckout(t.reference, "pay");
    await postWebhook(mock.signedDelivery("topup.paid", { reference: t.reference, amountKobo: kobo(5000), currency: "NGN", userId: u.id, status: "paid" }));
    await processWebhooks(t.reference);
    expect((await topupRow(t.reference)).status).toBe("mismatch");
    expect(await cash(u)).toBe(0);
  });

  it("a missed webhook is credited by the worker's check, through the same checks", async () => {
    const u = await makeUser(nextName("tpmissed"));
    const t = await start(u, kobo(500));
    await mock.completeCheckout(t.reference, "pay"); // the webhook never arrives
    queued.length = 0;
    await sweepDue(deps, later(2 * MIN));
    const job = queued.find((j) => j.kind === "topup_check");
    expect(job).toBeDefined();
    const row = await topupRow(t.reference);
    expect(await confirmTopup(row.id, "check")).toBe("credited");
    expect(await cash(u)).toBe(kobo(500));
  });

  it("pending at the provider keeps it pending (then credits); unpaid by the cutoff expires; a late payment still credits once", async () => {
    const u = await makeUser(nextName("tpslow"));
    const t = await start(u, kobo(500) + 25); // pending for two verifies after paying
    await mock.completeCheckout(t.reference, "pay");
    const row = await topupRow(t.reference);
    expect(await confirmTopup(row.id, "check")).toBe("still_pending");
    expect(await confirmTopup(row.id, "check")).toBe("still_pending");
    expect(await confirmTopup(row.id, "check")).toBe("credited");

    const v = await makeUser(nextName("tplate"));
    const s = await start(v, kobo(500));
    const late = await topupRow(s.reference);
    expect(await confirmTopup(late.id, "check", null, new Date(late.createdAt.getTime() + DEFAULT_PAYMENTS_CONFIG.checks.topupCutoffMinutes * MIN))).toBe("expired");
    expect((await topupRow(s.reference)).nextCheckAt).toBeNull();
    const [d] = await mock.completeCheckout(s.reference, "pay");
    await postWebhook(d);
    expect(await processWebhooks(s.reference)).toEqual(["topup:credited"]);
    expect(await cash(v)).toBe(kobo(500));
  });

  it("the provider gets the account's verified email; without one: email_required, never a placeholder", async () => {
    for (const extra of [{ emailVerifiedAt: null }, { email: null, emailVerifiedAt: null }]) {
      const u = await makeUser(nextName("tpnomail"), extra);
      const res = await app.inject({ method: "POST", url: "/wallet/topups", headers: as(u), payload: { amountKobo: kobo(500) } });
      expect([res.statusCode, res.json().error]).toEqual([409, "email_required"]);
      expect(await db.select().from(topups).where(eq(topups.userId, u.id))).toHaveLength(0);
    }
  });

  it("a refused start fails the top-up with the provider's message and leaves nothing to verify", async () => {
    // The mock refuses a malformed email the way Paystack does, so dev catches it.
    const u = await makeUser(nextName("tpbadmail"), { email: "not-an-email" });
    const res = await app.inject({ method: "POST", url: "/wallet/topups", headers: as(u), payload: { amountKobo: kobo(500) } });
    expect([res.statusCode, res.json().error, res.json().details.message]).toEqual([422, "topup_refused", '"email" must be a valid email']);
    const row = await topupRow(res.json().details.reference);
    expect([row.status, row.nextCheckAt, row.checkoutUrl]).toEqual(["failed", null, null]);
    expect(row.problem).toMatchObject({ stage: "start", refused: true, httpStatus: 400 });
    queued.length = 0;
    await sweepDue(deps, later(DEFAULT_PAYMENTS_CONFIG.checks.topupCutoffMinutes * MIN));
    expect(queued.filter((j) => j.kind === "topup_check" && j.topupId === row.id)).toHaveLength(0);
    expect(await cash(u)).toBe(0);
  });

  it("a start that never finished (no checkout) is failed by the sweep, never verified", async () => {
    const u = await makeUser(nextName("tpcrash"));
    const [stuck] = await db.insert(topups).values({ userId: u.id, amountKobo: kobo(500), provider: "mock", reference: `tp-crash${tag}${n}`, status: "pending", createdAt: new Date(Date.now() - 6 * MIN) }).returning();
    queued.length = 0;
    expect((await sweepDue(deps)).unstarted).toBeGreaterThanOrEqual(1);
    expect(queued.some((j) => j.kind === "topup_check" && j.topupId === stuck.id)).toBe(false);
    expect((await db.select().from(topups).where(eq(topups.id, stuck.id)))[0].status).toBe("failed");
  });

  it("a declined attempt isn't final: still payable on the same checkout until the cutoff, whose check is the final one", async () => {
    // Declined, then paid with another card on the same checkout: credited once.
    const u = await makeUser(nextName("tpretry"));
    const t = await start(u, kobo(500));
    await mock.completeCheckout(t.reference, "fail");
    const row = await topupRow(t.reference);
    expect(await confirmTopup(row.id, "check")).toBe("still_pending");
    const polled = (await app.inject({ method: "GET", url: `/wallet/topups/${t.reference}`, headers: as(u) })).json();
    expect([polled.status, polled.attemptFailed, polled.checkoutUrl]).toEqual(["pending", true, t.checkoutUrl]);
    expect((await topupRow(t.reference)).nextCheckAt).not.toBeNull();
    const [d] = await mock.completeCheckout(t.reference, "pay");
    await postWebhook(d);
    expect(await processWebhooks(t.reference)).toContain("topup:credited");
    expect(await cash(u)).toBe(kobo(500));

    // Declined and never paid: failed only by the check at the cutoff.
    const v = await makeUser(nextName("tpfail"));
    const f = await start(v, kobo(500) + 24);
    await mock.completeCheckout(f.reference, "pay");
    const frow = await topupRow(f.reference);
    expect(await confirmTopup(frow.id, "check")).toBe("still_pending");
    expect((await topupRow(f.reference)).status).toBe("pending");
    expect(await confirmTopup(frow.id, "check", null, new Date(frow.createdAt.getTime() + DEFAULT_PAYMENTS_CONFIG.checks.topupCutoffMinutes * MIN))).toBe("failed");
    expect((await topupRow(f.reference)).status).toBe("failed");
    expect(await cash(v)).toBe(0);
  });

  it("a webhook the provider's verify doesn't agree with yet isn't marked processed: the sweep brings it back until it credits", async () => {
    const u = await makeUser(nextName("tpwhlag"));
    const t = await start(u, kobo(500) + 25); // verify says pending twice after paying
    const [d] = await mock.completeCheckout(t.reference, "pay");
    await postWebhook(d);
    expect(await processWebhooks(t.reference)).toEqual(["topup:still_pending"]);
    const [ev] = await db.select().from(paymentWebhookEvents).where(eq(paymentWebhookEvents.reference, t.reference));
    expect([ev.processedAt, ev.attempts]).toEqual([null, 1]);
    expect(ev.nextAttemptAt).not.toBeNull();
    queued.length = 0;
    await sweepDue(deps, later(2 * MIN));
    expect(queued.some((j) => j.kind === "webhook" && j.eventId === ev.id)).toBe(true);
    expect(await processWebhookEvent(ev.id)).toBe("topup:still_pending");
    expect(await processWebhookEvent(ev.id)).toBe("topup:credited");
    const [done] = await db.select().from(paymentWebhookEvents).where(eq(paymentWebhookEvents.id, ev.id));
    expect([done.outcome, done.attempts, done.nextAttemptAt]).toEqual(["topup:credited", 3, null]);
    expect(done.processedAt).not.toBeNull();
    queued.length = 0;
    await sweepDue(deps, later(2 * 3600_000));
    expect(queued.some((j) => j.kind === "webhook" && j.eventId === ev.id)).toBe(false);
    expect(await cash(u)).toBe(kobo(500) + 25);
  });

  it("a webhook whose processing keeps throwing is retried under a new job id each time, then dead-lettered with an alert", async () => {
    await config((c) => { c.webhooks.maxAttempts = 3; });
    try {
      const [ev] = await db.insert(paymentWebhookEvents).values({ provider: "mock", eventId: `broken-${tag}`, type: "topup.paid", reference: null, body: "this is not json" }).returning();
      const jobIds: string[] = [];
      const recorder: PaymentsDeps = { async enqueue(job, opts) { if (job.kind === "webhook" && job.eventId === ev.id) jobIds.push(opts!.jobId!); } };
      for (let i = 1; i <= 3; i++) {
        await sweepDue(recorder, later(i * 10 * MIN)); // orphaned at first, then due by next_attempt_at
        await expect(processWebhookEvent(ev.id)).rejects.toThrow();
        const [row] = await db.select().from(paymentWebhookEvents).where(eq(paymentWebhookEvents.id, ev.id));
        expect(row.attempts).toBe(i);
        expect(row.outcome).toMatch(/^error: /);
      }
      expect(new Set(jobIds).size).toBe(jobIds.length); // never the same job id twice
      expect(jobIds.length).toBe(3);
      const [dead] = await db.select().from(paymentWebhookEvents).where(eq(paymentWebhookEvents.id, ev.id));
      expect([dead.deadLetteredAt !== null, dead.processedAt, dead.nextAttemptAt]).toEqual([true, null, null]);
      expect((await alertsFor(ev.id)).find((a) => a.kind === "payments.webhook_dead_lettered")?.severity).toBe("warning");
      jobIds.length = 0;
      await sweepDue(recorder, later(24 * 3600_000));
      expect(jobIds).toEqual([]);
      expect(await processWebhookEvent(ev.id)).toBe("dead_lettered");
    } finally {
      await config(() => {});
    }
  });

  it("rejected webhooks are logged (time, provider, source IP, reason, first 500 bytes), capped per hour, and a spike alerts", async () => {
    await config((c) => { c.webhooks.rejectionsAlertPerHour = 3; });
    try {
      const big = mock.signedDelivery("topup.paid", { reference: `tp-rej-${tag}`, padding: "x".repeat(2000) }, true);
      expect((await postWebhook(big)).statusCode).toBe(401);
      expect((await postWebhook(big, "nosuchprovider")).statusCode).toBe(404);
      expect((await postWebhook(big)).statusCode).toBe(401);
      const rows = await db.select().from(paymentWebhookRejections).where(like(paymentWebhookRejections.head, `%tp-rej-${tag}%`));
      expect(rows.map((r) => [r.provider, r.reason]).sort()).toEqual([["mock", "invalid_signature"], ["mock", "invalid_signature"], ["nosuchprovider", "not_found"]]);
      expect(rows.every((r) => r.head.length === 500 && r.sourceIp.length > 0)).toBe(true);
      expect(await db.select().from(paymentWebhookEvents).where(eq(paymentWebhookEvents.reference, `tp-rej-${tag}`))).toHaveLength(0);
      expect((await db.select().from(adminAlerts).where(eq(adminAlerts.kind, "payments.webhook_rejections"))).length).toBeGreaterThan(0);
      const page = (await app.inject({ method: "GET", url: "/admin/payments/webhooks", headers: as(viewer) })).json();
      expect(page.rejections.lastHour).toBeGreaterThanOrEqual(3);
      // Kept 30 days.
      expect(await pruneRejections(new Date(Date.now() + (REJECTIONS_KEPT_DAYS + 1) * 24 * 3600_000))).toBeGreaterThanOrEqual(3);
    } finally {
      await config(() => {});
    }
  });

  it("a flood of refusals stays capped without database writes: the in-memory gate throttles per address and counts past the hourly cap", async () => {
    const stored = async () => Number((await db.select({ n: count() }).from(paymentWebhookRejections).where(like(paymentWebhookRejections.head, `%flood-${tag}%`)))[0].n);
    const gate = makeRejectionGate({ perIpPerMinute: 1000, perHourCap: 3, exemptIps: () => ["52.31.139.75"] });
    const bad = mock.signedDelivery("topup.paid", { reference: `flood-${tag}` }, true);
    const ingestFrom = (ip: string, g = gate) => ingestWebhook("mock", bad.rawBody, bad.headers, { ipAllowlist: false, clientIp: ip, gate: g }, deps).then(() => 200, (e: { statusCode: number }) => e.statusCode);
    for (let i = 0; i < 50; i++) expect(await ingestFrom(`198.51.100.${i % 20}`)).toBe(401);
    expect(await stored()).toBe(3); // the cap; the other 47 never reached the database
    expect(gate.counts()).toEqual({ thisHour: 50, notRecordedThisHour: 47 });
    expect((await rejectionSummary(20, new Date(), gate)).notRecordedThisHour).toBe(47);
    // Per address: past its limit an address gets 429 and nothing is stored or counted against the cap; a provider's own address is exempt.
    const tight = makeRejectionGate({ perIpPerMinute: 2, perHourCap: 1000, exemptIps: () => ["52.31.139.75"] });
    expect([await ingestFrom("203.0.113.50", tight), await ingestFrom("203.0.113.50", tight), await ingestFrom("203.0.113.50", tight)]).toEqual([401, 401, 429]);
    expect([await ingestFrom("52.31.139.75", tight), await ingestFrom("52.31.139.75", tight), await ingestFrom("52.31.139.75", tight)]).toEqual([401, 401, 401]);
    expect(await stored()).toBe(3 + 2 + 3);
  });


  it("limits and the pause are enforced", async () => {
    const u = await makeUser(nextName("tplimits"));

    const ask = (amountKobo: number) => app.inject({ method: "POST", url: "/wallet/topups", headers: as(u), payload: { amountKobo } });
    expect((await ask(DEFAULT_PAYMENTS_CONFIG.topup.minKobo - 1)).json().error).toBe("below_minimum");
    const tooMuch = await ask(DEFAULT_PAYMENTS_CONFIG.topup.maxKobo + 1);
    expect([tooMuch.json().error, tooMuch.json().details.limit]).toEqual(["limit_reached", "topup_max"]);
    await config((c) => { c.topup.dailyCapKobo = kobo(1200); });
    expect((await ask(kobo(600))).statusCode).toBe(201);
    expect((await ask(kobo(700))).json().details.limit).toBe("topup_daily");
    await config(() => {});
    await settings({ topupsPaused: true });
    const paused = await ask(kobo(500));
    expect([paused.statusCode, paused.json().error]).toEqual([503, "payments_paused"]);
    await settings({});
    // A guest can't top up at all.
    const guest = await makeUser(nextName("tpguest"), { isGuest: true, email: null, emailVerifiedAt: null });
    expect((await app.inject({ method: "POST", url: "/wallet/topups", headers: as(guest), payload: { amountKobo: kobo(500) } })).json().error).toBe("sign_up_required");
  });
});

describe("GET /wallet/limits: what the app shows is what the server allows", () => {
  it("top-up and withdrawal limits with what's left today, and the fee: who bears it, the tiers, the estimate for an amount", async () => {
    await config((c) => { c.topup.dailyCapKobo = kobo(2000); c.payout.dailyAmountKobo = kobo(5000); c.payout.dailyCount = 3; c.payout.feeBearer = "user"; });
    try {
      const { u, account } = await withdrawer("limits");
      const limits = async (q = "") => (await app.inject({ method: "GET", url: `/wallet/limits${q}`, headers: as(u) })).json();
      const before = await limits("?amountKobo=200000");
      expect(before.topup).toEqual({ paused: false, minKobo: DEFAULT_PAYMENTS_CONFIG.topup.minKobo, maxKobo: DEFAULT_PAYMENTS_CONFIG.topup.maxKobo, dailyCapKobo: kobo(2000), remainingTodayKobo: kobo(2000) });
      expect(before.withdrawal).toEqual({ paused: false, minKobo: DEFAULT_PAYMENTS_CONFIG.payout.minKobo, maxKobo: DEFAULT_PAYMENTS_CONFIG.payout.maxKobo, dailyAmountKobo: kobo(5000), remainingAmountTodayKobo: kobo(5000), dailyCount: 3, remainingCountToday: 3 });
      expect(before.fee).toEqual({ bearer: "user", tiers: [{ upToKobo: null, feeKobo: 1000 }], estimate: { amountKobo: 200000, feeKobo: 1000, sentKobo: 199000 } });
      expect((await limits()).fee.estimate).toBeNull();

      // A pending top-up and a withdrawal count, as they do when enforced.
      expect((await app.inject({ method: "POST", url: "/wallet/topups", headers: as(u), payload: { amountKobo: kobo(600) } })).statusCode).toBe(201);
      const { payout } = await request(u, account.id, kobo(1500));
      const after = await limits();
      expect([after.topup.remainingTodayKobo, after.withdrawal.remainingAmountTodayKobo, after.withdrawal.remainingCountToday]).toEqual([kobo(1400), kobo(3500), 2]);
      expect((await app.inject({ method: "POST", url: "/wallet/topups", headers: as(u), payload: { amountKobo: after.topup.remainingTodayKobo + 1 } })).json().details.limit).toBe("topup_daily");
      expect(payout.feeKobo).toBe(before.fee.estimate.feeKobo);

      await settings({ payoutsPaused: true });
      expect((await limits()).withdrawal.paused).toBe(true);
      await settings({});
      // The Paystack tiers, as the app would see them with Paystack sending payouts.
      expect(PAYSTACK_TRANSFER_FEE_TIERS.map((t) => [t.upToKobo, paystackTransferFeeKobo(t.upToKobo ?? 10_000_000)])).toEqual([[500_000, 1_000], [5_000_000, 2_500], [null, 5_000]]);
      expect((await app.inject({ method: "GET", url: "/wallet/limits?amountKobo=-5", headers: as(u) })).statusCode).toBe(400);
    } finally {
      await config(() => {});
    }
  });
});

describe("withdrawals: debit first, reverse only on a definite failure", () => {
  it("debits before any provider call, then settles once with the fee recorded", async () => {
    const { u, account } = await withdrawer("posettle");
    const { payout } = await request(u, account.id, kobo(1500));
    expect(payout.status).toBe("requested");
    expect(await cash(u)).toBe(kobo(10_000) - kobo(1500));
    expect(await entriesFor(`payout_debit:${payout.id}`)).toHaveLength(2);
    expect(await mock.getTransfer(payout.reference)).toBeNull(); // the provider hasn't heard of it
    expect(queued.some((j) => j.kind === "payout_submit" && j.payoutId === payout.id)).toBe(true);

    expect(await submitPayout(payout.id)).toBe("succeeded");
    const done = await reload(payout.id);
    expect([done.status, done.feeKobo, done.finalVia]).toEqual(["succeeded", 1_000, "send"]);
    expect(await entriesFor(`payout_final:${payout.id}`)).toHaveLength(2);
    expect(await entriesFor(`payout_fee:${payout.id}`)).toHaveLength(2); // the platform bears the fee by default
    expect(await submitPayout(payout.id)).toBe("unchanged");
    expect(await cash(u)).toBe(kobo(8500));
  });

  it("a definite failure reverses exactly once, however often it's heard", async () => {
    const { u, account } = await withdrawer("pofail");
    const { payout } = await request(u, account.id, kobo(1500) + 11);
    expect(await submitPayout(payout.id)).toBe("failed");
    expect(await cash(u)).toBe(kobo(10_000));
    const failed = { status: "failed" as const, providerStatus: "failed", reference: payout.reference, amountKobo: payout.sentKobo, currency: "NGN", userId: null, feeKobo: null, error: null };
    await Promise.all([applyOutcome(payout.id, failed, "check"), applyOutcome(payout.id, failed, "webhook"), checkPayout(payout.id, "check")]);
    expect(await cash(u)).toBe(kobo(10_000));
    expect(await entriesFor(`payout_final:${payout.id}`)).toHaveLength(2);
    expect((await reload(payout.id)).status).toBe("failed");
  });

  it("a timeout, a 5xx and a provider 'pending' all become unknown and are requeried, never reversed", async () => {
    for (const [scenario, label] of [[14, "timeout that went through"], [16, "502 that went through"], [12, "pending"]] as const) {
      const { u, account } = await withdrawer("pounknown");
      const { payout } = await request(u, account.id, kobo(1500) + scenario);
      expect(await submitPayout(payout.id), label).toBe("unknown");
      const p = await reload(payout.id);
      expect(p.status, label).toBe("unknown");
      expect(p.nextCheckAt, label).not.toBeNull();
      expect(await cash(u), label).toBe(kobo(10_000) - (kobo(1500) + scenario)); // still debited, not given back
      expect(await entriesFor(`payout_final:${payout.id}`), label).toHaveLength(0);
      // The sweep asks again when it's due; the provider eventually answers.
      queued.length = 0;
      await sweepDue(deps, later(10 * MIN));
      expect(queued.some((j) => j.kind === "payout_check" && j.payoutId === payout.id), label).toBe(true);
      let out = await checkPayout(payout.id, "check");
      while (out === "unknown") out = await checkPayout(payout.id, "check");
      expect(out, label).toBe("succeeded");
      const after = await reload(payout.id);
      expect(after.sendAttempts, `${label}: never sent twice`).toBe(1);
      expect(await entriesFor(`payout_final:${payout.id}`), label).toHaveLength(2);
      expect(await cash(u), label).toBe(kobo(10_000) - (kobo(1500) + scenario));
    }
  });

  it("a pending transfer that finally fails is reversed once", async () => {
    const { u, account } = await withdrawer("popendfail");
    const { payout } = await request(u, account.id, kobo(1500) + 13);
    expect(await submitPayout(payout.id)).toBe("unknown");
    let out = await checkPayout(payout.id, "check");
    while (out === "unknown") out = await checkPayout(payout.id, "check");
    expect(out).toBe("failed");
    expect(await cash(u)).toBe(kobo(10_000));
  });

  it("not found after a timeout: resent with the same reference only after a quiet period", async () => {
    const { u, account } = await withdrawer("ponotfound");
    const { payout } = await request(u, account.id, kobo(1500) + 15);
    expect(await submitPayout(payout.id)).toBe("unknown");
    expect(await checkPayout(payout.id, "check")).toBe("unknown"); // too soon: no resend
    expect((await reload(payout.id)).sendAttempts).toBe(1);
    expect(await checkPayout(payout.id, "check", later(10 * MIN))).toBe("unknown"); // still inside the 30-minute window
    expect((await reload(payout.id)).sendAttempts).toBe(1);
    expect(await checkPayout(payout.id, "check", later(DEFAULT_PAYMENTS_CONFIG.checks.resendAfterNotFoundSeconds * 1000 + MIN))).toBe("succeeded");
    expect((await reload(payout.id)).sendAttempts).toBe(2);
    expect(await cash(u)).toBe(kobo(10_000) - (kobo(1500) + 15));
  });

  it("a submitted payout (a crash after sending) is checked, never sent blind", async () => {
    const { account, u } = await withdrawer("pocrash");
    const { payout } = await request(u, account.id, kobo(1500));
    await db.update(payouts).set({ status: "submitted", submittedAt: new Date(), lastSentAt: new Date(), sendAttempts: 1 }).where(eq(payouts.id, payout.id));
    await mock.setTransfer(payout.reference, { amountKobo: payout.sentKobo, recipientCode: account.recipientCode, state: "success", createdAt: Date.now(), queries: 0 });
    expect(await submitPayout(payout.id)).toBe("succeeded");
    expect((await reload(payout.id)).sendAttempts).toBe(1);
  });

  it("a webhook and a query racing make one transition", async () => {
    const { u, account } = await withdrawer("porace");
    const { payout } = await request(u, account.id, kobo(1500) + 12);
    expect(await submitPayout(payout.id)).toBe("unknown");
    const t = (await mock.getTransfer(payout.reference))!;
    await mock.setTransfer(payout.reference, { ...t, state: "success" });
    const [d] = await mock.transferWebhooks(payout.reference);
    expect((await postWebhook(d)).statusCode).toBe(200);
    const results = await Promise.all([processWebhooks(payout.reference), checkPayout(payout.id, "check"), checkPayout(payout.id, "check")]);
    expect(results.flat().filter((r) => r === "succeeded" || r === "payout:succeeded")).toHaveLength(1);
    expect(await entriesFor(`payout_final:${payout.id}`)).toHaveLength(2);
    expect(await cash(u)).toBe(kobo(10_000) - (kobo(1500) + 12));
  });

  it("a success after a reversal freezes the person's withdrawals and holds the disputed amount, in the same transaction as the critical alert", async () => {
    const { u, account } = await withdrawer("porevsucc");
    const { payout } = await request(u, account.id, kobo(1500) + 11);
    const queuedOne = (await request(u, account.id, kobo(1500))).payout; // asked before anyone knew
    expect(await submitPayout(payout.id)).toBe("failed");
    const t = (await mock.getTransfer(payout.reference))!;
    await mock.setTransfer(payout.reference, { ...t, state: "success" });
    const [d] = await mock.transferWebhooks(payout.reference);
    await postWebhook(d);
    await processWebhooks(payout.reference);
    const alerts = await alertsFor(payout.id);
    const alert = alerts.find((a) => a.kind === "payments.payout_success_after_reversal")!;
    expect(alert.severity).toBe("critical");
    const [frozen] = await db.select().from(users).where(eq(users.id, u.id));
    expect(frozen.withdrawalsFrozenAt).not.toBeNull();
    const [c] = await db.select().from(payoutContradictions).where(eq(payoutContradictions.payoutId, payout.id));
    expect([c.status, c.amountKobo, c.userId]).toEqual(["open", payout.amountKobo, u.id]);
    expect((await reload(payout.id)).status).toBe("failed");
    // The queued one is reversed; the disputed amount is out of cash, in the hold.
    expect([(await reload(queuedOne.id)).status, await mock.getTransfer(queuedOne.reference)]).toEqual(["rejected", null]);
    expect(await cash(u)).toBe(kobo(10_000) - payout.amountKobo);
    expect(await entriesFor(`payout_final:${payout.id}`)).toHaveLength(2);
    expect(await entriesFor(`contradiction_hold:${payout.id}`)).toHaveLength(2);
    // Nothing else can leave: new requests refused.
    await expect(request(frozen, account.id, kobo(1500))).rejects.toMatchObject({ message: "withdraw_not_allowed", details: { reason: "payment_review" } });
    // Heard again: still one contradiction, one alert.
    await checkPayout(payout.id, "check");
    expect(await db.select().from(payoutContradictions).where(eq(payoutContradictions.payoutId, payout.id))).toHaveLength(1);
    expect((await alertsFor(payout.id)).filter((a) => a.kind === "payments.payout_success_after_reversal")).toHaveLength(1);
  });

  it("a send sees a freeze committing at the same moment: the person's row is locked first, so it's held, never sent", async () => {
    const { u, account } = await withdrawer("pofreezerace");
    const { payout } = await request(u, account.id, kobo(1500));
    let sent: Promise<unknown> | undefined;
    await db.transaction(async (tx) => {
      await tx.select().from(users).where(eq(users.id, u.id)).for("no key update"); // a freeze in progress
      await tx.update(users).set({ withdrawalsFrozenAt: new Date() }).where(eq(users.id, u.id));
      sent = submitPayout(payout.id);
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(await sent).toBe("unchanged");
    const p = await reload(payout.id);
    expect([p.status, p.holdReason]).toEqual(["awaiting_approval", "blocked:payment_review"]);
    expect(await mock.getTransfer(payout.reference)).toBeNull();
    await db.update(users).set({ withdrawalsFrozenAt: null }).where(eq(users.id, u.id));
  });

  it("double payout path 1: a timed-out send, a lagging lookup, then a balance refusal on the resend is unknown, never reversed", async () => {
    const { u, account } = await withdrawer("poresendbal");
    const { payout } = await request(u, account.id, kobo(1500) + 31);
    expect(await submitPayout(payout.id)).toBe("unknown"); // the send timed out; the transfer went through
    const afterWindow = later(DEFAULT_PAYMENTS_CONFIG.checks.resendAfterNotFoundSeconds * 1000 + MIN);
    // Lookup says not found past the window: resent with the same reference, and refused on balance.
    expect(await checkPayout(payout.id, "check", afterWindow)).toBe("unknown");
    const p = await reload(payout.id);
    expect([p.status, p.sendAttempts]).toEqual(["unknown", 2]);
    expect((p.lastCheck as { providerStatus: string }).providerStatus).toMatch(/^resend_refused: refused: Insufficient balance/);
    expect(await entriesFor(`payout_final:${payout.id}`)).toHaveLength(0); // never reversed
    expect(await cash(u)).toBe(kobo(10_000) - (kobo(1500) + 31));
    // The provider's lookup catches up: settled once. Paid once.
    const t = (await mock.getTransfer(payout.reference))!;
    await mock.setTransfer(payout.reference, { ...t, hidden: false });
    expect(await checkPayout(payout.id, "check", later(2 * DEFAULT_PAYMENTS_CONFIG.checks.resendAfterNotFoundSeconds * 1000))).toBe("succeeded");
    expect(await cash(u)).toBe(kobo(10_000) - (kobo(1500) + 31));
    expect((await alertsFor(payout.id)).map((a) => a.kind)).not.toContain("payments.payout_success_after_reversal");
  });

  it("a resend never goes to an account the person removed: it stays unknown and alerts", async () => {
    const { u, account } = await withdrawer("poresendgone");
    const { payout } = await request(u, account.id, kobo(1500) + 15); // first send times out, nothing created
    expect(await submitPayout(payout.id)).toBe("unknown");
    const del = await app.inject({ method: "DELETE", url: `/wallet/bank-accounts/${account.id}`, headers: as(u) });
    expect(del.statusCode).toBe(204);
    expect(await checkPayout(payout.id, "check", later(DEFAULT_PAYMENTS_CONFIG.checks.resendAfterNotFoundSeconds * 1000 + MIN))).toBe("unknown");
    const p = await reload(payout.id);
    expect([p.status, p.sendAttempts]).toEqual(["unknown", 1]);
    expect(await mock.getTransfer(payout.reference)).toBeNull();
    expect((await alertsFor(payout.id)).find((a) => a.kind === "payments.payout_resend_account_removed")?.severity).toBe("warning");
    expect(await cash(u)).toBe(kobo(10_000) - (kobo(1500) + 15));
  });

  it("duplicate, wrong-amount and badly signed transfer webhooks", async () => {
    const dup = await withdrawer("powhdup");
    const a = (await request(dup.u, dup.account.id, kobo(1500) + 17)).payout;
    await submitPayout(a.id);
    for (const d of await mock.transferWebhooks(a.reference)) await postWebhook(d);
    expect(await processWebhooks(a.reference)).toEqual(["payout:unchanged"]); // already final; agrees
    expect(await entriesFor(`payout_final:${a.id}`)).toHaveLength(2);

    const wrong = await withdrawer("powhamt");
    const b = (await request(wrong.u, wrong.account.id, kobo(1500) + 18)).payout;
    await db.update(payouts).set({ status: "submitted", submittedAt: new Date(), lastSentAt: new Date(), sendAttempts: 1 }).where(eq(payouts.id, b.id));
    await mock.setTransfer(b.reference, { amountKobo: b.sentKobo, recipientCode: wrong.account.recipientCode, state: "success", createdAt: Date.now(), queries: 0 });
    for (const d of await mock.transferWebhooks(b.reference)) await postWebhook(d);
    await processWebhooks(b.reference);
    expect((await alertsFor(b.id)).map((x) => x.kind)).toContain("payments.payout_webhook_amount_differs");
    expect((await reload(b.id)).status).toBe("succeeded"); // settled on the provider's own answer, which matches

    const bad = await withdrawer("powhsig");
    const c = (await request(bad.u, bad.account.id, kobo(1500) + 19)).payout;
    await submitPayout(c.id);
    const [d] = await mock.transferWebhooks(c.reference);
    expect((await postWebhook(d)).statusCode).toBe(401);
  });

  it("an unknown payout past the cutoff alerts and stays unknown", async () => {
    const { u, account } = await withdrawer("pocutoff");
    const { payout } = await request(u, account.id, kobo(1500) + 14);
    await db.update(payouts).set({ status: "submitted", submittedAt: new Date(), lastSentAt: new Date(), sendAttempts: 1 }).where(eq(payouts.id, payout.id));
    const unknown = { status: "unknown" as const, providerStatus: "timeout", reference: payout.reference, amountKobo: null, currency: null, userId: null, feeKobo: null, error: "timeout" };
    expect(await applyOutcome(payout.id, unknown, "check", later((DEFAULT_PAYMENTS_CONFIG.checks.unknownAlertAfterMinutes + 1) * MIN))).toBe("unknown");
    expect((await alertsFor(payout.id)).find((a) => a.kind === "payments.payout_unknown_too_long")?.severity).toBe("warning");
    expect((await reload(payout.id)).status).toBe("unknown");
    expect(await cash(u)).toBe(kobo(10_000) - (kobo(1500) + 14));
  });
});

describe("limits, approval and who can withdraw", () => {
  it("concurrent withdrawals can't overdraw, and a double tap is one withdrawal", async () => {
    const { u, account } = await withdrawer("poconc", kobo(3000));
    const results = await Promise.allSettled([1, 2, 3].map(() => request(u, account.id, kobo(1500))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.message).toBe("insufficient_funds");
    expect(await cash(u)).toBe(0);

    const v = await withdrawer("potap");
    const id = randomUUID();
    const taps = await Promise.all([request(v.u, v.account.id, kobo(1500), id), request(v.u, v.account.id, kobo(1500), id)]);
    expect(taps[0].payout.id).toBe(taps[1].payout.id);
    expect(taps.filter((t) => t.replayed)).toHaveLength(1);
    expect(await cash(v.u)).toBe(kobo(8500));
  });

  it("a request while the worker settles the person's earlier withdrawal doesn't deadlock (FK checks vs. the person's row lock)", async () => {
    const { u, account } = await withdrawer("podeadlock");
    const first = (await request(u, account.id, kobo(1500))).payout;
    await db.update(payouts).set({ status: "submitted", submittedAt: new Date(), lastSentAt: new Date(), sendAttempts: 1 }).where(eq(payouts.id, first.id));
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let second: Promise<unknown> | undefined;
    // The worker's settle, slowed down: payout row, then payout_pending held while a request starts, then the final update.
    await db.transaction(async (tx) => {
      const [p] = await tx.select().from(payouts).where(eq(payouts.id, first.id)).for("update");
      await tx.update(payouts).set({ lastCheck: { via: "test" } }).where(eq(payouts.id, p.id));
      await tx.execute(sqlRaw`select id from ledger_accounts where kind = 'payout_pending' and scope = 'mock' for update`);
      second = request(u, account.id, kobo(1500)); // locks the person's row, then waits for payout_pending
      await pause(300);
      await settleLocked(tx, p, "check", null, new Date()); // updates the payouts row again: an FK check on the person's row
    });
    await expect(second!).resolves.toMatchObject({ replayed: false });
    expect((await reload(first.id)).status).toBe("succeeded");
    expect(await cash(u)).toBe(kobo(10_000) - 2 * kobo(1500));
  });

  it("bonus is never withdrawable", async () => {
    const { u, account } = await withdrawer("pobonus", 0);
    await db.transaction((tx) => ledger.post(tx, { userId: u.id, kind: "bonus", amountKobo: kobo(5000), type: "welcome_bonus", idempotencyKey: `t:pay:bonus:${u.id}` }));
    await expect(request(u, account.id, kobo(1500))).rejects.toThrow("insufficient_funds");
    expect(await ledger.balances(u.id)).toEqual({ cashKobo: 0, bonusKobo: kobo(5000) });
  });

  it("needs a verified phone and email, and a wallet that isn't frozen (at request and again before sending)", async () => {
    const nophone = await withdrawer("ponophone", kobo(5000), { phoneVerifiedAt: null });
    const res = await app.inject({ method: "POST", url: "/wallet/withdrawals", headers: as(nophone.u), payload: { amountKobo: kobo(1500), bankAccountId: nophone.account.id, clientRequestId: randomUUID() } });
    expect([res.statusCode, res.json().error, res.json().details.reason]).toEqual([403, "withdraw_not_allowed", "phone_unverified"]);
    const noemail = await withdrawer("ponoemail", kobo(5000), { emailVerifiedAt: null });
    await expect(request(noemail.u, noemail.account.id, kobo(1500))).rejects.toMatchObject({ details: { reason: "email_unverified" } });

    const frozen = await withdrawer("pofrozen");
    const [banned] = await db.update(users).set({ bannedAt: new Date(), banReason: "test" }).where(eq(users.id, frozen.u.id)).returning();
    await expect(request(banned, frozen.account.id, kobo(1500))).rejects.toMatchObject({ details: { reason: "frozen" } });

    // Frozen after asking: held for an admin, never sent, still debited.
    const later = await withdrawer("pofrozenlater");
    const { payout } = await request(later.u, later.account.id, kobo(1500));
    await db.update(users).set({ bannedAt: new Date(), banReason: "test" }).where(eq(users.id, later.u.id));
    expect(await submitPayout(payout.id)).toBe("unchanged");
    const held = await reload(payout.id);
    expect([held.status, held.holdReason]).toEqual(["awaiting_approval", "blocked:frozen"]);
    expect(await mock.getTransfer(payout.reference)).toBeNull();
    expect(await cash(later.u)).toBe(kobo(8500));
  });

  it("minimums, daily limits and an account from another provider", async () => {
    const { u, account } = await withdrawer("polimits", kobo(100_000));
    await expect(request(u, account.id, DEFAULT_PAYMENTS_CONFIG.payout.minKobo - 1)).rejects.toThrow("below_minimum");
    await config((c) => { c.payout.dailyCount = 1; });
    await request(u, account.id, kobo(1500));
    await expect(request(u, account.id, kobo(1500))).rejects.toMatchObject({ message: "limit_reached", details: { limit: "payout_daily_count" } });
    await config(() => {});
    const [other] = await db.insert(payoutAccounts).values({ userId: u.id, provider: "paystack", bankCode: "058", bankName: "Elsewhere", accountNumber: "0123456789", accountName: "X", recipientCode: "RCP_x" }).returning();
    await expect(request(u, other.id, kobo(1500))).rejects.toThrow("account_unresolved");
  });

  it("over the threshold waits for an admin: approve sends it, reject reverses it; nobody approves their own", async () => {
    await config((c) => { c.payout.approvalThresholdKobo = kobo(2000); });
    const a = await withdrawer("poappr");
    const big = (await request(a.u, a.account.id, kobo(2500))).payout;
    expect([big.status, big.holdReason]).toEqual(["awaiting_approval", "over_threshold"]);
    expect(await cash(a.u)).toBe(kobo(7500)); // debited while it waits
    expect(await submitPayout(big.id)).toBe("unchanged");
    const viewerTry = await app.inject({ method: "POST", url: `/admin/payments/payouts/${big.id}/approve`, headers: as(viewer) });
    expect([viewerTry.statusCode, viewerTry.json().error]).toEqual([403, "missing_permission"]);
    expect((await app.inject({ method: "POST", url: `/admin/payments/payouts/${big.id}/approve`, headers: as(admin) })).statusCode).toBe(200);
    expect(await submitPayout(big.id)).toBe("succeeded");

    const b = await withdrawer("poreject");
    const other = (await request(b.u, b.account.id, kobo(2500))).payout;
    expect((await app.inject({ method: "POST", url: `/admin/payments/payouts/${other.id}/reject`, headers: as(admin), payload: {} })).statusCode).toBe(400); // a reason is required
    expect((await app.inject({ method: "POST", url: `/admin/payments/payouts/${other.id}/reject`, headers: as(admin), payload: { reason: "looks wrong" } })).json().payout.status).toBe("rejected");
    expect(await cash(b.u)).toBe(kobo(10_000));
    expect((await app.inject({ method: "POST", url: `/admin/payments/payouts/${other.id}/reject`, headers: as(admin), payload: { reason: "again" } })).json().error).toBe("not_awaiting_approval");

    // An admin's own withdrawal.
    const own = await withdrawer("poownadm", kobo(10_000), { isAdmin: true });
    await db.insert(adminPermissions).values({ userId: own.u.id, permission: "payments.approve" });
    const mine = (await request(own.u, own.account.id, kobo(2500))).payout;
    const self = await app.inject({ method: "POST", url: `/admin/payments/payouts/${mine.id}/approve`, headers: as(own.u) });
    expect([self.statusCode, self.json().error]).toEqual([403, "own_transaction"]);
    await config(() => {});
  });

  it("an account can't be deleted while a withdrawal is open (a failure would bring the money back to it)", async () => {
    const { u, account } = await withdrawer("podelete", kobo(1500));
    const { payout } = await request(u, account.id, kobo(1500));
    expect(await deletionBlockers(db, u.id)).toEqual(["withdrawal_in_progress"]);
    expect(await submitPayout(payout.id)).toBe("succeeded");
    expect(await deletionBlockers(db, u.id)).toEqual([]);
  });

  it("pausing payouts refuses new requests and leaves queued ones debited and queued", async () => {
    const { u, account } = await withdrawer("popause");
    const { payout } = await request(u, account.id, kobo(1500));
    await settings({ payoutsPaused: true });
    await expect(request(u, account.id, kobo(1500))).rejects.toThrow("payments_paused");
    expect(await submitPayout(payout.id)).toBe("unchanged");
    queued.length = 0;
    await sweepDue(deps, later(MIN));
    expect(queued.some((j) => j.kind === "payout_submit" && j.payoutId === payout.id)).toBe(false);
    expect((await reload(payout.id)).status).toBe("requested");
    expect(await cash(u)).toBe(kobo(8500));
    await settings({});
    expect(await submitPayout(payout.id)).toBe("succeeded");
  });
});

describe("admins finalize stuck transactions through the same transitions", () => {
  /** Past the resend window and the quiet period after a send. */
  const QUIET_MS = Math.max(DEFAULT_PAYMENTS_CONFIG.checks.resendAfterNotFoundSeconds * 1000, DEFAULT_PAYMENTS_CONFIG.finalize.quietAfterSendMinutes * MIN) + MIN;
  const stuck = async (name: string, amountKobo: number, owner?: Partial<typeof users.$inferInsert>, sentAgoMs = QUIET_MS) => {
    const w = await withdrawer(name, kobo(100_000), owner);
    const { payout } = await request(w.u, w.account.id, amountKobo + 14 - (amountKobo % 100));
    const sentAt = new Date(Date.now() - sentAgoMs);
    await db.update(payouts).set({ status: "unknown", submittedAt: sentAt, lastSentAt: sentAt, sendAttempts: 1 }).where(eq(payouts.id, payout.id));
    return { ...w, payout: await reload(payout.id) };
  };
  /** What the provider says about it, planted. */
  const provider = (p: Payout, state: "success" | "failed" | "pending") => mock.setTransfer(p.reference, { amountKobo: p.sentKobo, recipientCode: "RCP_x", state, createdAt: Date.now(), queries: -100 });
  const finalize = (who: User, p: Payout, outcome: string, reason = "checked with the provider by phone") =>
    app.inject({ method: "POST", url: `/admin/payments/payouts/${p.id}/finalize`, headers: as(who), payload: { outcome, reason } });
  const confirm = (who: User, id: string) => app.inject({ method: "POST", url: `/admin/payments/finalizations/${id}/confirm`, headers: as(who) });

  it("shows a fresh provider check; one admin when it's definite and agrees: success settles once, failed reverses once", async () => {
    const s = await stuck("fnsucc", kobo(1500));
    await provider(s.payout, "success");
    const check = await app.inject({ method: "GET", url: `/admin/payments/payouts/${s.payout.id}/check`, headers: as(admin) });
    expect(check.json().check.status).toBe("success");
    const ok = await finalize(admin, s.payout, "success");
    expect(ok.json().finalization).toMatchObject({ status: "applied", outcome: "success", secondAdminBecause: [] });
    expect(ok.json().finalization.providerCheck.status).toBe("success");
    expect((await reload(s.payout.id)).status).toBe("succeeded");
    expect(await entriesFor(`payout_final:${s.payout.id}`)).toHaveLength(2);
    expect((await finalize(admin, s.payout, "failed")).json().error).toBe("not_finalizable");
    const log = await db.select().from(adminActions).where(and(eq(adminActions.targetId, s.payout.id), eq(adminActions.action, "payments.finalize")));
    expect(log[0].reason).toBe("checked with the provider by phone");

    const f = await stuck("fnfail", kobo(1500));
    await provider(f.payout, "failed");
    const before = await cash(f.u);
    expect((await finalize(admin, f.payout, "failed")).json().finalization.status).toBe("applied");
    expect(await cash(f.u)).toBe(before + f.payout.amountKobo);
    expect((await finalize(admin, f.payout, "failed")).statusCode).toBe(409);
    expect(await cash(f.u)).toBe(before + f.payout.amountKobo);
    expect((await app.inject({ method: "POST", url: `/admin/payments/payouts/${f.payout.id}/finalize`, headers: as(admin), payload: { outcome: "failed" } })).statusCode).toBe(400);
  });

  it("double payout path 2: an admin can't fail a payout still in flight; once quiet, an answer that isn't definite needs a second admin, and a transfer that lands meanwhile supersedes it", async () => {
    const s = await stuck("fninflight", kobo(1500), {}, 2 * MIN); // sent two minutes ago; the provider says not found
    const early = await finalize(admin, s.payout, "failed");
    expect([early.statusCode, early.json().error]).toEqual([409, "finalize_too_soon"]);
    expect(early.json().details.until).toBeDefined();
    expect((await reload(s.payout.id)).status).toBe("unknown");
    // Past the quiet period, still not found: one admin isn't enough.
    await db.update(payouts).set({ lastSentAt: new Date(Date.now() - QUIET_MS), submittedAt: new Date(Date.now() - QUIET_MS) }).where(eq(payouts.id, s.payout.id));
    const asked = await finalize(admin, s.payout, "failed");
    expect(asked.json().finalization).toMatchObject({ status: "awaiting_second_admin", secondAdminBecause: ["check_not_definite"] });
    expect(asked.json().finalization.providerCheck.status).toBe("not_found");
    expect((await reload(s.payout.id)).status).toBe("unknown");
    // Both admins see why: the second reads it before confirming.
    const seen = await app.inject({ method: "GET", url: `/admin/payments/payouts/${s.payout.id}/check`, headers: as(admin2) });
    expect(seen.json().finalizations[0]).toMatchObject({ secondAdminBecause: ["check_not_definite"], status: "awaiting_second_admin" });
    // The transfer lands before the second admin confirms: superseded, never reversed.
    await provider(s.payout, "success");
    const before = await cash(s.u);
    const confirmed = await confirm(admin2, asked.json().finalization.id);
    expect(confirmed.json().finalization).toMatchObject({ status: "superseded" });
    expect(confirmed.json().finalization.confirmCheck.status).toBe("success");
    expect(await cash(s.u)).toBe(before);
    expect(await entriesFor(`payout_final:${s.payout.id}`)).toHaveLength(0);
    expect(await checkPayout(s.payout.id, "check")).toBe("succeeded");
    expect(await cash(s.u)).toBe(before); // paid once, debited once
  });

  it("a provider answer that disagrees needs a second admin; over the threshold too; nobody confirms their own or finalizes their own", async () => {
    const dis = await stuck("fndisagree", kobo(1500));
    await provider(dis.payout, "success");
    const asked = await finalize(admin, dis.payout, "failed");
    expect(asked.json().finalization).toMatchObject({ status: "awaiting_second_admin", secondAdminBecause: ["check_disagrees"] });
    expect((await confirm(admin2, asked.json().finalization.id)).json().finalization.status).toBe("superseded"); // the provider still says paid

    const big = await stuck("fnbig", DEFAULT_PAYMENTS_CONFIG.finalize.secondAdminThresholdKobo);
    await provider(big.payout, "failed");
    const bigAsk = await finalize(admin, big.payout, "failed");
    expect(bigAsk.json().finalization).toMatchObject({ status: "awaiting_second_admin", secondAdminBecause: ["over_threshold"] });
    expect((await reload(big.payout.id)).status).toBe("unknown");
    const fid = bigAsk.json().finalization.id;
    const same = await confirm(admin, fid);
    expect([same.statusCode, same.json().error]).toEqual([403, "second_admin_required"]);
    expect((await finalize(admin2, big.payout, "success")).json().error).toBe("finalization_pending");
    const before = await cash(big.u);
    const confirmed = await confirm(admin2, fid);
    expect(confirmed.json().finalization).toMatchObject({ status: "applied", confirmedBy: admin2.id });
    expect(await cash(big.u)).toBe(before + big.payout.amountKobo);
    expect((await confirm(admin2, fid)).json().error).toBe("finalization_not_pending");

    const own = await stuck("fnown", kobo(1500), { isAdmin: true });
    await db.insert(adminPermissions).values({ userId: own.u.id, permission: "payments.finalize" });
    expect((await finalize(own.u, own.payout, "failed")).json().error).toBe("own_transaction");
  });

  it("a top-up is credited by hand only with the amount the provider verified; a different amount needs a second admin; none verified, none credited", async () => {
    // The provider says ₦1 more was paid than we asked for (scenario 21): a mismatch.
    const u = await makeUser(nextName("fntopup"));
    const t = await createTopup(u, kobo(500) + 21, { returnUrl: null });
    await mock.completeCheckout(t.reference, "pay");
    expect(await confirmTopup(t.id, "check")).toBe("mismatch");
    const res = await app.inject({ method: "POST", url: `/admin/payments/topups/${t.id}/finalize`, headers: as(admin), payload: { outcome: "success", reason: "provider confirmed what was paid" } });
    expect(res.json().finalization).toMatchObject({ status: "awaiting_second_admin", amountKobo: kobo(501) + 21, secondAdminBecause: ["amount_differs"] });
    expect(await cash(u)).toBe(0);
    expect((await confirm(admin2, res.json().finalization.id)).json().finalization.status).toBe("applied");
    expect(await cash(u)).toBe(kobo(501) + 21); // what was paid, never t.amountKobo
    expect((await db.select().from(topups).where(eq(topups.id, t.id)))[0].creditedKobo).toBe(kobo(501) + 21);
    // The app reads what was credited, not what was asked for: on the top-up and in the list.
    const mine = await app.inject({ method: "GET", url: `/wallet/topups/${t.reference}`, headers: as(u) });
    expect(mine.json()).toMatchObject({ status: "succeeded", amountKobo: kobo(500) + 21, creditedKobo: kobo(501) + 21 });
    const listed = (await app.inject({ method: "GET", url: "/wallet/topups", headers: as(u) })).json().topups;
    expect(listed.map((x: { reference: string; creditedKobo: number | null }) => [x.reference, x.creditedKobo])).toEqual([[t.reference, kobo(501) + 21]]);
    expect((await app.inject({ method: "POST", url: `/admin/payments/topups/${t.id}/finalize`, headers: as(admin), payload: { outcome: "success", reason: "again" } })).json().error).toBe("not_finalizable");
    expect(await cash(u)).toBe(kobo(501) + 21);

    // Nothing paid at the provider: there's no verified amount to credit.
    const w = await makeUser(nextName("fnunpaid"));
    const unpaid = await createTopup(w, kobo(500), { returnUrl: null });
    const refused = await app.inject({ method: "POST", url: `/admin/payments/topups/${unpaid.id}/finalize`, headers: as(admin), payload: { outcome: "success", reason: "customer says they paid" } });
    expect([refused.statusCode, refused.json().error]).toEqual([409, "no_verified_amount"]);
    expect(await cash(w)).toBe(0);

    const v = await makeUser(nextName("fnreplay"));
    const s = await createTopup(v, kobo(500), { returnUrl: null });
    await mock.completeCheckout(s.reference, "pay");
    const replay = await app.inject({ method: "POST", url: `/admin/payments/topups/${s.id}/verify`, headers: as(admin), payload: { reason: "reconciliation: missed webhook" } });
    expect(replay.json().outcome).toBe("credited");
    expect((await app.inject({ method: "POST", url: `/admin/payments/topups/${s.id}/verify`, headers: as(admin), payload: { reason: "again" } })).json().outcome).toBe("already_credited");
    expect(await cash(v)).toBe(kobo(500));
  });
});

describe("contradictions: resolved by two admins", () => {
  /**
   * A withdrawal reversed, then paid after all, with the person's cash at `cashAtFreeze` when the provider's
   * success is heard (spent down through the ledger first, as if they'd joined parties). `beforeFreeze` runs
   * just before the success is heard.
   */
  async function contradicted(name: string, cashAtFreeze: number, beforeFreeze?: (u: User) => Promise<unknown>) {
    const { u, account } = await withdrawer(name);
    const { payout } = await request(u, account.id, kobo(1500) + 11);
    expect(await submitPayout(payout.id)).toBe("failed");
    if (beforeFreeze) await beforeFreeze(u);
    const spend = (await cash(u)) - cashAtFreeze;
    if (spend > 0) await db.transaction((tx) => ledger.post(tx, { userId: u.id, kind: "cash", amountKobo: -spend, type: "topup", idempotencyKey: `t:spend:${payout.id}` }));
    const t = (await mock.getTransfer(payout.reference))!;
    await mock.setTransfer(payout.reference, { ...t, state: "success" });
    await checkPayout(payout.id, "check");
    const [c] = await db.select().from(payoutContradictions).where(eq(payoutContradictions.payoutId, payout.id));
    return { u, account, payout, c };
  }
  const held = async (u: User) => (await db.select().from(ledgerAccounts).where(and(eq(ledgerAccounts.kind, "contradiction_hold"), eq(ledgerAccounts.scope, u.id))))[0]?.balanceKobo ?? 0;
  const resolve = (who: User, id: string, reason = "provider confirmed the transfer was paid") => app.inject({ method: "POST", url: `/admin/payments/contradictions/${id}/resolve`, headers: as(who), payload: { reason } });
  const confirmIt = (who: User, id: string) => app.inject({ method: "POST", url: `/admin/payments/contradictions/${id}/confirm`, headers: as(who) });

  it("enough cash: held in full at the freeze; the confirm (provider still says paid) turns the hold into the recovery, unfreezes; all logged", async () => {
    const { u, account, payout, c } = await contradicted("crfull", kobo(10_000));
    expect([await cash(u), await held(u), await ledger.owedKobo(db, u.id)]).toEqual([kobo(10_000) - payout.amountKobo, payout.amountKobo, 0]);
    expect(c).toMatchObject({ recoveredKobo: payout.amountKobo, owedKobo: 0 });
    const listed = await app.inject({ method: "GET", url: "/admin/payments/contradictions", headers: as(viewer) });
    expect(listed.json().contradictions.some((x: { id: string }) => x.id === c.id)).toBe(true);
    expect((await resolve(viewer, c.id)).statusCode).toBe(403);
    expect((await resolve(admin, c.id)).json().contradiction.status).toBe("awaiting_second_admin");
    expect(await cash(u)).toBe(kobo(10_000) - payout.amountKobo); // nothing moves on the request
    const self = await confirmIt(admin, c.id);
    expect([self.statusCode, self.json().error]).toEqual([403, "second_admin_required"]);
    const done = (await confirmIt(admin2, c.id)).json().contradiction;
    expect(done).toMatchObject({ status: "resolved", recoveredKobo: payout.amountKobo, owedKobo: 0, confirmedBy: admin2.id });
    expect([await cash(u), await held(u)]).toEqual([kobo(10_000) - payout.amountKobo, 0]); // the hold went to the recovery, not back to cash
    expect(await entriesFor(`payout_recovery:${payout.id}`)).toHaveLength(2);
    const [after] = await db.select().from(users).where(eq(users.id, u.id));
    expect(after.withdrawalsFrozenAt).toBeNull();
    expect((await request(after, account.id, kobo(1500))).payout.status).toBe("requested"); // nothing owed: free to withdraw
    expect((await confirmIt(admin2, c.id)).json().error).toBe("contradiction_not_pending");
    const log = await db.select().from(adminActions).where(eq(adminActions.targetId, payout.id));
    expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(["payments.contradiction_requested", "payments.contradiction_resolved"]));
    expect(await findBreaches(db)).toEqual([]);
  });

  it("not enough cash: holds what's there, owes the rest at once; resolved, it stays owed and withdrawals stay blocked by it", async () => {
    const { u, account, payout, c } = await contradicted("crowed", kobo(400));
    expect(c).toMatchObject({ recoveredKobo: kobo(400), owedKobo: payout.amountKobo - kobo(400) });
    expect([await cash(u), await held(u), await ledger.owedKobo(db, u.id)]).toEqual([0, payout.amountKobo, payout.amountKobo - kobo(400)]);
    await resolve(admin, c.id);
    expect((await confirmIt(admin2, c.id)).json().contradiction.status).toBe("resolved");
    expect([await cash(u), await held(u), await ledger.owedKobo(db, u.id)]).toEqual([0, 0, payout.amountKobo - kobo(400)]);
    const [after] = await db.select().from(users).where(eq(users.id, u.id));
    expect(after.withdrawalsFrozenAt).toBeNull(); // unfrozen, but…
    await expect(request(after, account.id, kobo(1500))).rejects.toMatchObject({ details: { reason: "amount_owed" } });
    expect(await findBreaches(db)).toEqual([]);
  });

  it("an open withdrawal at the freeze is reversed (\"contradiction\") and its money lands in the hold", async () => {
    const { u, account } = await withdrawer("crunsent");
    const { payout } = await request(u, account.id, kobo(1500) + 11);
    expect(await submitPayout(payout.id)).toBe("failed");
    const queued = (await request(u, account.id, kobo(10_000))).payout; // every naira they have, debited and waiting
    expect(await cash(u)).toBe(0);
    const t = (await mock.getTransfer(payout.reference))!;
    await mock.setTransfer(payout.reference, { ...t, state: "success" });
    await checkPayout(payout.id, "check");
    const q = await reload(queued.id);
    expect([q.status, q.finalVia, q.holdReason]).toEqual(["rejected", "contradiction", "contradiction"]);
    expect(await mock.getTransfer(queued.reference)).toBeNull(); // never sent
    expect([await held(u), await ledger.owedKobo(db, u.id), await cash(u)]).toEqual([payout.amountKobo, 0, kobo(10_000) - payout.amountKobo]);
    const alert = (await alertsFor(payout.id)).find((a) => a.kind === "payments.payout_success_after_reversal")!;
    expect(alert.details).toMatchObject({ reversedUnsent: [queued.id], heldFromCashKobo: payout.amountKobo });
    expect(await findBreaches(db)).toEqual([]);
  });

  it("held money can't be spent on entries", async () => {
    const { u } = await contradicted("crspend", kobo(1500) + 11); // exactly the disputed amount: all of it held
    expect(await cash(u)).toBe(0);
    const party = await partyWithPot(kobo(100));
    await expect(db.transaction((tx) => ledger.charge(tx, { userId: u.id, amountKobo: kobo(500), type: "party_entry", refType: "party", refId: party.id, idempotencyKey: `t:cr:entry:${u.id}` }))).rejects.toThrow("insufficient_funds");
    expect(await held(u)).toBe(kobo(1500) + 11);
  });

  it("a withdrawal in flight at the freeze is left to finish; when it fails, what comes back repays what's owed", async () => {
    let inFlight: Payout | undefined;
    const { u, payout, c } = await contradicted("crflight", 0, async (u) => {
      const w = (await db.select().from(payoutAccounts).where(eq(payoutAccounts.userId, u.id)))[0];
      inFlight = (await request(u, w.id, kobo(2000) + 13)).payout; // pending twice, then fails
      expect(await submitPayout(inFlight.id)).toBe("unknown");
    });
    expect((await reload(inFlight!.id)).status).toBe("unknown"); // untouched by the freeze
    expect(c.owedKobo).toBe(payout.amountKobo);
    const alert = (await alertsFor(payout.id)).find((a) => a.kind === "payments.payout_success_after_reversal")!;
    expect((alert.details as { inFlight: { id: string }[] }).inFlight.map((x) => x.id)).toEqual([inFlight!.id]);
    let out = await checkPayout(inFlight!.id, "check");
    while (out === "unknown") out = await checkPayout(inFlight!.id, "check");
    expect(out).toBe("failed");
    expect([await ledger.owedKobo(db, u.id), await held(u), await cash(u)]).toEqual([0, payout.amountKobo, kobo(2000) + 13 - payout.amountKobo]);
    expect(await findBreaches(db)).toEqual([]);
  });

  it("asked again at the confirm: a transfer since reversed dissolves it (hold released, owed cleared, unfrozen); one not definite changes nothing", async () => {
    const { u, payout, c } = await contradicted("crdissolve", kobo(400));
    await resolve(admin, c.id);
    const t = (await mock.getTransfer(payout.reference))!;
    await mock.setTransfer(payout.reference, { ...t, state: "pending", queries: -100 });
    const unsure = await confirmIt(admin2, c.id);
    expect([unsure.statusCode, unsure.json().error]).toEqual([409, "provider_not_definite"]);
    expect(await held(u)).toBe(payout.amountKobo);
    await mock.setTransfer(payout.reference, { ...t, state: "failed" }); // Paystack: reversed
    const done = (await confirmIt(admin2, c.id)).json().contradiction;
    expect(done.status).toBe("dissolved");
    expect([await held(u), await ledger.owedKobo(db, u.id), await cash(u)]).toEqual([0, 0, kobo(400)]); // back as it was before the freeze
    expect((await db.select().from(users).where(eq(users.id, u.id)))[0].withdrawalsFrozenAt).toBeNull();
    const [log] = await db.select().from(adminActions).where(and(eq(adminActions.targetId, payout.id), eq(adminActions.action, "payments.contradiction_dissolved")));
    expect(log.after).toMatchObject({ why: "the provider now says the transfer failed or was reversed", owedClearedKobo: payout.amountKobo - kobo(400), toCashKobo: kobo(400) });
    expect(await entriesFor(`payout_recovery:${payout.id}`)).toHaveLength(0);
    expect(await findBreaches(db)).toEqual([]);
  });

  /** Someone who owes the whole duplicate payout (their cash was spent first). */
  async function owing(name: string) {
    const x = await contradicted(name, 0);
    expect(await ledger.owedKobo(db, x.u.id)).toBe(x.payout.amountKobo); // owed from the freeze
    await resolve(admin, x.c.id);
    await confirmIt(admin2, x.c.id);
    expect(await ledger.owedKobo(db, x.u.id)).toBe(x.payout.amountKobo);
    return x;
  }
  /** The person's side of each repayment (leg 0: their cash). */
  const repayments = async (userId: string) => (await db.select().from(ledgerEntries).where(and(eq(ledgerEntries.type, "owed_repaid"), like(ledgerEntries.idempotencyKey, `owed_repay:${userId}:%`)))).filter((e) => !e.idempotencyKey.includes("#"));
  async function partyWithPot(potKobo: number) {
    const host = await makeUser(nextName("owhost"));
    const [party] = await db.insert(parties).values({ createdByUserId: host.id, title: `owed ${tag}`, category: "General knowledge", maxPlayers: 6, funding: "pooled", split: [100], startsAt: new Date(Date.now() + 3_600_000) }).returning();
    const payer = await makeUser(nextName("owpayer"));
    await fund(payer, potKobo);
    await db.transaction((tx) => ledger.post(tx, { userId: payer.id, kind: "cash", amountKobo: -potKobo, type: "party_entry", refType: "party", refId: party.id, idempotencyKey: `t:owed:entry:${party.id}` }));
    return party;
  }

  it("winnings repay what's owed first, as their own movement; the wallet shows the rest; withdrawals wait, playing doesn't", async () => {
    const { u, account, payout, c } = await owing("owwin");
    const owed = payout.amountKobo;
    const wallet = (await app.inject({ method: "GET", url: "/wallet", headers: as(u) })).json();
    expect(wallet.owed).toEqual({ amountKobo: owed, reason: "duplicate_payout" });
    expect((await app.inject({ method: "GET", url: "/me", headers: as(u) })).json().canWithdraw).toBe(false);
    await expect(request(u, account.id, kobo(1500))).rejects.toMatchObject({ message: "withdraw_not_allowed", details: { reason: "amount_owed" } });

    const party = await partyWithPot(kobo(5000));
    await db.transaction((tx) => ledger.post(tx, { userId: u.id, kind: "cash", amountKobo: kobo(600), type: "party_prize", refType: "party", refId: party.id, idempotencyKey: `t:owed:prize:${party.id}` }));
    expect(await cash(u)).toBe(0); // all of it repaid
    expect(await ledger.owedKobo(db, u.id)).toBe(owed - kobo(600));
    const [r] = await repayments(u.id);
    expect([r.idempotencyKey, r.amountKobo]).toEqual([`owed_repay:${u.id}:t:owed:prize:${party.id}:${c.id}`, -kobo(600)]);
    expect(r.journalId).not.toBe((await entriesFor(`t:owed:prize:${party.id}`))[0].journalId); // its own movement

    // Bonus coins never repay; and playing isn't blocked (an entry from bonus).
    await db.transaction((tx) => ledger.post(tx, { userId: u.id, kind: "bonus", amountKobo: kobo(300), type: "welcome_bonus", idempotencyKey: `t:owed:bonus:${u.id}` }));
    expect(await ledger.owedKobo(db, u.id)).toBe(owed - kobo(600));
    await db.transaction((tx) => ledger.charge(tx, { userId: u.id, amountKobo: kobo(200), type: "party_entry", refType: "party", refId: party.id, idempotencyKey: `t:owed:play:${u.id}` }));
    expect(await ledger.balances(u.id)).toEqual({ cashKobo: 0, bonusKobo: kobo(100) });
    expect(await findBreaches(db)).toEqual([]);
  });

  it("one journal crediting two people who both owe repays each of them (the key carries the user)", async () => {
    const [x, y] = [await owing("owtwo1"), await owing("owtwo2")];
    await db.transaction((tx) => ledger.journal(tx, {
      type: "topup", idempotencyKey: `t:owed:two:${x.u.id}`,
      legs: [{ account: { system: "dev_mint" }, amountKobo: -kobo(700) }, { account: { userId: x.u.id, kind: "cash" }, amountKobo: kobo(300) }, { account: { userId: y.u.id, kind: "cash" }, amountKobo: kobo(400) }],
    }));
    expect([await ledger.owedKobo(db, x.u.id), await ledger.owedKobo(db, y.u.id)]).toEqual([x.payout.amountKobo - kobo(300), y.payout.amountKobo - kobo(400)]);
    expect([await cash(x.u), await cash(y.u)]).toEqual([0, 0]);
    expect(await findBreaches(db)).toEqual([]);
  });

  it("a refund repays it", async () => {
    const party = await partyWithPot(kobo(100));
    // Cash held for a host prize before the freeze, so none of it is held for the contradiction.
    const x = await contradicted("owrefund", 0, (u) => db.transaction((tx) => ledger.hold(tx, { userId: u.id, amountKobo: kobo(500), type: "party_fund", refType: "party", refId: party.id, idempotencyKey: `t:owed:hold:${party.id}` })));
    await resolve(admin, x.c.id);
    expect((await confirmIt(admin2, x.c.id)).json().contradiction.recoveredKobo).toBe(0);
    await db.transaction((tx) => ledger.release(tx, { holdKey: `t:owed:hold:${party.id}`, type: "party_refund", refType: "party", refId: party.id, idempotencyKey: `t:owed:release:${party.id}` }));
    expect(await cash(x.u)).toBe(0);
    expect(await ledger.owedKobo(db, x.u.id)).toBe(x.payout.amountKobo - kobo(500));
  });

  it("top-ups repay it, partly and then in full, and the rest is theirs; then they can withdraw", async () => {
    const { u, account, payout } = await owing("owtopup");
    const owed = payout.amountKobo;
    const topUp = async (amountKobo: number) => {
      const t = await createTopup(u, amountKobo, { returnUrl: null });
      await mock.completeCheckout(t.reference, "pay");
      expect(await confirmTopup(t.id, "check")).toBe("credited");
    };
    await topUp(kobo(1000)); // less than owed: all of it repays
    expect([await cash(u), await ledger.owedKobo(db, u.id)]).toEqual([0, owed - kobo(1000)]);
    await topUp(kobo(2000)); // more than what's left: the rest is cash
    expect([await cash(u), await ledger.owedKobo(db, u.id)]).toEqual([kobo(3000) - owed, 0]);
    expect((await app.inject({ method: "GET", url: "/wallet", headers: as(u) })).json().owed).toBeNull();
    expect((await repayments(u.id)).reduce((a, e) => a + Number(e.amountKobo), 0)).toBe(-owed);
    const [fresh] = await db.select().from(users).where(eq(users.id, u.id));
    await fund(u, kobo(2000));
    expect((await request(fresh, account.id, kobo(1500))).payout.status).toBe("requested");
    expect(await findBreaches(db)).toEqual([]);
  });

  it("a waiver takes two admins and a reason; the platform bears it; never more than is owed when confirmed", async () => {
    const { u, payout } = await owing("owwaive");
    const waive = (who: User, reason?: string) => app.inject({ method: "POST", url: `/admin/payments/users/${u.id}/owed/waive`, headers: as(who), payload: reason ? { reason } : {} });
    expect((await waive(admin)).statusCode).toBe(400); // a reason is required
    expect((await waive(viewer, "support ticket 12")).statusCode).toBe(403);
    const asked = (await waive(admin, "support ticket 12: bank confirmed one transfer")).json().waiver;
    expect(asked).toMatchObject({ status: "awaiting_second_admin", amountKobo: payout.amountKobo });
    expect((await waive(admin2, "again")).json().error).toBe("waiver_pending");
    expect(await ledger.owedKobo(db, u.id)).toBe(payout.amountKobo);
    const confirm = (who: User) => app.inject({ method: "POST", url: `/admin/payments/owed-waivers/${asked.id}/confirm`, headers: as(who) });
    expect((await confirm(admin)).json().error).toBe("second_admin_required");
    // Partly repaid between the ask and the confirm: only what's left is waived.
    await db.transaction((tx) => ledger.post(tx, { userId: u.id, kind: "cash", amountKobo: kobo(100), type: "topup", idempotencyKey: `t:owed:mint:${u.id}` }));
    const done = (await confirm(admin2)).json().waiver;
    expect(done).toMatchObject({ status: "applied", waivedKobo: payout.amountKobo - kobo(100), confirmedBy: admin2.id });
    expect(await ledger.owedKobo(db, u.id)).toBe(0);
    expect((await app.inject({ method: "GET", url: "/admin/payments/owed", headers: as(viewer) })).json().owed.some((o: { userId: string }) => o.userId === u.id)).toBe(false);
    const log = await db.select().from(adminActions).where(eq(adminActions.targetId, u.id));
    expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(["payments.owed_waiver_requested", "payments.owed_waived"]));
    expect(log.find((l) => l.action === "payments.owed_waived")?.reason).toBe("support ticket 12: bank confirmed one transfer");
    expect((await waive(admin, "nothing left")).json().error).toBe("nothing_owed");
    // Their own: never.
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, u.id));
    await db.insert(adminPermissions).values({ userId: u.id, permission: "payments.finalize" });
    expect((await app.inject({ method: "POST", url: `/admin/payments/users/${u.id}/owed/waive`, headers: as(u), payload: { reason: "mine" } })).json().error).toBe("own_transaction");
    expect(await findBreaches(db)).toEqual([]);
  });

  it("a provider answer that flips again after a dissolve or a resolve raises a critical alert and moves nothing", async () => {
    // Dissolved (the provider said reversed), then it says paid again.
    const d = await contradicted("crlate1", kobo(10_000));
    await resolve(admin, d.c.id);
    const td = (await mock.getTransfer(d.payout.reference))!;
    await mock.setTransfer(d.payout.reference, { ...td, state: "failed" });
    expect((await confirmIt(admin2, d.c.id)).json().contradiction.status).toBe("dissolved");
    const before = [await cash(d.u), await held(d.u), await ledger.owedKobo(db, d.u.id)];
    await mock.setTransfer(d.payout.reference, { ...td, state: "success" });
    await checkPayout(d.payout.id, "check");
    expect((await alertsFor(d.payout.id)).find((a) => a.kind === "payments.payout_success_after_dissolve")?.severity).toBe("critical");
    expect([await cash(d.u), await held(d.u), await ledger.owedKobo(db, d.u.id)]).toEqual(before);
    expect((await db.select().from(users).where(eq(users.id, d.u.id)))[0].withdrawalsFrozenAt).toBeNull();
    // Resolved (still paid), then it says reversed.
    const r = await contradicted("crlate2", kobo(10_000));
    await resolve(admin, r.c.id);
    expect((await confirmIt(admin2, r.c.id)).json().contradiction.status).toBe("resolved");
    const cashBefore = await cash(r.u);
    const tr = (await mock.getTransfer(r.payout.reference))!;
    await mock.setTransfer(r.payout.reference, { ...tr, state: "failed" });
    await checkPayout(r.payout.id, "check");
    expect((await alertsFor(r.payout.id)).find((a) => a.kind === "payments.payout_reversed_after_resolve")?.severity).toBe("critical");
    expect(await cash(r.u)).toBe(cashBefore);
    expect(await findBreaches(db)).toEqual([]);
  });

  it("no waiver while a contradiction is open (request or confirm)", async () => {
    const { u, c } = await contradicted("crnowaive", 0);
    const asked = await app.inject({ method: "POST", url: `/admin/payments/users/${u.id}/owed/waive`, headers: as(admin), payload: { reason: "they're broke" } });
    expect([asked.statusCode, asked.json().error, asked.json().details.contradictionId]).toEqual([409, "contradiction_open", c.id]);
  });

  it("a dissolve pays back only what was taken: held cash and repayments; a waived part goes back to the platform", async () => {
    const { u, payout, c } = await contradicted("crwaivedis", kobo(400)); // held ₦400 from cash; ₦1,100.11 owed
    const party = await partyWithPot(kobo(5000));
    await db.transaction((tx) => ledger.post(tx, { userId: u.id, kind: "cash", amountKobo: kobo(300), type: "party_prize", refType: "party", refId: party.id, idempotencyKey: `t:cr:wd:prize:${u.id}` })); // repays ₦300
    // A waiver of ₦500 against this debt, written the way one applied before waivers waited for contradictions to close.
    await db.transaction((tx) => ledger.journal(tx, { type: "owed_waived", refType: "contradiction", refId: c.id, idempotencyKey: `t:cr:wd:waive:${c.id}`,
      legs: [{ account: ledger.owedAccount(u.id), amountKobo: kobo(500) }, { account: { system: "platform_funds" }, amountKobo: -kobo(500) }] }));
    expect(await ledger.owedKobo(db, u.id)).toBe(payout.amountKobo - kobo(400) - kobo(300) - kobo(500));
    const [funds] = await db.select().from(ledgerAccounts).where(eq(ledgerAccounts.kind, "platform_funds"));
    await resolve(admin, c.id);
    const t = (await mock.getTransfer(payout.reference))!;
    await mock.setTransfer(payout.reference, { ...t, state: "failed" });
    expect((await confirmIt(admin2, c.id)).json().contradiction.status).toBe("dissolved");
    expect([await cash(u), await ledger.owedKobo(db, u.id), await held(u)]).toEqual([kobo(400) + kobo(300), 0, 0]); // never the waived ₦500
    const [fundsAfter] = await db.select().from(ledgerAccounts).where(eq(ledgerAccounts.id, funds.id));
    expect(fundsAfter.balanceKobo - funds.balanceKobo).toBe(kobo(500));
    expect(await findBreaches(db)).toEqual([]);
  });

  it("a dissolve racing a prize that repays the debt reads it under the owed account's lock: nobody loses the prize", async () => {
    const { u, payout, c } = await contradicted("crrace", kobo(300)); // held ₦300; ₦1,200.11 owed
    await resolve(admin, c.id);
    const t = (await mock.getTransfer(payout.reference))!;
    await mock.setTransfer(payout.reference, { ...t, state: "failed" });
    const party = await partyWithPot(kobo(5000));
    let dissolve: Promise<{ json(): { contradiction: { status: string } } }> | undefined;
    await db.transaction(async (tx) => {
      await ledger.post(tx, { userId: u.id, kind: "cash", amountKobo: kobo(200), type: "party_prize", refType: "party", refId: party.id, idempotencyKey: `t:cr:race:${u.id}` }); // repays ₦200, uncommitted
      dissolve = confirmIt(admin2, c.id);
      await new Promise((r) => setTimeout(r, 300));
    });
    expect((await dissolve!).json().contradiction.status).toBe("dissolved");
    expect([await cash(u), await ledger.owedKobo(db, u.id), await held(u)]).toEqual([kobo(300) + kobo(200), 0, 0]);
    expect(await findBreaches(db)).toEqual([]);
  });

  it("deleting the account is blocked while money is owed or a contradiction is open, with plain messages", async () => {
    const open = await contradicted("crdelopen", kobo(10_000)); // all held, nothing owed, still open
    expect((await app.inject({ method: "GET", url: "/me/deletion", headers: as(open.u) })).json().blockers).toEqual(expect.arrayContaining([
      { code: "payment_issue", message: "You have an open payment issue. Contact support" },
    ]));
    const { u } = await owing("crdelowe"); // resolved, ₦1,500.11 still owed
    expect((await app.inject({ method: "GET", url: "/me/deletion", headers: as(u) })).json().blockers).toEqual([
      { code: "amount_owed", message: "You owe money from a duplicate payout. Contact support" },
    ]);
  });

  it("a new account with a deleted debtor's email or phone can't withdraw until an admin clears it", async () => {
    const { u } = await owing("crreuse");
    const phoneHmac = `hmac-${tag}-${u.id.slice(0, 8)}`;
    await db.update(users).set({ phoneHmac }).where(eq(users.id, u.id));
    const [old] = await db.select().from(users).where(eq(users.id, u.id));
    await db.transaction((tx) => archiveAccount(tx, old, null)); // deleted before deletion checked for debts (or the debt came after)
    // Same email, signed up again.
    const again = await withdrawer("crreuse2", kobo(10_000), { email: old.email });
    await expect(request((await db.select().from(users).where(eq(users.id, again.u.id)))[0], again.account.id, kobo(1500))).rejects.toMatchObject({ details: { reason: "linked_payment_issue" } });
    expect((await app.inject({ method: "GET", url: "/me", headers: as(again.u) })).json().canWithdraw).toBe(false);
    // Same phone, different email.
    const byPhone = await withdrawer("crreuse3", kobo(10_000), { phoneHmac });
    await expect(request((await db.select().from(users).where(eq(users.id, byPhone.u.id)))[0], byPhone.account.id, kobo(1500))).rejects.toMatchObject({ details: { reason: "linked_payment_issue" } });
    // An admin checks and asks to clear it: nothing changes until a different admin confirms.
    const asked = await app.inject({ method: "POST", url: `/admin/payments/users/${again.u.id}/clear-linked-issue`, headers: as(admin), payload: { reason: "different person: checked ID with support" } });
    expect([asked.statusCode, asked.json().clearance.status]).toEqual([202, "awaiting_second_admin"]);
    const fresh = async () => (await db.select().from(users).where(eq(users.id, again.u.id)))[0];
    await expect(request(await fresh(), again.account.id, kobo(1500))).rejects.toMatchObject({ details: { reason: "linked_payment_issue" } });
    const confirm = (who: User) => app.inject({ method: "POST", url: `/admin/payments/linked-issue-clearances/${asked.json().clearance.id}/confirm`, headers: as(who) });
    expect((await confirm(admin)).json().error).toBe("second_admin_required");
    // Neither admin may be the account holder.
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, again.u.id));
    await db.insert(adminPermissions).values({ userId: again.u.id, permission: "payments.finalize" });
    expect((await confirm(again.u)).json().error).toBe("own_transaction");
    expect((await app.inject({ method: "POST", url: `/admin/payments/users/${byPhone.u.id}/clear-linked-issue`, headers: as(byPhone.u), payload: { reason: "it's me, honest" } })).json().error).toBe("admin_only");
    await expect(requestLinkedIssueClearance(again.u.id, again.u.id, "it's me, honest")).rejects.toMatchObject({ message: "own_transaction" }); // an admin holder can't ask for their own
    expect((await confirm(admin2)).json().clearance).toMatchObject({ status: "applied", confirmedBy: admin2.id });
    expect((await request(await fresh(), again.account.id, kobo(1500))).payout.status).toBe("requested");
    const [log] = await db.select().from(adminActions).where(and(eq(adminActions.targetId, again.u.id), eq(adminActions.action, "payments.linked_issue_cleared")));
    expect([log.adminUserId, (log.after as { requestedBy: string }).requestedBy]).toEqual([admin2.id, admin.id]);
    expect((await confirm(admin2)).json().error).toBe("clearance_not_pending");
    expect(log.after).toMatchObject({ coveredUserIds: [u.id] });
    // A clearance covers the accounts it was checked against: another deleted debtor matching later blocks again.
    const second = await owing("crreuse4");
    await db.update(users).set({ email: `second-${tag}@test.contestly.invalid` }).where(eq(users.id, second.u.id));
    await db.update(users).set({ phoneHmac: `hmac2-${tag}` }).where(eq(users.id, second.u.id));
    await db.transaction(async (tx) => archiveAccount(tx, (await tx.select().from(users).where(eq(users.id, second.u.id)))[0], null));
    await db.update(users).set({ phoneHmac: `hmac2-${tag}` }).where(eq(users.id, again.u.id)); // they verify the other account's old number
    await expect(request(await fresh(), again.account.id, kobo(1500))).rejects.toMatchObject({ details: { reason: "linked_payment_issue" } });
  });

  it("a deleted account whose contradiction dissolved (the transfer came back) blocks nobody who gets its number", async () => {
    const { u, payout, c } = await contradicted("crinnocent", kobo(10_000));
    await resolve(admin, c.id);
    const t = (await mock.getTransfer(payout.reference))!;
    await mock.setTransfer(payout.reference, { ...t, state: "failed" });
    expect((await confirmIt(admin2, c.id)).json().contradiction.status).toBe("dissolved");
    await db.update(users).set({ phoneHmac: `hmac-inn-${tag}` }).where(eq(users.id, u.id));
    await db.transaction(async (tx) => {
      const [x] = await tx.select().from(users).where(eq(users.id, u.id));
      await ledger.post(tx, { userId: u.id, kind: "cash", amountKobo: -(await ledger.balances(u.id)).cashKobo, type: "topup", idempotencyKey: `t:inn:spend:${u.id}` });
      await archiveAccount(tx, x, null);
    });
    const stranger = await withdrawer("crinnocent2", kobo(10_000), { phoneHmac: `hmac-inn-${tag}` }); // the carrier gave them the number
    expect((await request((await db.select().from(users).where(eq(users.id, stranger.u.id)))[0], stranger.account.id, kobo(1500))).payout.status).toBe("requested");
  });

  it("a Gmail alias of a deleted debtor's address matches it (dots and +tags dropped)", async () => {
    const { u } = await owing("cralias");
    await db.update(users).set({ email: `pay.${tag}.alias@gmail.com` }).where(eq(users.id, u.id));
    const [old] = await db.select().from(users).where(eq(users.id, u.id));
    await db.transaction((tx) => archiveAccount(tx, old, null));
    expect((await db.select().from(users).where(eq(users.id, u.id)))[0].archivedEmailKey).toBe(`pay${tag}alias@gmail.com`);
    const alias = await withdrawer("cralias2", kobo(10_000), { email: `PAY${tag}ALIAS+again@googlemail.com`.toLowerCase() });
    await expect(request((await db.select().from(users).where(eq(users.id, alias.u.id)))[0], alias.account.id, kobo(1500))).rejects.toMatchObject({ details: { reason: "linked_payment_issue" } });
  });

  it("the archive retention keeps a deleted account's email and phone hash while it still has a payment issue", async () => {
    const { u } = await owing("crkeep");
    await db.update(users).set({ phoneHmac: `hmac-keep-${tag}` }).where(eq(users.id, u.id));
    const [owes] = await db.select().from(users).where(eq(users.id, u.id));
    await db.transaction((tx) => archiveAccount(tx, owes, null));
    const clean = await makeUser(nextName("crkeepok"));
    await db.transaction((tx) => archiveAccount(tx, clean, null));
    await clearExpiredArchives(new Date(Date.now() + 3600_000));
    const [kept] = await db.select().from(users).where(eq(users.id, u.id));
    expect([kept.archivedEmailKey, kept.archivedPhoneHmac, kept.archiveClearedAt]).toEqual([owes.email, `hmac-keep-${tag}`, null]);
    const [gone] = await db.select().from(users).where(eq(users.id, clean.id));
    expect([gone.archivedEmail, gone.archivedEmailKey, gone.archiveClearedAt !== null]).toEqual([null, null, true]);
    // Once nothing is owed, a later run clears it.
    await db.transaction((tx) => ledger.journal(tx, { type: "topup", idempotencyKey: `t:keep:pay:${u.id}`, legs: [{ account: { system: "dev_mint" }, amountKobo: -(kobo(1500) + 11) }, { account: { userId: u.id, kind: "cash" }, amountKobo: kobo(1500) + 11 }] }));
    expect(await ledger.owedKobo(db, u.id)).toBe(0);
    await clearExpiredArchives(new Date(Date.now() + 3600_000));
    expect((await db.select().from(users).where(eq(users.id, u.id)))[0].archivedPhoneHmac).toBeNull();
  });

  it("one rule: a deleted account blocks a matched new account exactly while retention keeps its archive (owed, held, open; not resolved-and-repaid, not dissolved)", async () => {
    const cases: [string, () => Promise<User>, boolean][] = [
      ["owes", async () => (await owing("rule1")).u, true],
      ["open, money held", async () => (await contradicted("rule2", kobo(10_000))).u, true],
      ["resolved, the hold recovered in full", async () => {
        const { u, c } = await contradicted("rule3", kobo(10_000));
        await resolve(admin, c.id);
        await confirmIt(admin2, c.id);
        return u;
      }, false],
      ["resolved, owed, then repaid in full", async () => {
        const { u } = await owing("rule4");
        await db.transaction((tx) => ledger.journal(tx, { type: "topup", idempotencyKey: `t:rule:repay:${u.id}`, legs: [{ account: { system: "dev_mint" }, amountKobo: -(kobo(1500) + 11) }, { account: { userId: u.id, kind: "cash" }, amountKobo: kobo(1500) + 11 }] }));
        expect(await ledger.owedKobo(db, u.id)).toBe(0);
        return u;
      }, false],
      ["dissolved", async () => {
        const { u, payout, c } = await contradicted("rule5", kobo(10_000));
        await resolve(admin, c.id);
        await mock.setTransfer(payout.reference, { ...(await mock.getTransfer(payout.reference))!, state: "failed" });
        expect((await confirmIt(admin2, c.id)).json().contradiction.status).toBe("dissolved");
        return u;
      }, false],
      ["never had one", async () => (await withdrawer("rule6")).u, false],
    ];
    const accounts: [string, User, string, boolean][] = [];
    for (const [what, make, issue] of cases) {
      const u = await make();
      const phoneHmac = `hmac-rule-${tag}-${u.id.slice(0, 8)}`;
      await db.update(users).set({ phoneHmac }).where(eq(users.id, u.id));
      await db.transaction(async (tx) => archiveAccount(tx, (await tx.select().from(users).where(eq(users.id, u.id)))[0], null));
      accounts.push([what, u, phoneHmac, issue]);
    }
    await clearExpiredArchives(new Date(Date.now() + 3600_000));
    for (const [what, u, phoneHmac, issue] of accounts) {
      const blocks = (await linkedIssueAccounts(db, { id: randomUUID(), email: null, phoneHmac })).includes(u.id);
      const [row] = await db.select().from(users).where(eq(users.id, u.id));
      const kept = row.archiveClearedAt === null;
      expect([what, blocks, kept, await accountHasPaymentIssue(db, u.id)]).toEqual([what, issue, issue, issue]);
    }
  });

  it("nobody resolves their own", async () => {
    const { u, c } = await contradicted("crown", kobo(10_000));
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, u.id));
    await db.insert(adminPermissions).values({ userId: u.id, permission: "payments.finalize" });
    expect((await resolve(u, c.id)).json().error).toBe("own_transaction");
    await resolve(admin, c.id);
    expect((await confirmIt(u, c.id)).json().error).toBe("own_transaction");
  });
});

describe("the lock order: the person's row, then transaction rows, then the person's accounts, then platform accounts", () => {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** Runs `fn` while another transaction holds the person's row: it must wait for it (it locks the person first), then finish. */
  async function waitsForPerson(userId: string, fn: () => Promise<unknown>) {
    let finished = false;
    let run: Promise<unknown> | undefined;
    await db.transaction(async (tx) => {
      await tx.select().from(users).where(eq(users.id, userId)).for("no key update");
      run = fn().then((v) => { finished = true; return v; });
      await pause(300);
      expect(finished).toBe(false);
    });
    const out = await run!;
    expect(finished).toBe(true);
    return out;
  }
  /** Whether another transaction holds this ledger account's row lock right now. */
  async function isLocked(accountId: string) {
    try {
      await db.transaction(async (tx) => { await tx.execute(sqlRaw`select id from ledger_accounts where id = ${accountId} for update nowait`); });
      return false;
    } catch (e) {
      if ((e as { code?: string }).code === "55P03") return true;
      throw e;
    }
  }

  it("account deletion reads the bonus it forfeits under the lock it posts under: a credit committing meanwhile is forfeited too", async () => {
    const u = await makeUser(nextName("lkdel"));
    await db.transaction((tx) => ledger.post(tx, { userId: u.id, kind: "bonus", amountKobo: kobo(100), type: "welcome_bonus", idempotencyKey: `t:lk:del:1:${u.id}` }));
    let archived: Promise<{ forfeitedBonusKobo: number }> | undefined;
    await db.transaction(async (tx) => {
      await ledger.post(tx, { userId: u.id, kind: "bonus", amountKobo: kobo(50), type: "welcome_bonus", idempotencyKey: `t:lk:del:2:${u.id}` }); // uncommitted
      archived = db.transaction(async (t2) => archiveAccount(t2, (await t2.select().from(users).where(eq(users.id, u.id)))[0], null));
      await pause(300);
    });
    expect((await archived!).forfeitedBonusKobo).toBe(kobo(150));
    expect((await ledger.balances(u.id)).bonusKobo).toBe(0);
  });

  it("a deadlock between two money transactions is retried (bounded, logged) and both finish", async () => {
    const [a, b] = [await makeUser(nextName("dla")), await makeUser(nextName("dlb"))];
    await fund(a, kobo(10));
    await fund(b, kobo(10));
    const acct = async (u: User) => (await db.select().from(ledgerAccounts).where(and(eq(ledgerAccounts.userId, u.id), eq(ledgerAccounts.kind, "cash"))))[0].id;
    const [x, y] = [await acct(a), await acct(b)];
    const retries: string[] = [];
    let firstTry = true;
    const crossing = (first: string, second: string) => moneyTransaction(async (tx) => {
      await tx.execute(sqlRaw`select id from ledger_accounts where id = ${first} for update`);
      if (firstTry) await pause(200); // only the first round crosses
      await tx.execute(sqlRaw`select id from ledger_accounts where id = ${second} for update`);
      return "done";
    }, { label: "test", onRetry: (_n, code) => { retries.push(code); firstTry = false; } });
    expect(await Promise.all([crossing(x, y), crossing(y, x)])).toEqual(["done", "done"]);
    expect(retries).toEqual(["40P01"]);
    // Bounded: a transaction that keeps failing gives up after its attempts, with the error.
    let tries = 0;
    await expect(moneyTransaction(async () => { tries++; throw Object.assign(new Error("deadlock detected"), { code: "40P01" }); }, { attempts: 3 })).rejects.toThrow("deadlock detected");
    expect(tries).toBe(3);
  });

  it("settle and refund jobs (the party queue) retry with exponential backoff; the deadlock retry above reads Postgres' code through drizzle (an upgrade that wraps errors would fail it)", async () => {
    const q = partyQueue();
    try {
      expect((q as unknown as { opts: { defaultJobOptions: unknown } }).opts.defaultJobOptions).toMatchObject({ attempts: 5, backoff: { type: "exponential" } });
    } finally {
      await q.close();
    }
  });

  it("an alert raised in a transaction that's retried is recorded once and logged once, after the commit", async () => {
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let attempt = 0;
      const key = `t:retry-alert:${tag}`;
      await moneyTransaction(async (tx) => {
        attempt++;
        await adminAlert({ severity: "warning", kind: "payments.test_retry_alert", subject: "test", dedupeKey: key, details: { attempt } }, tx);
        if (attempt === 1) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      });
      expect(attempt).toBe(2);
      expect(await db.select().from(adminAlerts).where(eq(adminAlerts.dedupeKey, key))).toHaveLength(1);
      expect(logged.mock.calls.filter((c) => String(c[0]).includes("test_retry_alert"))).toHaveLength(1);
    } finally {
      logged.mockRestore();
    }
  });

  it("an after-commit effect that throws doesn't fail the committed transaction: logged and alerted, the caller gets its result, later effects still run", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const label = `test after-commit ${tag}`;
    const ran: string[] = [];
    try {
      const out = await moneyTransaction(async (tx) => {
        afterCommit(tx, () => { throw new Error("push provider down"); });
        afterCommit(tx, async () => { ran.push("second"); });
        return "committed";
      }, { label });
      expect([out, ran]).toEqual(["committed", ["second"]]);
      const [alert] = await db.select().from(adminAlerts).where(eq(adminAlerts.dedupeKey, `after_commit_effect_failed:${label}`));
      expect(alert).toMatchObject({ kind: "after_commit_effect_failed", severity: "warning", details: { label, error: "push provider down" } });
      expect(logged.mock.calls.some((c) => String(c[0]).includes("after-commit effect failed"))).toBe(true);
    } finally {
      logged.mockRestore();
    }
  });

  it("approve and reject take the person first", async () => {
    await config((c) => { c.payout.approvalThresholdKobo = kobo(2000); });
    try {
      const a = await withdrawer("lkappr");
      const big = (await request(a.u, a.account.id, kobo(2500))).payout;
      expect((await waitsForPerson(a.u.id, () => approvePayout(admin.id, big.id, deps)) as Payout).status).toBe("requested");
      const b = await withdrawer("lkrej");
      const other = (await request(b.u, b.account.id, kobo(2500))).payout;
      expect((await waitsForPerson(b.u.id, () => rejectPayout(admin.id, other.id, "looks wrong")) as Payout).status).toBe("rejected");
      expect(await cash(b.u)).toBe(kobo(10_000));
    } finally {
      await config(() => {});
    }
  });

  it("a manual finalize and its confirm take the person first", async () => {
    const w = await withdrawer("lkfin", kobo(100_000));
    const { payout } = await request(w.u, w.account.id, kobo(1500) + 14);
    const longAgo = new Date(Date.now() - 2 * 3600_000);
    await db.update(payouts).set({ status: "unknown", submittedAt: longAgo, lastSentAt: longAgo, sendAttempts: 1 }).where(eq(payouts.id, payout.id));
    const f = await waitsForPerson(w.u.id, () => requestFinalization(admin.id, { type: "payout", id: payout.id }, "failed", "provider says nothing")) as { id: string; status: string };
    expect(f.status).toBe("awaiting_second_admin"); // not found: a second admin
    await mock.setTransfer(payout.reference, { amountKobo: payout.sentKobo, recipientCode: "RCP_x", state: "failed", createdAt: Date.now(), queries: 0 });
    expect(((await waitsForPerson(w.u.id, () => confirmFinalization(admin2.id, f.id))) as { status: string }).status).toBe("applied");
    expect((await reload(payout.id)).status).toBe("failed");
  });

  it("a waiver takes the person first; a cash credit locks what they owe before any platform account", async () => {
    const { u, account } = await withdrawer("lkowe", 0);
    // Owing, the plain way: a contradiction with no cash to hold.
    await fund(u, kobo(1500) + 11);
    const { payout } = await request(u, account.id, kobo(1500) + 11);
    expect(await submitPayout(payout.id)).toBe("failed");
    await db.transaction((tx) => ledger.post(tx, { userId: u.id, kind: "cash", amountKobo: -(kobo(1500) + 11), type: "topup", idempotencyKey: `t:lk:spend:${u.id}` }));
    await mock.setTransfer(payout.reference, { amountKobo: payout.sentKobo, recipientCode: "RCP_x", state: "success", createdAt: Date.now(), queries: 0 });
    await checkPayout(payout.id, "check");
    expect(await ledger.owedKobo(db, u.id)).toBe(kobo(1500) + 11);

    // A credit to them, while a platform account it needs (the dev mint) is held elsewhere: by then it already
    // holds their cash and their owed account.
    const [cashAcct] = await db.select().from(ledgerAccounts).where(and(eq(ledgerAccounts.userId, u.id), eq(ledgerAccounts.kind, "cash")));
    const [owedAcct] = await db.select().from(ledgerAccounts).where(and(eq(ledgerAccounts.kind, "payout_owed"), eq(ledgerAccounts.scope, u.id)));
    let credit: Promise<unknown> | undefined;
    await db.transaction(async (tx) => {
      await tx.execute(sqlRaw`select id from ledger_accounts where kind = 'dev_mint' for update`);
      credit = db.transaction((t2) => ledger.post(t2, { userId: u.id, kind: "cash", amountKobo: kobo(100), type: "topup", idempotencyKey: `t:lk:credit:${u.id}` }));
      await pause(300);
      expect([await isLocked(cashAcct.id), await isLocked(owedAcct.id)]).toEqual([true, true]);
    });
    await credit;
    expect(await ledger.owedKobo(db, u.id)).toBe(kobo(1400) + 11);

    // Waivers wait for the contradiction to close: resolve it (the provider still says paid).
    const [c] = await db.select().from(payoutContradictions).where(eq(payoutContradictions.payoutId, payout.id));
    await app.inject({ method: "POST", url: `/admin/payments/contradictions/${c.id}/resolve`, headers: as(admin), payload: { reason: "confirmed paid" } });
    expect((await app.inject({ method: "POST", url: `/admin/payments/contradictions/${c.id}/confirm`, headers: as(admin2) })).json().contradiction.status).toBe("resolved");
    const asked = await waitsForPerson(u.id, () => requestOwedWaiver(admin.id, u.id, "support ticket: lock order")) as { id: string };
    expect(((await waitsForPerson(u.id, () => confirmOwedWaiver(admin2.id, asked.id))) as { status: string }).status).toBe("applied");
    expect(await ledger.owedKobo(db, u.id)).toBe(0);
    expect(await findBreaches(db)).toEqual([]);
  });
});

describe("permissions", () => {
  it("each permission opens only its own doors, and only a payments.config holder grants them (never to themselves)", async () => {
    const plain = await makeUser(nextName("perm"), { isAdmin: true });
    const doors: [string, string, string][] = [["GET", "/admin/payments", "payments.view"], ["PUT", "/admin/payments/settings", "payments.config"], ["POST", `/admin/payments/payouts/${randomUUID()}/approve`, "payments.approve"], ["POST", `/admin/payments/payouts/${randomUUID()}/finalize`, "payments.finalize"]];
    for (const [method, url, permission] of doors) {
      const res = await app.inject({ method: method as never, url, headers: as(plain), payload: method === "GET" ? undefined : {} });
      expect([res.statusCode, res.json().error, res.json().details.permission], url).toEqual([403, "missing_permission", permission]);
    }
    expect((await app.inject({ method: "GET", url: "/admin/payments", headers: as(viewer) })).statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url: `/admin/payments/permissions/${plain.id}`, headers: as(viewer), payload: { permissions: ["payments.view"], reason: "trying" } })).statusCode).toBe(403);
    const grant = await app.inject({ method: "PUT", url: `/admin/payments/permissions/${plain.id}`, headers: as(admin), payload: { permissions: ["payments.view", "payments.approve"], reason: "joins the payments rota" } });
    expect([grant.statusCode, grant.json().permissions, grant.json().pendingGrant.permissions]).toEqual([202, [], ["payments.approve", "payments.view"]]);
    expect((await app.inject({ method: "GET", url: "/admin/payments", headers: as(plain) })).statusCode).toBe(403); // not until a second admin confirms
    const confirmGrant = (who: User, id: string) => app.inject({ method: "POST", url: `/admin/payments/permission-grants/${id}/confirm`, headers: as(who) });
    const self = await confirmGrant(admin, grant.json().pendingGrant.id);
    expect([self.statusCode, self.json().error]).toEqual([403, "second_admin_required"]);
    expect((await confirmGrant(admin2, grant.json().pendingGrant.id)).json().grant).toMatchObject({ status: "applied", confirmedBy: admin2.id });
    expect((await app.inject({ method: "GET", url: "/admin/payments", headers: as(plain) })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/admin/session", headers: as(plain) })).json().permissions.sort()).toEqual(["payments.approve", "payments.view"]);
    expect((await app.inject({ method: "PUT", url: `/admin/payments/permissions/${admin.id}`, headers: as(admin), payload: { permissions: [], reason: "self" } })).json().error).toBe("cannot_change_own_permissions");
    const notAdmin = await makeUser(nextName("permna"));
    expect((await app.inject({ method: "PUT", url: `/admin/payments/permissions/${notAdmin.id}`, headers: as(admin), payload: { permissions: ["payments.view"], reason: "x y z" } })).json().error).toBe("not_admin");
    const [log] = await db.select().from(adminActions).where(and(eq(adminActions.targetId, plain.id), eq(adminActions.action, "payments.permissions")));
    expect(log.after).toEqual(["payments.approve", "payments.view"]);
    expect(log.adminUserId).toBe(admin2.id);
    // Revoking applies at once, one admin.
    const revoked = await app.inject({ method: "PUT", url: `/admin/payments/permissions/${plain.id}`, headers: as(admin), payload: { permissions: ["payments.view"], reason: "off the rota" } });
    expect([revoked.statusCode, revoked.json().permissions, revoked.json().pendingGrant]).toEqual([200, ["payments.view"], null]);
  });

  /** Narrow the config holders to admin, admin2 and `extra` for one test; restored (unbanned, re-granted) after. */
  async function withHolders(extra: User[], fn: () => Promise<void>) {
    const keep = [admin.id, admin2.id, ...extra.map((u) => u.id)];
    const others = await db.select().from(adminPermissions).where(and(eq(adminPermissions.permission, "payments.config"), notInArray(adminPermissions.userId, keep)));
    await db.delete(adminPermissions).where(and(eq(adminPermissions.permission, "payments.config"), notInArray(adminPermissions.userId, keep)));
    if (extra.length) await db.insert(adminPermissions).values(extra.map((u) => ({ userId: u.id, permission: "payments.config" as const }))).onConflictDoNothing();
    try {
      await fn();
    } finally {
      await db.update(users).set({ bannedAt: null, banReason: null }).where(inArray(users.id, [admin.id, admin2.id]));
      await db.insert(adminPermissions).values([admin, admin2].flatMap((a) => (["payments.view", "payments.approve", "payments.finalize", "payments.config"] as const).map((permission) => ({ userId: a.id, permission })))).onConflictDoNothing();
      if (others.length) await db.insert(adminPermissions).values(others.map((o) => ({ userId: o.userId, permission: o.permission }))).onConflictDoNothing();
    }
  }
  const putPermissions = (who: User, target: User, permissions: string[], reason = "rota change") => app.inject({ method: "PUT", url: `/admin/payments/permissions/${target.id}`, headers: as(who), payload: { permissions, reason } });
  const confirmGrantAs = (who: User, id: string) => app.inject({ method: "POST", url: `/admin/payments/permission-grants/${id}/confirm`, headers: as(who) });

  it("payments.config never goes below two holders: from one of the last three it takes a second admin, from one of the last two it's refused, checked again at the confirm", async () => {
    const third = await makeUser(nextName("permthird"), { isAdmin: true });
    const ops = await makeUser(nextName("permops"), { isAdmin: true }); // no payments.config (dev sessions pass the route's check)
    await withHolders([third], async () => {
      // Revoking anything else is instant.
      const view = await putPermissions(admin, admin2, ["payments.approve", "payments.finalize", "payments.config"]);
      expect([view.statusCode, view.json().permissions]).toEqual([200, ["payments.approve", "payments.config", "payments.finalize"]]);
      // Three holders: taking it from one waits for a second admin. Two such requests at once (different targets).
      const fromThird = await putPermissions(admin, third, []);
      expect([fromThird.statusCode, fromThird.json().pendingGrant.change, fromThird.json().permissions]).toEqual([202, "revoke", ["payments.config"]]);
      const fromAdmin2 = await putPermissions(admin, admin2, ["payments.approve", "payments.finalize"]);
      expect(fromAdmin2.statusCode).toBe(202);
      expect((await confirmGrantAs(admin, fromThird.json().pendingGrant.id)).json().error).toBe("second_admin_required");
      expect((await confirmGrantAs(third, fromThird.json().pendingGrant.id)).json().grant.status).toBe("applied"); // the holder agrees
      // Now two: the other request, asked when there were three, is refused at its confirm.
      const late = await confirmGrantAs(admin2, fromAdmin2.json().pendingGrant.id);
      expect([late.statusCode, late.json().error, late.json().details]).toEqual([409, "config_holder_floor", { floor: 2, holders: 2 }]);
      expect(await permissionsOf(admin2.id)).toContain("payments.config");
      // And a fresh revoke from one of the last two is refused outright, by anyone.
      expect((await putPermissions(admin, admin2, ["payments.view"])).json().error).toBe("config_holder_floor");
      await expect(setPermissions(ops.id, admin.id, ["payments.view"], "rota change")).rejects.toMatchObject({ message: "config_holder_floor" });
      expect(await permissionsOf(admin.id)).toContain("payments.config");
    });
  });

  it("banning a payments admin takes a second admin; banning a config holder takes a confirmer with payments.config and never goes below two holders", async () => {
    const target = await makeUser(nextName("bantgt"), { isAdmin: true });
    const plain1 = await makeUser(nextName("banplain1"), { isAdmin: true });
    const plain2 = await makeUser(nextName("banplain2"), { isAdmin: true });
    const ban = (who: User, u: User) => app.inject({ method: "POST", url: `/admin/users/${u.id}/ban`, headers: as(who), payload: { reason: "suspicious activity" } });
    const confirm = (who: User, id: string) => app.inject({ method: "POST", url: `/admin/users/ban-requests/${id}/confirm`, headers: as(who) });
    const bannedAt = async (u: User) => (await db.select().from(users).where(eq(users.id, u.id)))[0].bannedAt;
    await withHolders([target], async () => {
      // Three holders. Two plain admins ask to ban two of them.
      const askTarget = await ban(plain1, target);
      expect(askTarget.statusCode).toBe(202);
      const askAdmin2 = await ban(plain1, admin2);
      expect(askAdmin2.statusCode).toBe(202);
      expect(await bannedAt(target)).toBeNull();
      const t = askTarget.json().banRequest.id;
      expect((await confirm(plain1, t)).json().error).toBe("second_admin_required");
      expect((await confirm(target, t)).json().error).toBe("own_transaction");
      // A second admin without payments.config can't confirm banning a config holder.
      const noConfig = await confirm(plain2, t);
      expect([noConfig.statusCode, noConfig.json().error, noConfig.json().details]).toEqual([403, "missing_permission", { permission: "payments.config" }]);
      expect((await confirm(admin2, t)).statusCode).toBe(200);
      expect(await bannedAt(target)).not.toBeNull();
      const [log] = await db.select().from(adminActions).where(and(eq(adminActions.targetId, target.id), eq(adminActions.action, "user.ban")));
      expect(log.adminUserId).toBe(admin2.id);
      // Two holders now: the request asked when there were three is refused at the confirm, and a new one up front.
      const late = await confirm(admin, askAdmin2.json().banRequest.id);
      expect([late.statusCode, late.json().error]).toEqual([409, "config_holder_floor"]);
      expect(await bannedAt(admin2)).toBeNull();
      expect((await ban(plain2, admin)).json().error).toBe("config_holder_floor");
    });
    // An admin with no payments permission is still banned by one admin at once.
    const plainAdmin = await makeUser(nextName("banplain"), { isAdmin: true });
    expect((await ban(admin, plainAdmin)).statusCode).toBe(200);
  });

  it("whether a ban needs a second admin is decided under the permissions lock: a grant committing meanwhile is seen", async () => {
    const newcomer = await makeUser(nextName("banrace"), { isAdmin: true });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => { locked = r; });
    // Stands in for a grant's confirm: holds the permissions lock and adds a permission, committing later.
    const grant = db.transaction(async (tx) => {
      await tx.execute(sqlRaw`select pg_advisory_xact_lock(hashtext('payments_permissions'))`);
      await tx.insert(adminPermissions).values({ userId: newcomer.id, permission: "payments.view" });
      locked();
      await held;
    });
    await lockTaken;
    let settled = false;
    const banning = app.inject({ method: "POST", url: `/admin/users/${newcomer.id}/ban`, headers: as(admin), payload: { reason: "suspicious activity" } }).finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false); // waiting on the lock, not deciding on a stale read
    release();
    await grant;
    const res = await banning;
    expect(res.statusCode).toBe(202);
    expect((await db.select().from(users).where(eq(users.id, newcomer.id)))[0].bannedAt).toBeNull();
  });

  it("break-glass grants payments.config from the server: logged as the system with the reason and OS user, and a critical alert", async () => {
    const stuck = await makeUser(nextName("glass"), { isAdmin: true });
    const out = await breakGlassGrantConfig(stuck.handle, "both config holders left; OPS-1", "ops-oncall");
    expect([out.granted, await permissionsOf(stuck.id)]).toEqual([true, ["payments.config"]]);
    const [log] = await db.select().from(adminActions).where(and(eq(adminActions.targetId, stuck.id), eq(adminActions.action, "payments.break_glass")));
    expect(log.adminUserId).toBe(await db.transaction((tx) => systemActorId(tx)));
    expect(log.reason).toBe("both config holders left; OPS-1");
    expect(log.after).toMatchObject({ permissions: ["payments.config"], osUser: "ops-oncall" });
    const [alert] = await alertsFor(stuck.id);
    expect(alert).toMatchObject({ kind: "payments.break_glass", severity: "critical" });
    // Again: nothing changes, nothing more logged. A non-admin, or a banned one, is refused.
    expect((await breakGlassGrantConfig(stuck.handle, "again", "ops-oncall")).granted).toBe(false);
    expect(await db.select().from(adminActions).where(and(eq(adminActions.targetId, stuck.id), eq(adminActions.action, "payments.break_glass")))).toHaveLength(1);
    await expect(breakGlassGrantConfig((await makeUser(nextName("glassna"))).handle, "x y z", "ops")).rejects.toMatchObject({ message: "not_admin" });
    await expect(breakGlassGrantConfig((await makeUser(nextName("glassban"), { isAdmin: true, bannedAt: new Date() })).handle, "x y z", "ops")).rejects.toMatchObject({ message: "banned" });
    await db.delete(adminPermissions).where(eq(adminPermissions.userId, stuck.id)); // TEST-ONLY: keep the holder count as the other tests expect
  });

  it("payments alerts on the admin alerts page: payments.view to see them, payments.finalize to acknowledge them", async () => {
    const { id } = await adminAlert({ severity: "warning", kind: "payments.test_visibility", subject: "visibility test", details: {}, dedupeKey: `t:vis:${tag}` });
    const other = await adminAlert({ severity: "info", kind: "test_visibility_other", subject: "not payments", details: {}, dedupeKey: `t:vis2:${tag}` });
    const plain = await makeUser(nextName("alertplain"), { isAdmin: true });
    const list = async (who: User) => ((await app.inject({ method: "GET", url: "/admin/alerts?state=all&limit=200", headers: as(who) })).json().alerts as { id: string }[]).map((a) => a.id);
    expect(await list(plain)).not.toContain(id);
    expect(await list(plain)).toContain(other.id);
    expect((await app.inject({ method: "GET", url: "/admin/alerts?kind=payments.test_visibility", headers: as(plain) })).json().error).toBe("missing_permission");
    expect(await list(viewer)).toContain(id);
    // The home's counts: payments alerts count only for payments.view.
    const critical = async (who: User) => (await app.inject({ method: "GET", url: "/admin/alerts/summary", headers: as(who) })).json().open.critical as number;
    const [plainBefore, viewerBefore] = [await critical(plain), await critical(viewer)];
    await adminAlert({ severity: "critical", kind: "payments.test_visibility_count", subject: "count test", details: {}, dedupeKey: `t:vis3:${tag}` });
    expect([await critical(plain), await critical(viewer)]).toEqual([plainBefore, viewerBefore + 1]);
    const ack = (who: User) => app.inject({ method: "POST", url: `/admin/alerts/${id}/ack`, headers: as(who), payload: { note: "looked at it" } });
    expect([(await ack(viewer)).statusCode, (await ack(viewer)).json().details.permission]).toEqual([403, "payments.finalize"]);
    expect((await ack(admin)).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/admin/alerts/${other.id}/ack`, headers: as(plain), payload: { note: "fine" } })).statusCode).toBe(200);
  });

  it("GET /admin/payments/pending: every open two-admin request, only what the viewer's permissions cover, never their own, filterable by kind", async () => {
    const all = ["payments.view", "payments.approve", "payments.finalize", "payments.config"] as const;
    const withPerms = async (name: string, perms: readonly (typeof all)[number][]) => {
      const u = await makeUser(nextName(name), { isAdmin: true });
      await db.insert(adminPermissions).values(perms.map((permission) => ({ userId: u.id, permission })));
      return u;
    };
    const asker = await withPerms("pendask", all);
    const finalizer = await withPerms("pendfin", ["payments.view", "payments.finalize"]);
    const configurer = await withPerms("pendcfg", ["payments.view", "payments.config"]);
    const someone = await makeUser(nextName("pendsub"));
    const viewOnlyAdmin = await withPerms("pendban", ["payments.view"]);
    const { u: payer, account } = await withdrawer("pendpay");
    const { payout } = await request(payer, account.id, kobo(1500));
    const base = { reason: "pending list test", status: "awaiting_second_admin" as const, requestedByUserId: asker.id };
    // TEST-ONLY: one open request of each kind, written straight to their tables.
    const [fin] = await db.insert(paymentFinalizations).values({ ...base, targetType: "payout", targetId: payout.id, outcome: "failed", providerCheck: {} }).returning();
    const [waiver] = await db.insert(owedWaivers).values({ ...base, userId: someone.id, amountKobo: 100 }).returning();
    const [contra] = await db.insert(payoutContradictions).values({ payoutId: payout.id, userId: payer.id, amountKobo: payout.amountKobo, status: "awaiting_second_admin", providerCheck: {}, requestedByUserId: asker.id, requestReason: "pending list test", requestedAt: new Date() }).returning();
    const [grant] = await db.insert(paymentPermissionGrants).values({ ...base, userId: someone.id, permissions: ["payments.view"] }).returning();
    const [aboutConfigurer] = await db.insert(paymentPermissionGrants).values({ ...base, userId: configurer.id, permissions: ["payments.approve"] }).returning();
    const openChange = (await db.select().from(paymentConfigChanges).where(and(eq(paymentConfigChanges.kind, "settings"), eq(paymentConfigChanges.status, "awaiting_second_admin"))))[0];
    const [change] = openChange ? [openChange] : await db.insert(paymentConfigChanges).values({ ...base, kind: "settings", before: {}, proposed: {}, loosens: ["test"] }).returning();
    const [ban] = await db.insert(adminBanRequests).values({ ...base, userId: viewOnlyAdmin.id }).returning();
    const [clear] = await db.insert(linkedIssueClearances).values({ ...base, userId: someone.id, coveredUserIds: [payer.id] }).returning();
    const [ack] = await db.insert(invariantAcknowledgments).values({ ...base, kind: "test_pending", items: {}, detail: {} }).returning();
    const mine = new Set([fin.id, waiver.id, contra.id, grant.id, aboutConfigurer.id, change.id, ban.id, clear.id, ack.id]);
    const pending = async (who: User, q = "") => {
      const res = await app.inject({ method: "GET", url: `/admin/payments/pending${q}`, headers: as(who) });
      expect(res.statusCode).toBe(200);
      return (res.json().pending as { id: string; kind: string }[]).filter((p) => mine.has(p.id));
    };
    try {
      expect(await pending(asker)).toEqual([]); // their own: hidden
      expect((await pending(finalizer)).map((p) => p.kind).sort()).toEqual(["admin_ban", "contradiction_resolution", "finalization", "linked_issue_clearance", "owed_waiver"]);
      const forConfig = await pending(configurer);
      expect(forConfig.map((p) => p.kind).sort()).toEqual(["admin_ban", "config_change", "invariant_acknowledgment", "permission_grant"]);
      expect(forConfig.some((p) => p.id === aboutConfigurer.id)).toBe(false); // a grant to them: never theirs to confirm
      const [item] = (await pending(finalizer, "?kind=finalization"));
      expect(item).toMatchObject({
        kind: "finalization", id: fin.id, requestedBy: { id: asker.id, handle: asker.handle }, reason: "pending list test",
        target: { type: "payout", id: payout.id }, confirm: { method: "POST", path: `/admin/payments/finalizations/${fin.id}/confirm` }, permission: "payments.finalize",
      });
      expect((await app.inject({ method: "GET", url: "/admin/payments/pending", headers: as(await makeUser(nextName("pendplain"), { isAdmin: true })) })).statusCode).toBe(403);
      // The confirm route it names works.
      const banItem = (await pending(finalizer, "?kind=admin_ban"))[0] as unknown as { confirm: { path: string } };
      expect((await app.inject({ method: "POST", url: banItem.confirm.path, headers: as(finalizer) })).statusCode).toBe(200);
    } finally {
      // TEST-ONLY: close what this test opened, so no other test finds it pending.
      await db.update(paymentFinalizations).set({ status: "superseded" }).where(eq(paymentFinalizations.id, fin.id));
      await db.update(owedWaivers).set({ status: "superseded" }).where(eq(owedWaivers.id, waiver.id));
      await db.update(payoutContradictions).set({ status: "dissolved" }).where(eq(payoutContradictions.id, contra.id));
      await db.update(paymentPermissionGrants).set({ status: "superseded" }).where(inArray(paymentPermissionGrants.id, [grant.id, aboutConfigurer.id]));
      if (!openChange) await db.update(paymentConfigChanges).set({ status: "superseded" }).where(eq(paymentConfigChanges.id, change.id));
      await db.update(linkedIssueClearances).set({ status: "applied" }).where(eq(linkedIssueClearances.id, clear.id));
      await db.update(invariantAcknowledgments).set({ status: "applied" }).where(eq(invariantAcknowledgments.id, ack.id));
      await db.update(users).set({ bannedAt: null, banReason: null }).where(eq(users.id, viewOnlyAdmin.id));
    }
  });

  it("every console payments response has its shared schema, and parses with it", async () => {
    const { u, account } = await withdrawer("schemas");
    const { payout } = await request(u, account.id, kobo(1500));
    await createTopup(u, kobo(500), { returnUrl: null });
    const reads: [string, { parse(v: unknown): unknown }][] = [
      ["/admin/payments", adminPaymentsOverviewSchema],
      [`/admin/payments/topups?userId=${u.id}`, adminTopupsResponseSchema],
      [`/admin/payments/payouts?userId=${u.id}`, adminPayoutsResponseSchema],
      ["/admin/payments/webhooks", adminWebhooksResponseSchema],
      ["/admin/payments/reconciliation", adminReconciliationResponseSchema],
      [`/admin/payments/payouts/${payout.id}/check`, adminFreshCheckResponseSchema],
      ["/admin/payments/pending", adminPendingResponseSchema],
    ];
    for (const [url, schema] of reads) {
      const res = await app.inject({ method: "GET", url, headers: as(admin) });
      expect(res.statusCode, url).toBe(200);
      expect(() => schema.parse(res.json()), url).not.toThrow();
    }
    expect((adminPayoutsResponseSchema.parse((await app.inject({ method: "GET", url: `/admin/payments/payouts?userId=${u.id}`, headers: as(admin) })).json())).payouts[0].id).toBe(payout.id);
  });

  it("dev admins (DEV_ADMIN_HANDLES) get every payments permission without a reseed: idempotent, logged, never in production", async () => {
    const dev = await makeUser(nextName("devadm"));
    const grant = (env: NodeJS.ProcessEnv = {}) => db.transaction((tx) => grantDevAdmins(tx, [dev.handle], env));
    await expect(grant({ NODE_ENV: "production" })).rejects.toThrow(/never granted in production/);
    expect(await permissionsOf(dev.id)).toEqual([]);
    expect(await grant()).toEqual([{ handle: dev.handle, granted: ["payments.approve", "payments.config", "payments.finalize", "payments.view"] }]);
    expect((await db.select().from(users).where(eq(users.id, dev.id)))[0].isAdmin).toBe(true);
    expect(await grant()).toEqual([{ handle: dev.handle, granted: [] }]); // again: nothing new
    expect(await db.select().from(adminActions).where(and(eq(adminActions.targetId, dev.id), eq(adminActions.action, "payments.dev_admin_grant")))).toHaveLength(1);
    expect(devAdminHandles({ DEV_ADMIN_HANDLES: " Tunde, ada.o ,," })).toEqual(["tunde", "ada.o"]);
    await db.delete(adminPermissions).where(eq(adminPermissions.userId, dev.id)); // TEST-ONLY: keep the config-holder count as the other tests expect
  });

  it("a grantee can't confirm their own grant (one admin can't make a second admin)", async () => {
    const accomplice = await makeUser(nextName("permacc"), { isAdmin: true });
    await db.insert(adminPermissions).values({ userId: accomplice.id, permission: "payments.config" });
    const asked = await app.inject({ method: "PUT", url: `/admin/payments/permissions/${accomplice.id}`, headers: as(admin), payload: { permissions: ["payments.config", "payments.finalize"], reason: "second pair of hands" } });
    expect(asked.statusCode).toBe(202);
    const own = await app.inject({ method: "POST", url: `/admin/payments/permission-grants/${asked.json().pendingGrant.id}/confirm`, headers: as(accomplice) });
    expect([own.statusCode, own.json().error]).toEqual([403, "own_transaction"]);
    expect(await permissionsOf(accomplice.id)).toEqual(["payments.config"]);
    // And nobody grants to themselves.
    expect((await app.inject({ method: "PUT", url: `/admin/payments/permissions/${accomplice.id}`, headers: as(accomplice), payload: { permissions: ["payments.config", "payments.view"], reason: "for myself" } })).json().error).toBe("cannot_change_own_permissions");
  });
});

describe("providers", () => {
  it("switching mid-flight finishes old transactions with their own provider", async () => {
    const w = await withdrawer("swpo");
    const { payout } = await request(w.u, w.account.id, kobo(1500) + 12);
    expect(await submitPayout(payout.id)).toBe("unknown");
    const u = await makeUser(nextName("swtp"));
    const t = await createTopup(u, kobo(500), { returnUrl: null });

    const refused = await app.inject({ method: "PUT", url: "/admin/payments/settings", headers: as(admin), payload: { collections: "paystack", payouts: "paystack", topupsPaused: false, payoutsPaused: false, reason: "move to paystack" } });
    expect([refused.statusCode, refused.json().error]).toEqual([409, "provider_not_configured"]);
    process.env.PAYSTACK_SECRET_KEY = "sk_test_not_used_here";
    resetProviders();
    mock = mockControlsOrNull()!;
    try {
      const asked = await app.inject({ method: "PUT", url: "/admin/payments/settings", headers: as(admin), payload: { collections: "paystack", payouts: "paystack", topupsPaused: false, payoutsPaused: false, reason: "move to paystack" } });
      expect(asked.statusCode).toBe(202); // switching a provider waits for a second admin
      expect(asked.json().change.loosens).toEqual(["collections", "payouts"]);
      const moved = await app.inject({ method: "POST", url: `/admin/payments/config-changes/${asked.json().change.id}/confirm`, headers: as(admin2) });
      expect(moved.json().change.status).toBe("applied");
      expect((await app.inject({ method: "GET", url: "/admin/payments/settings", headers: as(admin) })).json().settings).toMatchObject({ collections: "paystack", payouts: "paystack" });
      let out = await checkPayout(payout.id, "check");
      while (out === "unknown") out = await checkPayout(payout.id, "check");
      expect(out).toBe("succeeded"); // finished by mock, whatever the setting
      await mock.completeCheckout(t.reference, "pay");
      expect(await confirmTopup(t.id, "check")).toBe("credited");
      expect((await db.select().from(topups).where(eq(topups.id, t.id)))[0].provider).toBe("mock");
      // The mock-resolved account can't be used with paystack: resolve it again.
      await expect(request(w.u, w.account.id, kobo(1500))).rejects.toThrow("account_unresolved");
    } finally {
      await settings({ collections: "mock", payouts: "mock" });
      delete process.env.PAYSTACK_SECRET_KEY;
      resetProviders();
      mock = mockControlsOrNull()!;
    }
  });

  it("a live key, or any Paystack key that isn't a test key, outside production refuses to start", async () => {
    for (const [key, why] of [["sk_live_abc", /live payment key/], ["rk_something", /isn't a test key/]] as const) {
      process.env.PAYSTACK_SECRET_KEY = key;
      try {
        await expect(buildApp()).rejects.toThrow(why);
      } finally {
        delete process.env.PAYSTACK_SECRET_KEY;
        resetProviders();
        mock = mockControlsOrNull()!;
      }
    }
  });

  it("without PAYMENTS_DEV_TOOLS: no mock provider, no mock checkout, no dev top-up; and no default mock webhook secret", async () => {
    const u = await makeUser(nextName("stg"));
    process.env.PAYMENTS_DEV_TOOLS = "";
    resetProviders();
    const staging = await buildApp();
    try {
      expect(mockControlsOrNull()).toBeNull();
      expect((await staging.inject({ method: "POST", url: "/wallet/dev-topup", headers: as(u), payload: { nairaAmount: 1000 } })).statusCode).toBe(404);
      expect((await staging.inject({ method: "POST", url: "/payments/mock/checkout/tp-x", payload: { action: "pay" } })).statusCode).toBe(404);
      expect((await staging.inject({ method: "GET", url: "/payments/mock/checkout/tp-x" })).statusCode).toBe(404);
      const wh = mock.signedDelivery("topup.paid", { reference: "tp-x" });
      expect((await staging.inject({ method: "POST", url: "/webhooks/mock", headers: wh.headers, payload: wh.rawBody })).statusCode).toBe(409); // provider_not_configured
      expect(await cash(u)).toBe(0);
    } finally {
      await staging.close();
      process.env.PAYMENTS_DEV_TOOLS = "true";
      resetProviders();
      mock = mockControlsOrNull()!;
    }
    // Dev tools on with no mock secret: refuses to start.
    const secret = process.env.MOCK_PAYMENTS_WEBHOOK_SECRET;
    delete process.env.MOCK_PAYMENTS_WEBHOOK_SECRET;
    try {
      await expect(buildApp()).rejects.toThrow(/MOCK_PAYMENTS_WEBHOOK_SECRET/);
    } finally {
      process.env.MOCK_PAYMENTS_WEBHOOK_SECRET = secret;
      resetProviders();
      mock = mockControlsOrNull()!;
    }
  });
});

describe("maker-checker on loosening controls", () => {
  const putConfig = (who: User, c: PaymentsConfig, reason = "adjusting limits") => app.inject({ method: "PUT", url: "/admin/payments/config", headers: as(who), payload: { config: c, reason } });
  const putSettings = (who: User, change: Record<string, unknown>, reason = "ops") => app.inject({ method: "PUT", url: "/admin/payments/settings", headers: as(who), payload: { collections: "mock", payouts: "mock", topupsPaused: false, payoutsPaused: false, ...change, reason } });
  const confirmChange = (who: User, id: string) => app.inject({ method: "POST", url: `/admin/payments/config-changes/${id}/confirm`, headers: as(who) });
  const edit = (f: (c: PaymentsConfig) => void) => { const c = structuredClone(DEFAULT_PAYMENTS_CONFIG); f(c); return c; };

  it("raising a threshold waits for a second admin (not the same one); config and the log are written together", async () => {
    await config(() => {});
    const raise = edit((c) => { c.finalize.secondAdminThresholdKobo *= 10; });
    const asked = await putConfig(admin, raise, "raise the finalize threshold");
    expect(asked.statusCode).toBe(202);
    expect(asked.json().change).toMatchObject({ status: "awaiting_second_admin", loosens: ["finalize.secondAdminThresholdKobo"] });
    expect((await getPaymentsConfig()).finalize.secondAdminThresholdKobo).toBe(DEFAULT_PAYMENTS_CONFIG.finalize.secondAdminThresholdKobo);
    expect((await putConfig(admin2, raise)).json().error).toBe("change_pending");
    const self = await confirmChange(admin, asked.json().change.id);
    expect([self.statusCode, self.json().error]).toEqual([403, "second_admin_required"]);
    expect((await confirmChange(admin2, asked.json().change.id)).json().change).toMatchObject({ status: "applied", confirmedBy: admin2.id });
    expect((await getPaymentsConfig()).finalize.secondAdminThresholdKobo).toBe(DEFAULT_PAYMENTS_CONFIG.finalize.secondAdminThresholdKobo * 10);
    const [log] = await db.select().from(adminActions).where(and(eq(adminActions.action, "config.payments"), eq(adminActions.adminUserId, admin2.id))).orderBy(desc(adminActions.createdAt)).limit(1);
    expect(log.after).toMatchObject({ requestedBy: admin.id, changeId: asked.json().change.id });
    // Lowering it back is tightening: one admin, at once, logged.
    const lowered = await putConfig(admin, DEFAULT_PAYMENTS_CONFIG, "back to default");
    expect([lowered.statusCode, lowered.json().change]).toEqual([200, null]);
    expect((await getPaymentsConfig()).finalize.secondAdminThresholdKobo).toBe(DEFAULT_PAYMENTS_CONFIG.finalize.secondAdminThresholdKobo);
  });

  it("a loosening change asked against a config that has since moved is superseded, never applied over it", async () => {
    await config(() => {});
    const asked = await putConfig(admin, edit((c) => { c.payout.maxKobo *= 2; }));
    expect((await putConfig(admin2, edit((c) => { c.payout.dailyCount = 2; }), "tighten")).statusCode).toBe(200);
    const late = await confirmChange(admin2, asked.json().change.id);
    expect(late.json().change.status).toBe("superseded");
    expect((await getPaymentsConfig()).payout.maxKobo).toBe(DEFAULT_PAYMENTS_CONFIG.payout.maxKobo);
    await config(() => {});
  });

  it("pausing is one admin; un-pausing (the system's pause too) needs a second", async () => {
    expect((await putSettings(admin, { payoutsPaused: true }, "incident")).statusCode).toBe(200);
    const unpause = await putSettings(admin, {}, "incident over");
    expect([unpause.statusCode, unpause.json().change.loosens]).toEqual([202, ["payouts_unpaused"]]);
    expect(unpause.json().settings.payoutsPaused).toBe(true);
    expect((await confirmChange(admin2, unpause.json().change.id)).json().change.status).toBe("applied");
    await db.transaction((tx) => pausePayoutsBySystem(tx, "invariant breach: test"));
    const afterBreach = await putSettings(admin, {}, "checked the books");
    expect(afterBreach.statusCode).toBe(202);
    await confirmChange(admin2, afterBreach.json().change.id);
    expect((await app.inject({ method: "GET", url: "/admin/payments/settings", headers: as(viewer) })).json().settings.payoutsPaused).toBe(false);
    const changes = await db.select().from(paymentConfigChanges).where(eq(paymentConfigChanges.kind, "settings"));
    expect(changes.every((c) => c.status !== "awaiting_second_admin")).toBe(true);
  });
});

describe("guardrails", () => {
  it("reconciliation finds each kind of difference and fixes none", async () => {
    const day = "2031-03-10";
    const inDay = new Date(`${day}T12:00:00+01:00`);
    const at = inDay.getTime();
    // Ours pending, theirs paid: status differs (a missed webhook). Ours credited, theirs absent: missing theirs.
    const u = await makeUser(nextName("rc"));
    const pend = await createTopup(u, kobo(500), { returnUrl: null, now: inDay });
    await mock.setTopup(pend.reference, { amountKobo: kobo(500), userId: u.id, state: "paid", createdAt: at, verifies: 0 });
    const gone = await createTopup(u, kobo(600), { returnUrl: null, now: inDay });
    await mock.completeCheckout(gone.reference, "pay");
    expect(await confirmTopup(gone.id, "check")).toBe("credited");
    await mock.setTopup(gone.reference, { amountKobo: kobo(600), userId: u.id, state: "paid", createdAt: at + 2 * 86_400_000, verifies: 0 }); // listed on another day
    const diff = await createTopup(u, kobo(700), { returnUrl: null, now: inDay });
    await mock.completeCheckout(diff.reference, "pay");
    expect(await confirmTopup(diff.id, "check")).toBe("credited");
    await mock.setTopup(diff.reference, { amountKobo: kobo(799), userId: u.id, state: "paid", createdAt: at, verifies: 0 });
    // Theirs only: missing ours.
    await mock.setTopup(`tp-stray-${tag}`, { amountKobo: kobo(900), userId: u.id, state: "paid", createdAt: at, verifies: 0 });
    // A payout we reversed that the provider says went through.
    const w = await withdrawer("rcpo");
    const p = (await requestPayout(w.u, { amountKobo: kobo(1500) + 11, bankAccountId: w.account.id, clientRequestId: randomUUID() }, deps, inDay)).payout;
    expect(await submitPayout(p.id)).toBe("failed");
    await mock.setTransfer(p.reference, { amountKobo: p.sentKobo, recipientCode: w.account.recipientCode, state: "success", createdAt: at, queries: 0 });

    const { runId } = await reconcileDay("mock", day);
    const items = await db.select().from(paymentReconItems).where(eq(paymentReconItems.runId, runId));
    const kinds = (ref: string) => items.filter((i) => i.reference === ref).map((i) => i.kind);
    expect(kinds(pend.reference)).toEqual(["status_differs"]);
    expect(kinds(gone.reference)).toEqual(["missing_theirs"]);
    expect(kinds(diff.reference)).toEqual(["amount_differs"]);
    expect(kinds(`tp-stray-${tag}`)).toEqual(["missing_ours"]);
    expect(kinds(p.reference)).toEqual(["status_differs"]);
    expect((await db.select().from(topups).where(eq(topups.id, pend.id)))[0].status).toBe("pending"); // nothing fixed
    expect(await cash(u)).toBe(kobo(1300));
    const listed = await app.inject({ method: "GET", url: "/admin/payments/reconciliation", headers: as(viewer) });
    expect(listed.json().runs.find((r: { id: string }) => r.id === runId).items).toHaveLength(5);
  });

  it("the books hold after everything above: no breach", async () => {
    expect(await findBreaches(db)).toEqual([]);
  });

  it("the invariant job catches a planted imbalance and pauses payouts (inside a transaction rolled back after)", async () => {
    const victim = await makeUser(nextName("inv"));
    await fund(victim, kobo(10));
    let seen: Awaited<ReturnType<typeof runInvariants>> | undefined;
    let pausedInside = false;
    await db.transaction(async (tx) => {
      // Money from nowhere: a single leg, as if someone wrote straight to the table.
      const [acct] = await tx.select().from(ledgerAccounts).where(and(eq(ledgerAccounts.userId, victim.id), eq(ledgerAccounts.kind, "cash")));
      await tx.insert(ledgerEntries).values({ journalId: randomUUID(), accountId: acct.id, amountKobo: kobo(1000), type: "topup", idempotencyKey: `t:planted:${tag}` });
      seen = await runInvariants(tx);
      const [s] = await tx.select().from(paymentSettings).orderBy(desc(paymentSettings.version)).limit(1);
      pausedInside = s.payoutsPaused && s.changedBy === "system";
      tx.rollback();
    }).catch((e) => { if (!/rollback/i.test(String(e?.message ?? e))) throw e; });
    expect(seen!.breaches.map((b) => b.kind).sort()).toEqual(["balance_drift", "unbalanced_journal"]);
    expect(seen!.paused).toBe(true);
    expect(pausedInside).toBe(true);
    // And for real (committed): the system's pause stays until an admin clears it.
    await db.transaction((tx) => pausePayoutsBySystem(tx, "test"));
    const s = await app.inject({ method: "GET", url: "/admin/payments/settings", headers: as(viewer) });
    expect(s.json().settings).toMatchObject({ payoutsPaused: true, pausedBy: "system" });
    await settings({});
  });

  /** Plant something inside a transaction, read the breaches, roll it all back. */
  async function plantAndCheck(plant: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<void>) {
    let kinds: string[] = [];
    await db.transaction(async (tx) => {
      await plant(tx);
      kinds = (await findBreaches(tx)).map((b) => b.kind).sort();
      tx.rollback();
    }).catch((e) => { if (!/rollback/i.test(String(e?.message ?? e))) throw e; });
    return kinds;
  }

  it("a closed party's pot must be empty, and platform accounts point the right way; parties from before double entry are left out", async () => {
    const host = await makeUser(nextName("invhost"));
    const player = await makeUser(nextName("invplayer"));
    await fund(player, kobo(100));
    const newParty = async (tx: Tx, status: "finished" | "cancelled") => (await tx.insert(parties).values({ createdByUserId: host.id, title: `inv ${tag}`, category: "General knowledge", maxPlayers: 6, funding: "pooled", split: [100], status, startsAt: new Date() }).returning())[0];
    // A finished party whose entry is still in the pot (a settlement that paid out less than came in).
    expect(await plantAndCheck(async (tx) => {
      const party = await newParty(tx, "finished");
      await ledger.post(tx, { userId: player.id, kind: "cash", amountKobo: -kobo(50), type: "party_entry", refType: "party", refId: party.id, idempotencyKey: `t:inv:entry:${party.id}` });
    })).toEqual(["closed_party_pot"]);
    // Paid out more than came in: a negative pot (wrong way, and not empty).
    expect(await plantAndCheck(async (tx) => {
      const party = await newParty(tx, "cancelled");
      await ledger.post(tx, { userId: player.id, kind: "cash", amountKobo: kobo(50), type: "party_prize", refType: "party", refId: party.id, idempotencyKey: `t:inv:prize:${party.id}` });
    })).toEqual(["closed_party_pot", "platform_direction"]);
    // A seat charged before double entry (no journal) and refunded after: left out.
    expect(await plantAndCheck(async (tx) => {
      const party = await newParty(tx, "cancelled");
      const [acct] = await tx.select().from(ledgerAccounts).where(and(eq(ledgerAccounts.userId, player.id), eq(ledgerAccounts.kind, "cash")));
      await tx.insert(ledgerEntries).values({ journalId: null, accountId: acct.id, amountKobo: -kobo(50), type: "party_entry", refType: "party", refId: party.id, idempotencyKey: `t:inv:legacy:${party.id}`, createdAt: new Date("2026-01-01") });
      await tx.update(ledgerAccounts).set({ balanceKobo: sqlRaw`${ledgerAccounts.balanceKobo} - ${kobo(50)}` }).where(eq(ledgerAccounts.id, acct.id));
      await ledger.post(tx, { userId: player.id, kind: "cash", amountKobo: kobo(50), type: "party_leave_refund", refType: "party", refId: party.id, idempotencyKey: `t:inv:refund:${party.id}` });
    })).toEqual([]);
    // A platform account going the wrong way: dev_mint above zero.
    expect(await plantAndCheck(async (tx) => {
      const [mint] = await tx.select().from(ledgerAccounts).where(eq(ledgerAccounts.kind, "dev_mint"));
      await ledger.journal(tx, { type: "t", idempotencyKey: `t:inv:mint:${tag}`, legs: [{ account: { system: "dev_mint" }, amountKobo: -mint.balanceKobo + 1 }, { account: { system: "bonus_issued" }, amountKobo: mint.balanceKobo - 1 }] });
    })).toEqual(["platform_direction"]);
  });

  it("a party with every signed-up player banned mid-game ends with an empty pot and no breach: every seat refunded as paid, banned ones too, logged", async () => {
    const host = await makeUser(nextName("bnhost"));
    const [a, b, c] = [await makeUser(nextName("bna")), await makeUser(nextName("bnb")), await makeUser(nextName("bnc"))];
    for (const u of [a, b, c]) await fund(u, kobo(1000));
    await db.transaction((tx) => ledger.post(tx, { userId: c.id, kind: "bonus", amountKobo: kobo(200), type: "welcome_bonus", idempotencyKey: `t:bn:bonus:${c.id}` }));
    const [party] = await db.insert(parties).values({ createdByUserId: host.id, title: `bans ${tag}`, category: "General knowledge", maxPlayers: 6, funding: "pooled", entryKobo: kobo(500), split: [100], startsAt: new Date(), status: "live" }).returning();
    await db.transaction(async (tx) => { for (const u of [a, b, c]) await takeSeat(tx, party, u.id, kobo(500)); });
    // a and b played and were ranked; c sat there unranked. Then a and b are banned mid-game.
    await db.update(partyPlayers).set({ rank: 1 }).where(and(eq(partyPlayers.partyId, party.id), eq(partyPlayers.userId, a.id)));
    await db.update(partyPlayers).set({ rank: 2 }).where(and(eq(partyPlayers.partyId, party.id), eq(partyPlayers.userId, b.id)));
    await db.update(users).set({ bannedAt: new Date(), banReason: "cheating" }).where(inArray(users.id, [a.id, b.id]));
    const out = await db.transaction(async (tx) => {
      const [p] = await tx.select().from(parties).where(eq(parties.id, party.id)).for("update");
      return cancelIfUnplaceable(tx, p);
    });
    expect(out).toMatchObject({ players: 3, bannedSeats: 2 });
    const [after] = await db.select().from(parties).where(eq(parties.id, party.id));
    expect([after.status, after.cancelledBy]).toEqual(["cancelled", "system"]);
    expect(await db.transaction((tx) => potBalance(tx, party.id))).toBe(0);
    expect(await ledger.balances(c.id)).toEqual({ cashKobo: kobo(1000), bonusKobo: kobo(200) }); // refunded as paid: bonus to bonus, cash to cash
    expect([(await ledger.balances(a.id)).cashKobo, (await ledger.balances(b.id)).cashKobo]).toEqual([kobo(1000), kobo(1000)]); // a ban's freeze holds it, not the party
    const [log] = await db.select().from(adminActions).where(and(eq(adminActions.targetId, party.id), eq(adminActions.action, "party.cancel_unplaceable")));
    expect(log.adminUserId).toBe(await db.transaction((tx) => ledger.treasuryUserId(tx))); // the system
    expect((log.after as { bannedSeats: { userId: string; banReason: string }[] }).bannedSeats.map((x) => [x.userId, x.banReason]).sort()).toEqual([[a.id, "cheating"], [b.id, "cheating"]].sort());
    expect(await findBreaches(db)).toEqual([]);
    // Settling twice moves nothing.
    expect(await db.transaction(async (tx) => cancelIfUnplaceable(tx, (await tx.select().from(parties).where(eq(parties.id, party.id)))[0]))).toBeNull();
  });

  it("main's settle (partySettle.ts): every signed-up player banned mid-game cancels with an empty pot, no breach; the room hears it only after the commit", async () => {
    const host = await makeUser(nextName("stlhost"));
    const [a, b] = [await makeUser(nextName("stla")), await makeUser(nextName("stlb"))];
    for (const u of [a, b]) await fund(u, kobo(1000));
    const [party] = await db.insert(parties).values({ createdByUserId: host.id, title: `settle bans ${tag}`, category: "General knowledge", maxPlayers: 6, funding: "pooled", entryKobo: kobo(500), split: [100], startsAt: new Date(), status: "live" }).returning();
    await db.transaction(async (tx) => { for (const u of [a, b]) await takeSeat(tx, party, u.id, kobo(500)); });
    await db.update(partyPlayers).set({ rank: 1 }).where(and(eq(partyPlayers.partyId, party.id), eq(partyPlayers.userId, a.id)));
    await db.update(partyPlayers).set({ rank: 2 }).where(and(eq(partyPlayers.partyId, party.id), eq(partyPlayers.userId, b.id)));
    await db.update(users).set({ bannedAt: new Date(), banReason: "cheating" }).where(inArray(users.id, [a.id, b.id]));
    const heard: { status: string; committed: string }[] = [];
    // emit reads the party from another connection: it sees only what has committed.
    const deps = {
      emit: async (ev: { partyId: string; status: string }) => { heard.push({ status: ev.status, committed: (await db.select().from(parties).where(eq(parties.id, ev.partyId)))[0].status }); },
      publishLine: async () => {}, queueRecordPlay: async () => {},
    };
    expect(await settle(deps, party.id)).toBe(false);
    expect(heard).toEqual([{ status: "cancelled", committed: "cancelled" }]);
    expect(await db.transaction((tx) => potBalance(tx, party.id))).toBe(0);
    expect([await cash(a), await cash(b)]).toEqual([kobo(1000), kobo(1000)]);
    expect(await findBreaches(db)).toEqual([]);
    expect(await settle(deps, party.id)).toBe(false); // a replay: nothing more
    expect(heard).toHaveLength(1);
    // A normal finish is heard after its commit too.
    const c = await makeUser(nextName("stlc"));
    await fund(c, kobo(1000));
    const [ok] = await db.insert(parties).values({ createdByUserId: host.id, title: `settle ok ${tag}`, category: "General knowledge", maxPlayers: 6, funding: "pooled", entryKobo: kobo(500), split: [100], startsAt: new Date(), status: "live" }).returning();
    await db.transaction((tx) => takeSeat(tx, ok, c.id, kobo(500)));
    await db.update(partyPlayers).set({ rank: 1 }).where(eq(partyPlayers.partyId, ok.id));
    expect(await settle(deps, ok.id)).toBe(true);
    expect(heard[1]).toEqual({ status: "finished", committed: "finished" });
  });

  it("a user-borne fee that comes in lower than estimated goes to fee_variance, not platform_funds: no breach", async () => {
    await config((c) => { c.payout.feeBearer = "user"; });
    try {
      const { u, account } = await withdrawer("feelow");
      const { payout } = await request(u, account.id, kobo(1500));
      expect([payout.feeKobo, payout.sentKobo]).toEqual([1_000, kobo(1500) - 1_000]);
      await db.update(payouts).set({ status: "submitted", submittedAt: new Date(), lastSentAt: new Date(), sendAttempts: 1 }).where(eq(payouts.id, payout.id));
      const paid = { status: "success" as const, providerStatus: "success", reference: payout.reference, amountKobo: payout.sentKobo, currency: "NGN", userId: null, feeKobo: 400, error: null };
      expect(await applyOutcome(payout.id, paid, "check")).toBe("succeeded");
      const [variance] = await db.select().from(ledgerEntries).where(eq(ledgerEntries.idempotencyKey, `payout_fee:${payout.id}#1`));
      const [acct] = await db.select().from(ledgerAccounts).where(eq(ledgerAccounts.id, variance.accountId));
      expect([acct.kind, variance.amountKobo]).toEqual(["fee_variance", 600]);
      expect((await reload(payout.id)).feeKobo).toBe(400);
      expect(await findBreaches(db)).toEqual([]);
    } finally {
      await config(() => {});
    }
  });

  it("an acknowledged breach doesn't pause payouts again; a growing one does; acknowledging takes two admins and a reason", async () => {
    const u = await makeUser(nextName("invack"));
    const t = await createTopup(u, kobo(500), { returnUrl: null });
    await mock.completeCheckout(t.reference, "pay");
    expect(await confirmTopup(t.id, "check")).toBe("credited");
    await db.update(topups).set({ creditedKobo: kobo(499) }).where(eq(topups.id, t.id)); // a known, explained difference
    const currentPause = async () => (await db.select().from(paymentSettings).orderBy(desc(paymentSettings.version)).limit(1))[0];
    try {
      expect((await runInvariants()).paused).toBe(true);
      await settings({});
      const ask = await app.inject({ method: "POST", url: "/admin/payments/invariants/acknowledge", headers: as(admin), payload: { kind: "provider_topup_in", reason: "ticket 7: record corrected upstream" } });
      expect(ask.json().acknowledgment).toMatchObject({ status: "awaiting_second_admin", items: { mock: -kobo(1) } }); // signed: the ledger is ₦1 past the records
      expect((await app.inject({ method: "POST", url: `/admin/payments/invariant-acknowledgments/${ask.json().acknowledgment.id}/confirm`, headers: as(admin) })).json().error).toBe("second_admin_required");
      expect((await runInvariants()).paused).toBe(true); // asked, not yet confirmed: still pauses
      await settings({});
      expect((await app.inject({ method: "POST", url: `/admin/payments/invariant-acknowledgments/${ask.json().acknowledgment.id}/confirm`, headers: as(admin2) })).json().acknowledgment.status).toBe("applied");
      const quiet = await runInvariants();
      expect([quiet.paused, quiet.breaches, quiet.acknowledged.map((b) => b.kind)]).toEqual([false, [], ["provider_topup_in"]]);
      expect((await currentPause()).payoutsPaused).toBe(false);
      const page = (await app.inject({ method: "GET", url: "/admin/payments", headers: as(viewer) })).json();
      expect(page.acknowledgedBreaches.some((a: { id: string }) => a.id === ask.json().acknowledgment.id)).toBe(true);
      // It changes the other way (a new error pulling the gap toward zero, say): a new breach, payouts pause again.
      await db.update(topups).set({ creditedKobo: kobo(500) + 50 }).where(eq(topups.id, t.id));
      const flipped = await runInvariants();
      expect([flipped.paused, flipped.breaches.map((b) => b.kind)]).toEqual([true, ["provider_topup_in"]]);
      await settings({});
      // Back to exactly what was acknowledged: quiet again, until the acknowledgment expires.
      await db.update(topups).set({ creditedKobo: kobo(499) }).where(eq(topups.id, t.id));
      expect((await runInvariants()).paused).toBe(false);
      await db.update(invariantAcknowledgments).set({ appliedAt: new Date(Date.now() - (DEFAULT_PAYMENTS_CONFIG.invariants.acknowledgmentDays * 24 + 1) * 3600_000) }).where(eq(invariantAcknowledgments.id, ask.json().acknowledgment.id));
      expect((await runInvariants()).paused).toBe(true);
      await settings({});
      // It grows: payouts pause again.
      await db.update(invariantAcknowledgments).set({ appliedAt: new Date() }).where(eq(invariantAcknowledgments.id, ask.json().acknowledgment.id));
      await db.update(topups).set({ creditedKobo: kobo(490) }).where(eq(topups.id, t.id));
      const grown = await runInvariants();
      expect([grown.paused, grown.breaches.map((b) => b.kind)]).toEqual([true, ["provider_topup_in"]]);
    } finally {
      await db.update(topups).set({ creditedKobo: kobo(500) }).where(eq(topups.id, t.id));
      await settings({});
    }
    expect((await runInvariants()).breaches).toEqual([]);
  });

  it("a check with more items than it reports overflows and is never acknowledged, even by one covering everything it shows", async () => {
    const victim = await makeUser(nextName("invover"));
    await fund(victim, kobo(10));
    let out: Awaited<ReturnType<typeof runInvariants>> | undefined;
    let shown: Breach | undefined;
    await db.transaction(async (tx) => {
      const [acct] = await tx.select().from(ledgerAccounts).where(and(eq(ledgerAccounts.userId, victim.id), eq(ledgerAccounts.kind, "cash")));
      await tx.insert(ledgerEntries).values(Array.from({ length: ITEM_CAP + 5 }, (_, i) => ({ journalId: null, accountId: acct.id, amountKobo: 1, type: "topup", idempotencyKey: `t:over:${tag}:${i}` })));
      shown = (await findBreaches(tx)).find((b) => b.kind === "entry_outside_journal");
      // An applied acknowledgment of everything the check shows:
      await tx.insert(invariantAcknowledgments).values({ kind: "entry_outside_journal", items: shown!.items, detail: {}, reason: "test", status: "applied", requestedByUserId: admin.id, confirmedByUserId: admin2.id, appliedAt: new Date() });
      out = await runInvariants(tx);
      tx.rollback();
    }).catch((e) => { if (!/rollback/i.test(String(e?.message ?? e))) throw e; });
    expect([shown!.overflow, Object.keys(shown!.items).length]).toEqual([true, ITEM_CAP]);
    expect(out!.breaches.map((b) => b.kind)).toContain("entry_outside_journal");
    expect(out!.paused).toBe(true);
  });

  it("for real: one REPEATABLE READ snapshot, a breach that repeats pauses payouts; clearing it takes two admins", async () => {
    const u = await makeUser(nextName("invreal"));
    const t = await createTopup(u, kobo(500), { returnUrl: null });
    await mock.completeCheckout(t.reference, "pay");
    expect(await confirmTopup(t.id, "check")).toBe("credited");
    await db.update(topups).set({ creditedKobo: kobo(400) }).where(eq(topups.id, t.id)); // the record no longer matches the books (by more than anything acknowledged)
    try {
      const out = await runInvariants();
      expect(out.breaches.map((b) => b.kind)).toEqual(["provider_topup_in"]);
      expect([out.paused, out.transient]).toEqual([true, []]);
    } finally {
      await db.update(topups).set({ creditedKobo: kobo(500) }).where(eq(topups.id, t.id));
    }
    expect((await runInvariants()).breaches).toEqual([]);
    const unpause = await app.inject({ method: "PUT", url: "/admin/payments/settings", headers: as(admin), payload: { collections: "mock", payouts: "mock", topupsPaused: false, payoutsPaused: false, reason: "fixed the record" } });
    expect(unpause.statusCode).toBe(202);
    await app.inject({ method: "POST", url: `/admin/payments/config-changes/${unpause.json().change.id}/confirm`, headers: as(admin2) });
    expect((await app.inject({ method: "GET", url: "/admin/payments/settings", headers: as(viewer) })).json().settings.payoutsPaused).toBe(false);
  });
});

/**
 * Payments (row 10, ADR 0013) against the real database and the mock provider. The rule under test: no
 * glitch, retry, race or bad provider answer creates money or loses it. Top-ups credit once, only on a
 * verified confirmation; withdrawals debit first, reverse only on a definite failure, and settle once;
 * admins finalize through the same transitions; switching providers strands nothing; the invariant job and
 * reconciliation catch what they should.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, like, sql as sqlRaw } from "drizzle-orm";
import {
  adminActions, adminPermissions, db, deletionBlockers, getPaymentsConfig, ledger, ledgerAccounts, ledgerEntries, parties, paymentAlerts, paymentConfigChanges, paymentReconItems, paymentSettings, paymentWebhookEvents,
  payoutAccounts, payoutContradictions, payouts, setPaymentsConfig, sql, topups, users, type Payout, type Tx, type User,
} from "@contestly/db";
import { DEFAULT_PAYMENTS_CONFIG, kobo, type PaymentsConfig, type PaymentsJob } from "@contestly/shared";
import {
  addBankAccount, applyOutcome, checkPayout, findBreaches, closeProviders, confirmTopup, createTopup, mockControlsOrNull, pausePayoutsBySystem, processWebhookEvent, reconcileDay,
  requestPayout, resetProviders, resolveAccount, runInvariants, submitPayout, sweepDue, type KeyValue, type MockControls, type MockDelivery, type PaymentsDeps,
} from "@contestly/payments";
import { buildApp } from "../src/app.js";
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
const alertsFor = (refId: string) => db.select().from(paymentAlerts).where(eq(paymentAlerts.refId, refId));

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
      expect((await alertsFor(row.id)).map((a) => a.kind)).toContain("topup_mismatch");
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

  it("a success after a reversal freezes the person's withdrawals in the same transaction as the critical alert, and moves no money", async () => {
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
    const alert = alerts.find((a) => a.kind === "payout_success_after_reversal")!;
    expect(alert.severity).toBe("critical");
    const [frozen] = await db.select().from(users).where(eq(users.id, u.id));
    expect(frozen.withdrawalsFrozenAt).not.toBeNull();
    const [c] = await db.select().from(payoutContradictions).where(eq(payoutContradictions.payoutId, payout.id));
    expect([c.status, c.amountKobo, c.userId]).toEqual(["open", payout.amountKobo, u.id]);
    expect((await reload(payout.id)).status).toBe("failed");
    expect(await cash(u)).toBe(kobo(10_000) - kobo(1500));
    expect(await entriesFor(`payout_final:${payout.id}`)).toHaveLength(2);
    // The refunded cash can't leave: new requests refused, a queued one held before sending.
    await expect(request(frozen, account.id, kobo(1500))).rejects.toMatchObject({ message: "withdraw_not_allowed", details: { reason: "payment_review" } });
    expect(await submitPayout(queuedOne.id)).toBe("unchanged");
    expect((await reload(queuedOne.id)).holdReason).toBe("blocked:payment_review");
    expect(await mock.getTransfer(queuedOne.reference)).toBeNull();
    // Heard again: still one contradiction, one alert.
    await checkPayout(payout.id, "check");
    expect(await db.select().from(payoutContradictions).where(eq(payoutContradictions.payoutId, payout.id))).toHaveLength(1);
    expect((await alertsFor(payout.id)).filter((a) => a.kind === "payout_success_after_reversal")).toHaveLength(1);
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
    expect((await alertsFor(payout.id)).map((a) => a.kind)).not.toContain("payout_success_after_reversal");
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
    expect((await alertsFor(payout.id)).find((a) => a.kind === "payout_resend_account_removed")?.severity).toBe("critical");
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
    expect((await alertsFor(b.id)).map((x) => x.kind)).toContain("payout_webhook_amount_differs");
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
    expect((await alertsFor(payout.id)).find((a) => a.kind === "payout_unknown_too_long")?.severity).toBe("critical");
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
  /** A withdrawal reversed, then paid after all, with the person's cash at `cashAfter`. */
  async function contradicted(name: string, cashAfter: number) {
    const { u, account } = await withdrawer(name);
    const { payout } = await request(u, account.id, kobo(1500) + 11);
    expect(await submitPayout(payout.id)).toBe("failed");
    const t = (await mock.getTransfer(payout.reference))!;
    await mock.setTransfer(payout.reference, { ...t, state: "success" });
    await checkPayout(payout.id, "check");
    const [c] = await db.select().from(payoutContradictions).where(eq(payoutContradictions.payoutId, payout.id));
    // Spend down to cashAfter (as if they'd joined parties), through the ledger.
    const spend = (await cash(u)) - cashAfter;
    if (spend > 0) await db.transaction((tx) => ledger.post(tx, { userId: u.id, kind: "cash", amountKobo: -spend, type: "topup", idempotencyKey: `t:spend:${payout.id}` }));
    return { u, account, payout, c };
  }
  const resolve = (who: User, id: string, reason = "provider confirmed the transfer was paid") => app.inject({ method: "POST", url: `/admin/payments/contradictions/${id}/resolve`, headers: as(who), payload: { reason } });
  const confirmIt = (who: User, id: string) => app.inject({ method: "POST", url: `/admin/payments/contradictions/${id}/confirm`, headers: as(who) });

  it("enough cash: the debit is re-applied in full, the transfer booked as sent, withdrawals unfrozen; all logged", async () => {
    const { u, payout, c } = await contradicted("crfull", kobo(10_000));
    const listed = await app.inject({ method: "GET", url: "/admin/payments/contradictions", headers: as(viewer) });
    expect(listed.json().contradictions.some((x: { id: string }) => x.id === c.id)).toBe(true);
    expect((await resolve(viewer, c.id)).statusCode).toBe(403);
    expect((await resolve(admin, c.id)).json().contradiction.status).toBe("awaiting_second_admin");
    expect(await cash(u)).toBe(kobo(10_000)); // nothing moves on the request
    const self = await confirmIt(admin, c.id);
    expect([self.statusCode, self.json().error]).toEqual([403, "second_admin_required"]);
    const done = (await confirmIt(admin2, c.id)).json().contradiction;
    expect(done).toMatchObject({ status: "resolved", recoveredKobo: payout.amountKobo, owedKobo: 0, confirmedBy: admin2.id });
    expect(await cash(u)).toBe(kobo(10_000) - payout.amountKobo);
    expect(await entriesFor(`payout_recovery:${payout.id}`)).toHaveLength(2);
    expect((await db.select().from(users).where(eq(users.id, u.id)))[0].withdrawalsFrozenAt).toBeNull();
    expect((await confirmIt(admin2, c.id)).json().error).toBe("contradiction_not_pending");
    const log = await db.select().from(adminActions).where(eq(adminActions.targetId, payout.id));
    expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(["payments.contradiction_requested", "payments.contradiction_resolved"]));
    expect(await findBreaches(db)).toEqual([]);
  });

  it("not enough cash: takes what's there, records the rest as owed", async () => {
    const { u, payout, c } = await contradicted("crowed", kobo(400));
    await resolve(admin, c.id);
    const done = (await confirmIt(admin2, c.id)).json().contradiction;
    expect(done).toMatchObject({ recoveredKobo: kobo(400), owedKobo: payout.amountKobo - kobo(400) });
    expect(await cash(u)).toBe(0);
    const [owed] = await db.select().from(ledgerAccounts).where(and(eq(ledgerAccounts.kind, "payout_owed"), eq(ledgerAccounts.scope, "mock")));
    expect(owed.balanceKobo).toBeLessThanOrEqual(-(payout.amountKobo - kobo(400)));
    expect(await findBreaches(db)).toEqual([]);
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
    expect(grant.json().permissions).toEqual(["payments.approve", "payments.view"]);
    expect((await app.inject({ method: "GET", url: "/admin/payments", headers: as(plain) })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/admin/session", headers: as(plain) })).json().permissions.sort()).toEqual(["payments.approve", "payments.view"]);
    expect((await app.inject({ method: "PUT", url: `/admin/payments/permissions/${admin.id}`, headers: as(admin), payload: { permissions: [], reason: "self" } })).json().error).toBe("cannot_change_own_permissions");
    const notAdmin = await makeUser(nextName("permna"));
    expect((await app.inject({ method: "PUT", url: `/admin/payments/permissions/${notAdmin.id}`, headers: as(admin), payload: { permissions: ["payments.view"], reason: "x y z" } })).json().error).toBe("not_admin");
    const [log] = await db.select().from(adminActions).where(and(eq(adminActions.targetId, plain.id), eq(adminActions.action, "payments.permissions")));
    expect(log.after).toEqual(["payments.approve", "payments.view"]);
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

  it("for real: one REPEATABLE READ snapshot, a breach that repeats pauses payouts; clearing it takes two admins", async () => {
    const u = await makeUser(nextName("invreal"));
    const t = await createTopup(u, kobo(500), { returnUrl: null });
    await mock.completeCheckout(t.reference, "pay");
    expect(await confirmTopup(t.id, "check")).toBe("credited");
    await db.update(topups).set({ creditedKobo: kobo(499) }).where(eq(topups.id, t.id)); // the record no longer matches the books
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

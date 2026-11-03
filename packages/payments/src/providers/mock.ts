/**
 * The mock provider: the default in dev and tests, never available in production. Its "provider side" lives
 * in Valkey so the API, the worker and a test all see the same one. Each transaction's behaviour comes from
 * the kobo part of its amount (amount % 100), so a sim or a test picks a scenario by the amount it asks for:
 *
 * Top-ups                                      Transfers (the amount sent)
 *  00 pays normally                             00 succeeds at once
 *  21 provider reports ₦1 more than ours        11 definite failure (recipient rejected)
 *  22 provider reports another currency         12 pending for 2 queries, then success
 *  23 provider reports another user             13 pending for 2 queries, then failure
 *  24 the payment fails                         14 send times out, but the transfer went through
 *  25 pending for 2 verifies, then success      15 send times out and nothing was created (a resend creates it)
 *  26 its webhook has a bad signature           16 send answers 502, but the transfer went through
 *  27 its webhook is delivered twice            17 success, webhook delivered twice
 *                                               18 success, webhook claims ₦1 more
 *                                               19 success, webhook has a bad signature
 *                                               31 send times out but went through; queries say "not found"
 *                                                  (the provider's lookup lags) and a resend is refused for
 *                                                  "insufficient balance" (the first send emptied it), until
 *                                                  a test reveals it (setTransfer with hidden: false)
 * Tests can also set the provider's side directly (setTopup / setTransfer) to plant what they need.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Redis } from "ioredis";
import { ProviderRefusal, type Bank, type CheckStatus, type DateRange, type Headers, type PaymentProvider, type ProviderCheck, type ProviderRecord, type WebhookEvent } from "../types.js";

export const MOCK = "mock";
const PENDING_CHECKS = 2;
const FLAT_FEE_KOBO = 1_000;
const SIGNATURE_HEADER = "x-mock-signature";
const BANKS: Bank[] = [{ code: "001", name: "Mock Bank" }, { code: "002", name: "Second Mock Bank" }, { code: "003", name: "Unresolvable Mock Bank" }];

type TopupState = "created" | "paid" | "failed";
type TransferState = "success" | "failed" | "pending";
export interface MockTopup { amountKobo: number; userId: string; state: TopupState; createdAt: number; verifies: number }
export interface MockTransfer { amountKobo: number; recipientCode: string; state: TransferState; createdAt: number; queries: number; hidden?: boolean }
/** A webhook as the provider would POST it. */
export interface MockDelivery { rawBody: Buffer; headers: Record<string, string> }

const scenario = (amountKobo: number) => amountKobo % 100;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const key = { topup: (r: string) => `mockpay:topup:${r}`, transfer: (r: string) => `mockpay:transfer:${r}`, sends: (r: string) => `mockpay:sends:${r}`, topups: "mockpay:topups", transfers: "mockpay:transfers" };

export interface MockOptions { redis: () => Redis; webhookSecret: string; checkoutBaseUrl: string }

export function mockProvider(opts: MockOptions) {
  const r = () => opts.redis();
  const sign = (body: string, secret = opts.webhookSecret) => createHmac("sha512", secret).update(body).digest("hex");

  async function readJson<T>(k: string): Promise<T | null> {
    const raw = await r().get(k);
    return raw ? (JSON.parse(raw) as T) : null;
  }
  const writeJson = (k: string, v: unknown) => r().set(k, JSON.stringify(v));

  async function setTopup(reference: string, t: MockTopup) {
    await writeJson(key.topup(reference), t);
    await r().zadd(key.topups, t.createdAt, reference);
  }
  async function setTransfer(reference: string, t: MockTransfer) {
    await writeJson(key.transfer(reference), t);
    await r().zadd(key.transfers, t.createdAt, reference);
  }

  const check = (status: CheckStatus, reference: string, extra: Partial<ProviderCheck> = {}): ProviderCheck =>
    ({ status, providerStatus: status, reference, amountKobo: null, currency: null, userId: null, feeKobo: null, error: null, ...extra });

  /** What the provider reports for a paid top-up (scenarios 21–23 report something other than ours). */
  const reported = (t: MockTopup) => ({
    amountKobo: scenario(t.amountKobo) === 21 ? t.amountKobo + 100 : t.amountKobo,
    currency: scenario(t.amountKobo) === 22 ? "USD" : "NGN",
    userId: scenario(t.amountKobo) === 23 ? "00000000-0000-4000-8000-00000000dead" : t.userId,
  });

  function delivery(event: string, data: Record<string, unknown>, badSignature: boolean): MockDelivery {
    const body = JSON.stringify({ event, data });
    return { rawBody: Buffer.from(body), headers: { "content-type": "application/json", [SIGNATURE_HEADER]: sign(body, badSignature ? "not-the-secret" : opts.webhookSecret) } };
  }

  function readEvent(rawBody: Buffer): WebhookEvent {
    const { event, data } = JSON.parse(rawBody.toString("utf8")) as { event: string; data: { reference?: string; amountKobo?: number; currency?: string; userId?: string; status?: string } };
    const type = event.startsWith("topup.") ? "topup" : event.startsWith("transfer.") ? "transfer" : "other";
    return {
      eventId: createHmac("sha256", "event").update(rawBody).digest("hex"), type, name: event, reference: data.reference ?? null,
      providerStatus: data.status ?? event, amountKobo: Number.isSafeInteger(data.amountKobo) ? data.amountKobo! : null, currency: data.currency ?? null, userId: data.userId ?? null,
    };
  }

  const provider: PaymentProvider = {
    name: MOCK,
    webhookIps: ["127.0.0.1", "::1"],
    collection: {
      async createTopup(input) {
        // Like a real provider, a payment needs the customer's email; refused (400) without a well-formed one.
        // Reserved test domains are allowed here only: dev and test accounts use them and the mock sends no mail.
        if (!EMAIL.test(input.email ?? "")) throw new ProviderRefusal(`"email" must be a valid email`, 400);
        await setTopup(input.reference, { amountKobo: input.amountKobo, userId: input.userId, state: "created", createdAt: Date.now(), verifies: 0 });
        return { checkoutUrl: `${opts.checkoutBaseUrl}/payments/mock/checkout/${input.reference}` };
      },
      async verifyTopup(reference) {
        const t = await readJson<MockTopup>(key.topup(reference));
        if (!t) return check("not_found", reference);
        if (t.state === "created") return check("pending", reference, { providerStatus: "ongoing" });
        if (t.state === "failed") return check("failed", reference, { amountKobo: t.amountKobo, currency: "NGN", userId: t.userId });
        if (scenario(t.amountKobo) === 25) {
          const n = t.verifies + 1;
          await writeJson(key.topup(reference), { ...t, verifies: n });
          if (n <= PENDING_CHECKS) return check("pending", reference, { providerStatus: "processing" });
        }
        return check("success", reference, reported(t));
      },
      async listTopups(range) {
        return list(key.topups, range, async (ref) => {
          const t = await readJson<MockTopup>(key.topup(ref));
          if (!t) return null;
          const status: CheckStatus = t.state === "paid" ? "success" : t.state === "failed" ? "failed" : "pending";
          return { reference: ref, amountKobo: reported(t).amountKobo, status, providerStatus: t.state };
        });
      },
    },
    payout: {
      banks: {
        async listBanks() { return BANKS; },
        async resolveAccount({ bankCode, accountNumber }) {
          if (bankCode === "003" || accountNumber.startsWith("0000")) return null;
          if (accountNumber.startsWith("9999")) throw new Error("mock bank directory unavailable");
          return { accountName: `MOCK HOLDER ${accountNumber.slice(-4)}` };
        },
      },
      async createRecipient(d) { return { recipientCode: `RCP_mock_${d.bankCode}_${d.accountNumber}` }; },
      transferFeeTiers: [{ upToKobo: null, feeKobo: FLAT_FEE_KOBO }],
      async sendTransfer(input) {
        const ref = input.reference;
        const existing = await readJson<MockTransfer>(key.transfer(ref));
        // A transfer its lookup can't see yet: refused on balance before the duplicate check (scenario 31).
        if (existing?.hidden) return check("failed", ref, { providerStatus: "refused: Insufficient balance", amountKobo: input.amountKobo, currency: "NGN" });
        // The provider is idempotent on our reference: a resend reports the transfer it already has.
        if (existing) return transferCheck(ref, existing);
        const s = scenario(input.amountKobo);
        const t: MockTransfer = { amountKobo: input.amountKobo, recipientCode: input.recipientCode, state: "success", createdAt: Date.now(), queries: 0 };
        if (s === 11) { await setTransfer(ref, { ...t, state: "failed" }); return check("failed", ref, { providerStatus: "recipient_rejected", amountKobo: t.amountKobo }); }
        if (s === 12 || s === 13) { await setTransfer(ref, { ...t, state: "pending" }); return check("pending", ref, { providerStatus: "pending", amountKobo: t.amountKobo }); }
        if (s === 14) { await setTransfer(ref, t); return check("unknown", ref, { providerStatus: "timeout", error: "timeout" }); }
        if (s === 15) {
          const sends = await r().incr(key.sends(ref));
          if (sends === 1) return check("unknown", ref, { providerStatus: "timeout", error: "timeout" });
          await setTransfer(ref, t);
          return transferCheck(ref, t);
        }
        if (s === 31) { await setTransfer(ref, { ...t, hidden: true }); return check("unknown", ref, { providerStatus: "timeout", error: "timeout" }); }
        if (s === 16) { await setTransfer(ref, t); return check("unknown", ref, { providerStatus: "http_502", error: "502 Bad Gateway" }); }
        await setTransfer(ref, t);
        return transferCheck(ref, t);
      },
      async queryTransfer(reference) {
        const t = await readJson<MockTransfer>(key.transfer(reference));
        if (!t || t.hidden) return check("not_found", reference, { providerStatus: "not_found" });
        if (t.state === "pending") {
          const n = t.queries + 1;
          const next: MockTransfer = { ...t, queries: n, state: n <= PENDING_CHECKS ? "pending" : scenario(t.amountKobo) === 13 ? "failed" : "success" };
          await writeJson(key.transfer(reference), next);
          return transferCheck(reference, next);
        }
        return transferCheck(reference, t);
      },
      async listTransfers(range) {
        return list(key.transfers, range, async (ref) => {
          const t = await readJson<MockTransfer>(key.transfer(ref));
          return t ? { reference: ref, amountKobo: t.amountKobo, status: t.state === "pending" ? "pending" : t.state, providerStatus: t.state } : null;
        });
      },
    },
    parseWebhook(rawBody: Buffer, headers: Headers) {
      const given = headers[SIGNATURE_HEADER];
      if (typeof given !== "string") return null;
      const want = Buffer.from(sign(rawBody.toString("utf8")), "hex");
      const got = Buffer.from(given, "hex");
      if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
      return readEvent(rawBody);
    },
    readWebhook: readEvent,
  };

  function transferCheck(reference: string, t: MockTransfer): ProviderCheck {
    if (t.state === "pending") return check("pending", reference, { providerStatus: "pending", amountKobo: t.amountKobo, currency: "NGN" });
    return check(t.state, reference, { providerStatus: t.state, amountKobo: t.amountKobo, currency: "NGN", feeKobo: t.state === "success" ? FLAT_FEE_KOBO : null });
  }

  async function list(zkey: string, range: DateRange, read: (ref: string) => Promise<ProviderRecord | null>) {
    const refs = await r().zrangebyscore(zkey, range.from.getTime(), range.to.getTime() - 1);
    const out: ProviderRecord[] = [];
    for (const ref of refs) { const rec = await read(ref); if (rec) out.push(rec); }
    return out;
  }

  /** The person pays (or fails to) on the mock checkout page; returns the webhooks the provider sends. */
  async function completeCheckout(reference: string, outcome: "pay" | "fail"): Promise<MockDelivery[]> {
    const t = await readJson<MockTopup>(key.topup(reference));
    if (!t) throw Object.assign(new Error("not_found"), { statusCode: 404 });
    const state: TopupState = outcome === "fail" || scenario(t.amountKobo) === 24 ? "failed" : "paid";
    await writeJson(key.topup(reference), { ...t, state });
    const shown = reported(t);
    const d = delivery(state === "paid" ? "topup.paid" : "topup.failed", { reference, ...shown, status: state }, scenario(t.amountKobo) === 26);
    return scenario(t.amountKobo) === 27 ? [d, d] : [d];
  }

  /** The webhooks the provider sends for a transfer's current state. */
  async function transferWebhooks(reference: string): Promise<MockDelivery[]> {
    const t = await readJson<MockTransfer>(key.transfer(reference));
    if (!t || t.state === "pending") return [];
    const s = scenario(t.amountKobo);
    const d = delivery(`transfer.${t.state}`, { reference, amountKobo: s === 18 ? t.amountKobo + 100 : t.amountKobo, currency: "NGN", status: t.state }, s === 19);
    return s === 17 ? [d, d] : [d];
  }

  return {
    provider, completeCheckout, transferWebhooks, setTopup, setTransfer,
    getTopup: (reference: string) => readJson<MockTopup>(key.topup(reference)),
    getTransfer: (reference: string) => readJson<MockTransfer>(key.transfer(reference)),
    /** A webhook signed with this mock's secret (or a wrong one), for tests. */
    signedDelivery: (event: string, data: Record<string, unknown>, badSignature = false) => delivery(event, data, badSignature),
  };
}
export type MockControls = ReturnType<typeof mockProvider>;

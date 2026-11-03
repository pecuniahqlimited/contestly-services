/**
 * Paystack (https://paystack.com/docs/api). Collections: hosted checkout (transaction/initialize), verified
 * with transaction/verify. Payouts: NUBAN recipients and transfers from the balance, our reference as
 * Paystack's transfer reference (its idempotency key). Webhooks: HMAC-SHA512 of the raw body with the secret
 * key, in x-paystack-signature. NGN amounts are already in kobo at Paystack; each is checked to be a whole number.
 *
 * Mapping: only Paystack's definite words become success or failed. A timeout, network error, 5xx, any 4xx we
 * don't recognise as a definite refusal, and any status not listed below is "unknown".
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Bank, CheckStatus, DateRange, Headers, PaymentProvider, ProviderCheck, ProviderRecord, WebhookEvent } from "../types.js";
import { ProviderRefusal, assertDeliverableEmail, unknownCheck } from "../types.js";
import { feeFromTiers, type FeeTier } from "@contestly/shared";

export const PAYSTACK = "paystack";
const BASE_URL = "https://api.paystack.co";
const TIMEOUT_MS = 15_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
/** Paystack's published webhook source addresses (for the optional allow-list). */
const WEBHOOK_IPS = ["52.31.139.75", "52.49.173.169", "52.214.14.220"];

/** A payment's status at Paystack, in our terms. "abandoned": the person hasn't paid yet (they still can). */
const CHARGE_STATUS: Record<string, CheckStatus> = { success: "success", failed: "failed", abandoned: "pending", ongoing: "pending", pending: "pending", processing: "pending", queued: "pending" };
/**
 * A transfer's status. "reversed" and "abandoned" mean it didn't (or no longer did) reach the account: the
 * money is back in our balance. "otp" means OTP is still on for transfers: it waits, and admins must fix it.
 */
const TRANSFER_STATUS: Record<string, CheckStatus> = { success: "success", failed: "failed", reversed: "failed", abandoned: "failed", rejected: "failed", blocked: "failed", pending: "pending", processing: "pending", queued: "pending", received: "pending" };
/** 4xx answers to a transfer that mean it was definitely not created. Anything else (duplicate reference included) is unknown. */
const DEFINITE_TRANSFER_REFUSALS = [
  /insufficient (balance|funds)|balance is not enough|not enough (balance|funds)/i,
  /(invalid|inactive|unknown) recipient|recipient (is )?(invalid|inactive|not found)/i,
];

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;
export interface PaystackOptions { secretKey: string; fetch?: Fetch; baseUrl?: string }

interface Answer { http: number; ok: boolean; message: string; data: any }

/** Paystack's published transfer fee for NGN: ₦10 up to ₦5,000, ₦25 up to ₦50,000, ₦50 above. */
export const PAYSTACK_TRANSFER_FEE_TIERS: readonly FeeTier[] = [{ upToKobo: 500_000, feeKobo: 1_000 }, { upToKobo: 5_000_000, feeKobo: 2_500 }, { upToKobo: null, feeKobo: 5_000 }];
export const paystackTransferFeeKobo = (amountKobo: number) => feeFromTiers(PAYSTACK_TRANSFER_FEE_TIERS, amountKobo);

const koboFrom = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
};
const isNotFound = (a: Answer) => a.http === 404 || (a.http === 400 && /not found|no transaction|invalid reference/i.test(a.message));

export function paystackProvider(opts: PaystackOptions): PaymentProvider {
  const fetchImpl: Fetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const base = (opts.baseUrl ?? BASE_URL).replace(/\/+$/, "");

  /** One call. Throws only when there's no HTTP answer at all (network, timeout). */
  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<Answer> {
    const res = await fetchImpl(`${base}${path}`, {
      method, headers: { authorization: `Bearer ${opts.secretKey}`, "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = null; } // a non-JSON answer (a proxy's 502 page) is unknown below
    return { http: res.status, ok: res.status >= 200 && res.status < 300 && json?.status === true, message: String(json?.message ?? text.slice(0, 200)), data: json?.data };
  }
  async function attempt(method: "GET" | "POST", path: string, body?: unknown): Promise<Answer | Error> {
    try { return await call(method, path, body); } catch (e) { return e as Error; }
  }

  const metadataUser = (m: unknown): string | null => {
    const obj = typeof m === "string" ? (() => { try { return JSON.parse(m); } catch { return null; } })() : m;
    return obj && typeof obj === "object" && typeof (obj as any).userId === "string" ? (obj as any).userId : null;
  };

  function fromCharge(reference: string, d: any): ProviderCheck {
    const providerStatus = String(d?.status ?? "missing");
    const amountKobo = koboFrom(d?.amount);
    const status = CHARGE_STATUS[providerStatus] ?? "unknown";
    if (status === "success" && amountKobo === null) return unknownCheck(reference, `unreadable amount ${d?.amount}`, providerStatus);
    return { status, providerStatus, reference: d?.reference ?? null, amountKobo, currency: d?.currency ?? null, userId: metadataUser(d?.metadata), feeKobo: null, error: status === "unknown" ? `unmapped status ${providerStatus}` : null };
  }
  function fromTransfer(reference: string, d: any): ProviderCheck {
    const providerStatus = String(d?.status ?? "missing");
    const amountKobo = koboFrom(d?.amount);
    const status = TRANSFER_STATUS[providerStatus] ?? "unknown";
    if (status === "success" && amountKobo === null) return unknownCheck(reference, `unreadable amount ${d?.amount}`, providerStatus);
    return { status, providerStatus, reference: d?.reference ?? reference, amountKobo, currency: d?.currency ?? null, userId: null, feeKobo: koboFrom(d?.fee_charged), error: status === "unknown" ? `unmapped status ${providerStatus}` : null };
  }
  /** A verify or query answer: not found, a definite record, or unknown for anything else. */
  function readAnswer(reference: string, a: Answer | Error, read: (ref: string, d: any) => ProviderCheck): ProviderCheck {
    if (a instanceof Error) return unknownCheck(reference, a.message);
    if (isNotFound(a)) return { ...unknownCheck(reference, a.message, "not_found"), status: "not_found", error: null };
    if (!a.ok) return unknownCheck(reference, `${a.http} ${a.message}`, `http_${a.http}`);
    return read(reference, a.data);
  }

  async function listAll(path: string, range: DateRange, read: (d: any) => ProviderRecord): Promise<ProviderRecord[]> {
    const out: ProviderRecord[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const a = await call("GET", `${path}?perPage=${PAGE_SIZE}&page=${page}&from=${range.from.toISOString()}&to=${range.to.toISOString()}`);
      if (!a.ok) throw new Error(`paystack ${path}: ${a.http} ${a.message}`);
      const rows = (a.data ?? []) as any[];
      out.push(...rows.map(read));
      if (rows.length < PAGE_SIZE) return out;
    }
    throw new Error(`paystack ${path}: more than ${MAX_PAGES * PAGE_SIZE} rows in one day`);
  }

  function readEvent(rawBody: Buffer): WebhookEvent {
    const { event, data } = JSON.parse(rawBody.toString("utf8")) as { event: string; data: any };
    const type = event === "charge.success" ? "topup" : event?.startsWith("transfer.") ? "transfer" : "other";
    return {
      eventId: createHash("sha256").update(rawBody).digest("hex"), type, name: String(event), reference: data?.reference ?? null,
      providerStatus: String(data?.status ?? event), amountKobo: koboFrom(data?.amount), currency: data?.currency ?? null, userId: metadataUser(data?.metadata),
    };
  }

  return {
    name: PAYSTACK,
    webhookIps: WEBHOOK_IPS,
    collection: {
      async createTopup(input) {
        assertDeliverableEmail(input.email, PAYSTACK);
        const a = await call("POST", "/transaction/initialize", {
          email: input.email, amount: input.amountKobo, currency: input.currency, reference: input.reference,
          ...(input.returnUrl ? { callback_url: input.returnUrl } : {}), metadata: { userId: input.userId, reference: input.reference },
        });
        // A 4xx: Paystack refused it (bad email, amount, key…), so no transaction exists. Anything else: we can't be sure.
        if (a.http >= 400 && a.http < 500) throw new ProviderRefusal(a.message, a.http);
        if (!a.ok || typeof a.data?.authorization_url !== "string") throw new Error(`paystack initialize: ${a.http} ${a.message}`);
        return { checkoutUrl: a.data.authorization_url };
      },
      async verifyTopup(reference) {
        return readAnswer(reference, await attempt("GET", `/transaction/verify/${encodeURIComponent(reference)}`), fromCharge);
      },
      listTopups: (range) => listAll("/transaction", range, (d) => {
        const c = fromCharge(String(d.reference), d);
        return { reference: String(d.reference), amountKobo: c.amountKobo ?? -1, status: c.status, providerStatus: c.providerStatus };
      }),
    },
    payout: {
      banks: {
        async listBanks() {
          const banks = new Map<string, Bank>();
          for (let page = 1; page <= MAX_PAGES; page++) {
            const a = await call("GET", `/bank?country=nigeria&currency=NGN&perPage=${PAGE_SIZE}&page=${page}`);
            if (!a.ok) throw new Error(`paystack banks: ${a.http} ${a.message}`);
            const rows = (a.data ?? []) as any[];
            for (const b of rows) if (b.active !== false && b.code && !banks.has(String(b.code))) banks.set(String(b.code), { code: String(b.code), name: String(b.name) });
            if (rows.length < PAGE_SIZE) break;
          }
          return [...banks.values()].sort((x, y) => x.name.localeCompare(y.name));
        },
        async resolveAccount({ bankCode, accountNumber }) {
          const a = await call("GET", `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`);
          if (a.ok && typeof a.data?.account_name === "string") return { accountName: a.data.account_name };
          if (a.http === 400 || a.http === 404 || a.http === 422) return null;
          throw new Error(`paystack resolve: ${a.http} ${a.message}`);
        },
      },
      async createRecipient(d) {
        const a = await call("POST", "/transferrecipient", { type: "nuban", name: d.accountName, account_number: d.accountNumber, bank_code: d.bankCode, currency: "NGN" });
        if (!a.ok || typeof a.data?.recipient_code !== "string") throw new Error(`paystack recipient: ${a.http} ${a.message}`);
        return { recipientCode: a.data.recipient_code };
      },
      transferFeeTiers: PAYSTACK_TRANSFER_FEE_TIERS,
      async sendTransfer(input) {
        const a = await attempt("POST", "/transfer", { source: "balance", amount: input.amountKobo, recipient: input.recipientCode, reference: input.reference, reason: input.reason, currency: "NGN" });
        if (a instanceof Error) return unknownCheck(input.reference, a.message, "no_answer");
        if (a.ok) return fromTransfer(input.reference, a.data);
        if (a.http >= 400 && a.http < 500 && DEFINITE_TRANSFER_REFUSALS.some((re) => re.test(a.message))) {
          return { status: "failed", providerStatus: `refused: ${a.message}`, reference: input.reference, amountKobo: input.amountKobo, currency: "NGN", userId: null, feeKobo: null, error: null };
        }
        return unknownCheck(input.reference, `${a.http} ${a.message}`, `http_${a.http}`);
      },
      async queryTransfer(reference) {
        return readAnswer(reference, await attempt("GET", `/transfer/verify/${encodeURIComponent(reference)}`), fromTransfer);
      },
      listTransfers: (range) => listAll("/transfer", range, (d) => {
        const c = fromTransfer(String(d.reference), d);
        return { reference: String(d.reference), amountKobo: c.amountKobo ?? -1, status: c.status, providerStatus: c.providerStatus };
      }),
    },
    parseWebhook(rawBody: Buffer, headers: Headers) {
      const given = headers["x-paystack-signature"];
      if (typeof given !== "string" || !/^[0-9a-f]+$/i.test(given)) return null;
      const want = createHmac("sha512", opts.secretKey).update(rawBody).digest();
      const got = Buffer.from(given, "hex");
      if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
      return readEvent(rawBody);
    },
    readWebhook: readEvent,
  };
}

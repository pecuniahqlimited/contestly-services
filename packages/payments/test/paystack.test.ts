/**
 * Paystack with its HTTP faked: the requests we send, and how every answer maps into our statuses. The
 * rule: only Paystack's definite words become success or failed; everything else is unknown (or not_found).
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { paystackProvider, paystackTransferFeeKobo, type Fetch } from "../src/providers/paystack.js";
import { ProviderRefusal } from "../src/types.js";

const SECRET = "sk_test_unit";
type Call = { method: string; url: string; body: any; auth: string };

/** A fake Paystack: answers each call from the handler; a thrown error is a network failure. */
function fake(handler: (c: Call) => { status: number; body: unknown } | Error) {
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init) => {
    const c = { method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers.authorization };
    calls.push(c);
    const r = handler(c);
    if (r instanceof Error) throw r;
    return { status: r.status, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) };
  };
  return { p: paystackProvider({ secretKey: SECRET, fetch }), calls };
}
const ok = (data: unknown) => ({ status: 200, body: { status: true, message: "ok", data } });
const err = (status: number, message: string) => ({ status, body: { status: false, message } });

describe("collections", () => {
  it("starts a checkout with our reference, the amount in kobo and the user in the metadata", async () => {
    const { p, calls } = fake(() => ok({ authorization_url: "https://checkout.paystack.com/abc", reference: "tp-1" }));
    const out = await p.collection!.createTopup({ reference: "tp-1", amountKobo: 50_000, currency: "NGN", userId: "u1", email: "a@b.c", returnUrl: "contestly://wallet" });
    expect(out.checkoutUrl).toBe("https://checkout.paystack.com/abc");
    expect(calls[0]).toMatchObject({ method: "POST", url: "https://api.paystack.co/transaction/initialize", auth: `Bearer ${SECRET}` });
    expect(calls[0].body).toEqual({ email: "a@b.c", amount: 50_000, currency: "NGN", reference: "tp-1", callback_url: "contestly://wallet", metadata: { userId: "u1", reference: "tp-1" } });
  });

  const start = (p: ReturnType<typeof fake>["p"], email: string) => p.collection!.createTopup({ reference: "tp-1", amountKobo: 50_000, currency: "NGN", userId: "u", email, returnUrl: null });

  it("a 4xx at initialize is a refusal with Paystack's message (no transaction exists)", async () => {
    const { p } = fake(() => err(400, '"email" must be a valid email'));
    const e = await start(p, "ada@gmail.com").catch((x) => x);
    expect(e).toBeInstanceOf(ProviderRefusal);
    expect([e.message, e.httpStatus]).toEqual(['"email" must be a valid email', 400]);
  });

  it("a 5xx or no answer at initialize is not a refusal: we can't be sure what Paystack did", async () => {
    for (const answer of [err(500, "Internal error"), new Error("ETIMEDOUT")]) {
      const e = await start(fake(() => answer).p, "ada@gmail.com").catch((x) => x);
      expect(e).toBeInstanceOf(Error);
      expect(e).not.toBeInstanceOf(ProviderRefusal);
    }
  });

  it("never sends a reserved test domain to Paystack: refused before any call", async () => {
    for (const email of ["tunde@dev.contestly.invalid", "a@b.test", "x@example.com", "y@mail.example.org", "z@host.localhost"]) {
      const { p, calls } = fake(() => ok({ authorization_url: "https://x" }));
      const e = await start(p, email).catch((x) => x);
      expect(e, email).toBeInstanceOf(ProviderRefusal);
      expect(e.message, email).toMatch(/reserved domain .* paystack can't send to/);
      expect(calls, email).toHaveLength(0);
    }
  });

  it("maps verify answers", async () => {
    const cases: [ReturnType<Parameters<typeof fake>[0]>, string, Partial<{ amountKobo: number | null; userId: string | null; currency: string | null }>?][] = [
      [ok({ status: "success", reference: "r", amount: 50_000, currency: "NGN", metadata: { userId: "u1" } }), "success", { amountKobo: 50_000, userId: "u1", currency: "NGN" }],
      [ok({ status: "success", reference: "r", amount: 50_000, currency: "NGN", metadata: JSON.stringify({ userId: "u2" }) }), "success", { userId: "u2" }],
      [ok({ status: "failed", reference: "r", amount: 50_000 }), "failed"],
      [ok({ status: "abandoned", reference: "r", amount: 50_000 }), "pending"],
      [ok({ status: "ongoing", reference: "r" }), "pending"],
      [ok({ status: "reversed", reference: "r", amount: 50_000 }), "unknown"],
      [ok({ status: "something_new", reference: "r" }), "unknown"],
      [ok({ status: "success", reference: "r", amount: 500.5, currency: "NGN" }), "unknown"],
      [err(404, "Transaction reference not found"), "not_found"],
      [err(400, "Transaction reference not found"), "not_found"],
      [err(500, "Internal error"), "unknown"],
      [{ status: 502, body: "<html>Bad gateway</html>" }, "unknown"],
      [err(401, "Invalid key"), "unknown"],
      [new Error("ETIMEDOUT"), "unknown"],
    ];
    for (const [answer, status, extra] of cases) {
      const { p, calls } = fake(() => answer);
      const c = await p.collection!.verifyTopup("tp-abc");
      expect(c.status, JSON.stringify(answer)).toBe(status);
      if (extra) expect(c).toMatchObject(extra);
      expect(calls[0].url).toBe("https://api.paystack.co/transaction/verify/tp-abc");
    }
  });
});

describe("webhooks", () => {
  const body = JSON.stringify({ event: "charge.success", data: { reference: "tp-1", amount: 50_000, currency: "NGN", status: "success", metadata: { userId: "u1" } } });
  const sig = (b: string, key = SECRET) => createHmac("sha512", key).update(b).digest("hex");

  it("accepts HMAC-SHA512 of the raw body with the secret key, and reads it", () => {
    const { p } = fake(() => ok({}));
    const ev = p.parseWebhook(Buffer.from(body), { "x-paystack-signature": sig(body) });
    expect(ev).toMatchObject({ type: "topup", name: "charge.success", reference: "tp-1", amountKobo: 50_000, currency: "NGN", userId: "u1" });
    // The same body is the same event (a redelivery).
    expect(p.parseWebhook(Buffer.from(body), { "x-paystack-signature": sig(body) })!.eventId).toBe(ev!.eventId);
  });

  it("refuses a wrong key, a changed body, a missing or malformed signature", () => {
    const { p } = fake(() => ok({}));
    expect(p.parseWebhook(Buffer.from(body), { "x-paystack-signature": sig(body, "sk_test_other") })).toBeNull();
    expect(p.parseWebhook(Buffer.from(body.replace("50000", "90000")), { "x-paystack-signature": sig(body) })).toBeNull();
    expect(p.parseWebhook(Buffer.from(body), {})).toBeNull();
    expect(p.parseWebhook(Buffer.from(body), { "x-paystack-signature": "zz" })).toBeNull();
  });

  it("reads transfer events as transfers", () => {
    const { p } = fake(() => ok({}));
    const t = JSON.stringify({ event: "transfer.reversed", data: { reference: "po-1", amount: 100_000, status: "reversed" } });
    expect(p.readWebhook(Buffer.from(t))).toMatchObject({ type: "transfer", reference: "po-1", providerStatus: "reversed", amountKobo: 100_000 });
  });
});

describe("payouts", () => {
  it("lists active banks once each, by name", async () => {
    const { p } = fake(() => ok([{ code: "058", name: "GTBank", active: true }, { code: "044", name: "Access Bank", active: true }, { code: "058", name: "GTBank dup" }, { code: "999", name: "Closed", active: false }]));
    expect(await p.payout!.banks!.listBanks()).toEqual([{ code: "044", name: "Access Bank" }, { code: "058", name: "GTBank" }]);
  });

  it("resolves an account: a name, null when the bank says no such account, and a throw when Paystack can't answer", async () => {
    expect(await fake(() => ok({ account_name: "ADA OKAFOR", account_number: "0123456789" })).p.payout!.banks!.resolveAccount({ bankCode: "058", accountNumber: "0123456789" })).toEqual({ accountName: "ADA OKAFOR" });
    expect(await fake(() => err(422, "Could not resolve account name")).p.payout!.banks!.resolveAccount({ bankCode: "058", accountNumber: "0" })).toBeNull();
    await expect(fake(() => err(500, "down")).p.payout!.banks!.resolveAccount({ bankCode: "058", accountNumber: "0" })).rejects.toThrow();
  });

  it("creates a NUBAN recipient", async () => {
    const { p, calls } = fake(() => ok({ recipient_code: "RCP_1" }));
    expect(await p.payout!.createRecipient({ kind: "bank", bankCode: "058", accountNumber: "0123456789", accountName: "ADA OKAFOR" })).toEqual({ recipientCode: "RCP_1" });
    expect(calls[0].body).toEqual({ type: "nuban", name: "ADA OKAFOR", account_number: "0123456789", bank_code: "058", currency: "NGN" });
  });

  it("sends with our reference as Paystack's, and maps every answer", async () => {
    const send = { reference: "po-1", amountKobo: 150_000, recipientCode: "RCP_1", reason: "Contestly withdrawal" };
    const cases: [ReturnType<Parameters<typeof fake>[0]>, string][] = [
      [ok({ status: "success", reference: "po-1", amount: 150_000 }), "success"],
      [ok({ status: "pending", reference: "po-1", amount: 150_000 }), "pending"],
      [ok({ status: "received", reference: "po-1", amount: 150_000 }), "pending"],
      [ok({ status: "otp", reference: "po-1", amount: 150_000 }), "unknown"],
      [ok({ status: "failed", reference: "po-1", amount: 150_000 }), "failed"],
      [err(400, "Your balance is not enough to fulfil this request"), "failed"],
      [err(400, "Insufficient balance"), "failed"],
      [err(400, "Invalid recipient"), "failed"],
      [err(400, "Duplicate Transfer: reference already exists"), "unknown"],
      [err(400, "You cannot initiate third party payouts as a starter business"), "unknown"],
      [err(401, "Invalid key"), "unknown"],
      [err(500, "Internal error"), "unknown"],
      [{ status: 504, body: "gateway timeout" }, "unknown"],
      [new Error("socket hang up"), "unknown"],
    ];
    for (const [answer, status] of cases) {
      const { p, calls } = fake(() => answer);
      expect((await p.payout!.sendTransfer(send)).status, JSON.stringify(answer)).toBe(status);
      expect(calls[0].body).toEqual({ source: "balance", amount: 150_000, recipient: "RCP_1", reference: "po-1", reason: "Contestly withdrawal", currency: "NGN" });
    }
  });

  it("queries by our reference: success with the fee, reversed is a failure, not found, unknown", async () => {
    const q = (answer: ReturnType<Parameters<typeof fake>[0]>) => fake(() => answer).p.payout!.queryTransfer("po-1");
    expect(await q(ok({ status: "success", reference: "po-1", amount: 150_000, fee_charged: 1_000 }))).toMatchObject({ status: "success", amountKobo: 150_000, feeKobo: 1_000 });
    expect((await q(ok({ status: "reversed", reference: "po-1", amount: 150_000 }))).status).toBe("failed");
    expect((await q(err(404, "Transfer not found"))).status).toBe("not_found");
    expect((await q(err(503, "unavailable"))).status).toBe("unknown");
    expect((await q(ok({ status: "success", reference: "po-1", amount: "abc" }))).status).toBe("unknown");
  });

  it("charges Paystack's published fee", () => {
    expect([paystackTransferFeeKobo(500_000), paystackTransferFeeKobo(500_001), paystackTransferFeeKobo(5_000_000), paystackTransferFeeKobo(5_000_001)]).toEqual([1_000, 2_500, 2_500, 5_000]);
  });

  it("lists a day's transfers across pages", async () => {
    let page = 0;
    const { p } = fake(() => { page++; return ok(Array.from({ length: page === 1 ? 100 : 3 }, (_, i) => ({ reference: `po-${page}-${i}`, amount: 1000, status: "success" }))); });
    const rows = await p.payout!.listTransfers({ from: new Date("2031-01-01T00:00:00Z"), to: new Date("2031-01-02T00:00:00Z") });
    expect(rows).toHaveLength(103);
    expect(rows[0]).toEqual({ reference: "po-1-0", amountKobo: 1000, status: "success", providerStatus: "success" });
  });
});

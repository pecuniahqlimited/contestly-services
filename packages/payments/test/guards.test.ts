/** The pure guards: no live key outside production; reconciliation's comparison; the requery backoff. */
import { describe, expect, it } from "vitest";
import { assertPaymentsEnv } from "../src/providers/index.js";
import { compare } from "../src/reconcile.js";
import { backoffMs } from "../src/common.js";
import { reservedEmailDomain } from "../src/types.js";

describe("reserved email domains", () => {
  it("are the ones that can never receive mail, and nothing else", () => {
    expect(["a@dev.contestly.invalid", "a@x.test", "a@x.example", "a@localhost", "a@example.com", "a@sub.example.net", "A@EXAMPLE.ORG"].map(reservedEmailDomain))
      .toEqual([".invalid", ".test", ".example", ".localhost", "example.com", "example.net", "example.org"]);
    expect(["a@gmail.com", "a@contestly.ng", "a@notexample.com", "a@example.com.ng", "a@invalid.com"].map(reservedEmailDomain)).toEqual([null, null, null, null, null]);
  });
});

describe("live keys", () => {
  it("refuse to run outside production, from any variable", () => {
    expect(() => assertPaymentsEnv({ NODE_ENV: "development", PAYSTACK_SECRET_KEY: "sk_live_x" })).toThrow(/PAYSTACK_SECRET_KEY/);
    expect(() => assertPaymentsEnv({ PAYSTACK_SECRET_KEY: " sk_live_x" })).toThrow();
    expect(() => assertPaymentsEnv({ NODE_ENV: "test", OTHER_PROVIDER_KEY: "sk_live_y" })).toThrow(/OTHER_PROVIDER_KEY/);
  });
  it("are fine in production, and test keys are fine anywhere", () => {
    expect(() => assertPaymentsEnv({ NODE_ENV: "production", PAYSTACK_SECRET_KEY: "sk_live_x" })).not.toThrow();
    expect(() => assertPaymentsEnv({ NODE_ENV: "development", PAYSTACK_SECRET_KEY: "sk_test_x" })).not.toThrow();
  });
});

describe("reconciliation", () => {
  const rec = (reference: string, amountKobo: number, status: "success" | "failed" | "pending") => ({ reference, amountKobo, status, providerStatus: status });
  it("finds each kind of difference, and nothing when both sides agree", () => {
    const items = compare("topup", [
      { reference: "same", amountKobo: 100, status: "succeeded" },
      { reference: "gone", amountKobo: 100, status: "succeeded" },
      { reference: "unpaid", amountKobo: 100, status: "expired" },
      { reference: "amount", amountKobo: 100, status: "succeeded" },
      { reference: "missed", amountKobo: 100, status: "pending" },
    ], [rec("same", 100, "success"), rec("amount", 150, "success"), rec("missed", 100, "success"), rec("stray", 100, "success"), rec("noise", 100, "failed")]);
    expect(items.map((i) => [i.reference, i.kind])).toEqual([["stray", "missing_ours"], ["gone", "missing_theirs"], ["amount", "amount_differs"], ["missed", "status_differs"]]);
  });
  it("payouts: never sent isn't missing; sent and absent is; reversed but paid differs", () => {
    const items = compare("payout", [
      { reference: "waiting", amountKobo: 100, status: "awaiting_approval" },
      { reference: "lost", amountKobo: 100, status: "unknown" },
      { reference: "paid-anyway", amountKobo: 100, status: "failed" },
      { reference: "ok", amountKobo: 100, status: "succeeded" },
    ], [rec("paid-anyway", 100, "success"), rec("ok", 100, "success")]);
    expect(items.map((i) => [i.reference, i.kind])).toEqual([["lost", "missing_theirs"], ["paid-anyway", "status_differs"]]);
  });
});

describe("backoff", () => {
  it("doubles from the first wait and stops at the cap", () => {
    expect([0, 1, 2, 3, 10, 40].map((n) => backoffMs(n, 30, 3600) / 1000)).toEqual([30, 60, 120, 240, 3600, 3600]);
  });
});

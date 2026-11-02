/**
 * The pure guards: the payments env (live and non-test keys, dev tools, webhook secrets); reconciliation's
 * comparison; the requery backoff; a resend's refusal; when one admin may finalize; what loosens a control.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_PAYMENTS_CONFIG, type PaymentsConfig } from "@contestly/shared";
import type { Payout, Topup } from "@contestly/db";
import { assertPaymentsEnv, defaultProviderName, paymentsDevTools } from "../src/providers/index.js";
import { onResend } from "../src/payouts.js";
import { assertQuietSinceSend, judge } from "../src/finalize.js";
import { configLoosens, settingsLoosens } from "../src/controls.js";
import { isAcknowledged, repeatedBreaches } from "../src/invariants.js";
import type { ProviderCheck } from "../src/types.js";
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
  it("outside production, a Paystack key that isn't a test key refuses to start", () => {
    for (const key of ["rk_live_x", "pk_test_x", "sk_x", "whatever"]) expect(() => assertPaymentsEnv({ NODE_ENV: "staging", PAYSTACK_SECRET_KEY: key }), key).toThrow(/isn't a test key/);
    expect(() => assertPaymentsEnv({ PAYSTACK_SECRET_KEY: "" })).not.toThrow();
  });
});

describe("dev tools (mock provider, mock checkout, dev top-up)", () => {
  it("only with PAYMENTS_DEV_TOOLS=true, and never in production whatever it says", () => {
    expect(paymentsDevTools({ PAYMENTS_DEV_TOOLS: "true", NODE_ENV: "development" })).toBe(true);
    expect(paymentsDevTools({ PAYMENTS_DEV_TOOLS: "true" })).toBe(true);
    expect(paymentsDevTools({ PAYMENTS_DEV_TOOLS: "true", NODE_ENV: "production" })).toBe(false);
    expect(paymentsDevTools({ NODE_ENV: "development" })).toBe(false);
    expect(paymentsDevTools({ PAYMENTS_DEV_TOOLS: "1" })).toBe(false);
  });
  it("need the mock's webhook secret: there is no default", () => {
    expect(() => assertPaymentsEnv({ PAYMENTS_DEV_TOOLS: "true" })).toThrow(/MOCK_PAYMENTS_WEBHOOK_SECRET/);
    expect(() => assertPaymentsEnv({ PAYMENTS_DEV_TOOLS: "true", MOCK_PAYMENTS_WEBHOOK_SECRET: "s" })).not.toThrow();
    expect(() => assertPaymentsEnv({ PAYMENTS_DEV_TOOLS: "true", NODE_ENV: "production" })).not.toThrow(); // off in production anyway
  });
  it("the default provider is the mock only with them on", () => {
    expect(defaultProviderName({ PAYMENTS_DEV_TOOLS: "true" })).toBe("mock");
    expect(defaultProviderName({ NODE_ENV: "development" })).toBe("paystack");
    expect(defaultProviderName({ PAYMENTS_DEV_TOOLS: "true", NODE_ENV: "production" })).toBe("paystack");
  });
});

const check = (status: ProviderCheck["status"], extra: Partial<ProviderCheck> = {}): ProviderCheck =>
  ({ status, providerStatus: status, reference: null, amountKobo: null, currency: null, userId: null, feeKobo: null, error: null, ...extra });

describe("a resend's answer", () => {
  it("is never a definite failure: a refusal becomes unknown; everything else passes through", () => {
    const refused = onResend(check("failed", { providerStatus: "refused: Insufficient balance" }));
    expect([refused.status, refused.providerStatus]).toEqual(["unknown", "resend_refused: refused: Insufficient balance"]);
    for (const s of ["success", "pending", "not_found", "unknown"] as const) expect(onResend(check(s)).status).toBe(s);
  });
});

describe("manual finalize", () => {
  const cfg = structuredClone(DEFAULT_PAYMENTS_CONFIG);
  const payout = { amountKobo: 200_000, sentKobo: 200_000, lastSentAt: null, submittedAt: null } as unknown as Payout;
  const topup = { amountKobo: 50_000, reference: "tp-1", userId: "u1" } as unknown as Topup;
  it("one admin only when the provider's fresh answer is definite and agrees, under the threshold", () => {
    expect(judge("payout", payout, "failed", check("failed"), cfg).secondAdminBecause).toEqual([]);
    expect(judge("payout", payout, "success", check("success", { amountKobo: 200_000 }), cfg).secondAdminBecause).toEqual([]);
    expect(judge("payout", payout, "failed", check("not_found"), cfg).secondAdminBecause).toEqual(["check_not_definite"]);
    expect(judge("payout", payout, "failed", check("pending"), cfg).secondAdminBecause).toEqual(["check_not_definite"]);
    expect(judge("payout", payout, "failed", check("success"), cfg).secondAdminBecause).toEqual(["check_disagrees"]);
    expect(judge("payout", payout, "success", check("success", { amountKobo: 1 }), cfg).secondAdminBecause).toEqual(["amount_differs"]);
    const big = { ...payout, amountKobo: cfg.finalize.secondAdminThresholdKobo } as Payout;
    expect(judge("payout", big, "failed", check("failed"), cfg).secondAdminBecause).toEqual(["over_threshold"]);
  });
  it("a top-up is credited with the provider-verified amount, never our own; a different amount needs a second admin", () => {
    const ok = judge("topup", topup, "success", check("success", { amountKobo: 50_000, currency: "NGN", reference: "tp-1", userId: "u1" }), cfg);
    expect(ok).toEqual({ amountKobo: 50_000, secondAdminBecause: [] });
    const more = judge("topup", topup, "success", check("success", { amountKobo: 50_100, currency: "NGN", reference: "tp-1", userId: "u1" }), cfg);
    expect(more).toEqual({ amountKobo: 50_100, secondAdminBecause: ["amount_differs"] });
    expect(judge("topup", topup, "success", check("success", { amountKobo: 50_000, currency: "NGN", userId: "someone else" }), cfg).secondAdminBecause).toEqual(["check_disagrees"]);
    for (const c of [check("not_found"), check("pending"), check("failed", { amountKobo: 50_000 }), check("success", { amountKobo: null }), check("success", { amountKobo: 50_000, currency: "USD" })]) {
      expect(() => judge("topup", topup, "success", c, cfg)).toThrow("no_verified_amount");
    }
    expect(judge("topup", topup, "failed", check("not_found"), cfg).secondAdminBecause).toEqual(["check_not_definite"]);
  });
  it("a sent payout waits out the resend window and the quiet period after its last send", () => {
    const sent = new Date("2031-01-01T12:00:00Z");
    const p = { ...payout, lastSentAt: sent } as Payout;
    const quiet = Math.max(cfg.checks.resendAfterNotFoundSeconds * 1000, cfg.finalize.quietAfterSendMinutes * 60_000);
    expect(() => assertQuietSinceSend(p, cfg, new Date(sent.getTime() + quiet - 1))).toThrow("finalize_too_soon");
    expect(() => assertQuietSinceSend(p, cfg, new Date(sent.getTime() + quiet))).not.toThrow();
    const longResend = { ...cfg, checks: { ...cfg.checks, resendAfterNotFoundSeconds: 3 * 3600 } };
    expect(() => assertQuietSinceSend(p, longResend, new Date(sent.getTime() + 2 * 3600_000))).toThrow("finalize_too_soon");
    expect(() => assertQuietSinceSend(payout, cfg, sent)).not.toThrow(); // never sent
  });
});

describe("what loosens a control", () => {
  const base = DEFAULT_PAYMENTS_CONFIG;
  const edit = (f: (c: PaymentsConfig) => void) => { const c = structuredClone(base); f(c); return c; };
  it("raising a limit or threshold, lowering a minimum or a safety delay, or any other change loosens", () => {
    expect(configLoosens(base, edit((c) => { c.payout.maxKobo += 1; }))).toEqual(["payout.maxKobo"]);
    expect(configLoosens(base, edit((c) => { c.finalize.secondAdminThresholdKobo *= 2; c.payout.approvalThresholdKobo *= 2; }))).toEqual(["finalize.secondAdminThresholdKobo", "payout.approvalThresholdKobo"]);
    expect(configLoosens(base, edit((c) => { c.payout.minKobo -= 1; }))).toEqual(["payout.minKobo"]);
    expect(configLoosens(base, edit((c) => { c.checks.resendAfterNotFoundSeconds = 60; }))).toEqual(["checks.resendAfterNotFoundSeconds"]);
    expect(configLoosens(base, edit((c) => { c.payout.feeBearer = "user"; }))).toEqual(["payout.feeBearer"]);
    // A change that tightens one thing and loosens another loosens.
    expect(configLoosens(base, edit((c) => { c.payout.maxKobo -= 1; c.topup.maxKobo += 1; }))).toEqual(["topup.maxKobo"]);
  });
  it("lowering limits and thresholds, raising minimums: tightening, one admin", () => {
    expect(configLoosens(base, base)).toEqual([]);
    expect(configLoosens(base, edit((c) => { c.payout.maxKobo -= 1; c.payout.dailyCount = 1; c.finalize.secondAdminThresholdKobo = 1; c.payout.minKobo += 1; c.finalize.quietAfterSendMinutes += 10; }))).toEqual([]);
  });
  it("settings: switching a provider or un-pausing loosens; pausing doesn't", () => {
    const s = { collections: "mock", payouts: "mock", topupsPaused: false, payoutsPaused: false };
    expect(settingsLoosens(s, { ...s, payoutsPaused: true, topupsPaused: true })).toEqual([]);
    expect(settingsLoosens({ ...s, payoutsPaused: true }, s)).toEqual(["payouts_unpaused"]);
    expect(settingsLoosens(s, { ...s, collections: "paystack" })).toEqual(["collections"]);
    expect(settingsLoosens(s, { ...s, payouts: "paystack", payoutsPaused: true })).toEqual(["payouts"]);
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

describe("invariant breaches", () => {
  it("only ones the second snapshot finds again count; the rest are transient; a new one in the second read waits for the next run", () => {
    const b = (kind: string) => ({ kind, detail: {}, items: {} });
    expect(repeatedBreaches([b("provider_topup_in"), b("balance_drift")], [b("balance_drift"), b("closed_party_pot")]))
      .toEqual({ breaches: [b("balance_drift")], transient: ["provider_topup_in"] });
    expect(repeatedBreaches([b("x")], [])).toEqual({ breaches: [], transient: ["x"] });
  });
});

describe("acknowledged breaches", () => {
  const b = (items: Record<string, number>) => ({ kind: "closed_party_pot", detail: {}, items });
  it("cover the same items at no larger magnitude; a new item or a bigger one isn't covered", () => {
    const acks = [{ p1: 500, p2: 100 }, { p3: 50 }];
    expect(isAcknowledged(b({ p1: 500 }), acks)).toBe(true);
    expect(isAcknowledged(b({ p1: 400, p3: 50 }), acks)).toBe(true);
    expect(isAcknowledged(b({ p1: 501 }), acks)).toBe(false);
    expect(isAcknowledged(b({ p1: 500, p4: 1 }), acks)).toBe(false);
    expect(isAcknowledged(b({ p1: 1 }), [])).toBe(false);
  });
});

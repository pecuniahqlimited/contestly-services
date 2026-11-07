import { describe, expect, it } from "vitest";
import { Breakers, MemorySink, noBudget, paidCapMicrosFromEnv, ProviderError, ProviderUnavailable, providerCall, withCallContext, type CallDeps } from "../src/index.js";

const spec = { provider: "anthropic" as const, model: "claude-sonnet-5-5" as const, step: "generate" as const };
const deps = (over: Partial<CallDeps> = {}): CallDeps & { sink: MemorySink } => ({
  sink: new MemorySink(), budget: noBudget, breakers: new Breakers({ failureThreshold: 2, cooldownMs: 60_000 }),
  retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 }, timeoutMs: 1000, sleep: async () => {}, log: () => {},
  // Fakes only, so paid calls are allowed on purpose here.
  paidCapMicros: Number.POSITIVE_INFINITY, ...over,
}) as CallDeps & { sink: MemorySink };
const usage = { inputTokens: 1000, outputTokens: 2000 };

describe("providerCall", () => {
  it("records model, step, party, job, tokens and cost for a success", async () => {
    const d = deps();
    const v = await withCallContext({ partyId: "p1", job: "generate_set" }, () => providerCall(spec, d, async () => ({ value: 42, usage })));
    expect(v).toBe(42);
    expect(d.sink.records).toHaveLength(1);
    // Sonnet 5.5: 1000 × $2/M + 2000 × $10/M = $0.022
    expect(d.sink.records[0]).toMatchObject({ ...spec, partyId: "p1", job: "generate_set", inputTokens: 1000, outputTokens: 2000, costMicros: 22_000, outcome: "ok", attempts: 1 });
  });

  it("retries a rate limit, then records the attempts", async () => {
    const d = deps();
    let n = 0;
    await providerCall(spec, d, async () => {
      if (n++ === 0) throw new ProviderError("rate_limited", "HTTP 429");
      return { value: 1, usage };
    });
    expect(d.sink.records[0]).toMatchObject({ outcome: "ok", attempts: 2 });
  });

  it("refuses a call over budget, without calling the provider", async () => {
    const d = deps({ budget: { check: async () => "today's provider budget ($25.00) is spent" } });
    let called = false;
    const err = await providerCall(spec, d, async () => { called = true; return { value: 1, usage }; }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderUnavailable);
    expect(err.kind).toBe("budget");
    expect(called).toBe(false);
    expect(d.sink.records[0]).toMatchObject({ outcome: "budget", costMicros: 0 });
  });

  it("opens the circuit after repeated failures and stops calling", async () => {
    const d = deps();
    let calls = 0;
    const failing = async (): Promise<never> => { calls++; throw new ProviderError("malformed", "not JSON"); };
    for (let i = 0; i < 2; i++) await expect(providerCall(spec, d, failing)).rejects.toBeInstanceOf(ProviderUnavailable);
    const err = await providerCall(spec, d, failing).catch((e) => e);
    expect(err.kind).toBe("circuit_open");
    expect(calls).toBe(2);
    expect(d.sink.records.map((r) => r.outcome)).toEqual(["malformed", "malformed", "circuit_open"]);
  });

  it("turns an unexpected throw into unavailable, never a crash", async () => {
    const err = await providerCall(spec, deps(), async () => { throw new TypeError("x is undefined"); }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderUnavailable);
  });

  it("a failing usage sink doesn't fail the call", async () => {
    const d = deps({ sink: { record: async () => { throw new Error("db down"); } } as never });
    await expect(providerCall(spec, d, async () => ({ value: "ok", usage }))).resolves.toBe("ok");
  });
});

describe("the paid cap", () => {
  it("at $0 a paid call is refused before anything runs: no request, no budget check, a refused row", async () => {
    let ran = 0;
    let budgetAsked = 0;
    const d = deps({ paidCapMicros: 0, budget: { check: async () => { budgetAsked++; return null; } } });
    const err = await providerCall(spec, d, async () => { ran++; return { value: 1, usage }; }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderUnavailable);
    expect(err).toMatchObject({ kind: "budget", message: expect.stringMatching(/paid providers are off \(AI_PAID_CAP_USD is 0\)/) });
    expect([ran, budgetAsked]).toEqual([0, 0]);
    expect(d.sink.records[0]).toMatchObject({ tier: "paid", outcome: "budget", requests: 0, costMicros: 0 });
  });

  it("a call nobody marked is paid; a free call is never stopped by the paid cap and costs nothing", async () => {
    const unmarked = deps({ paidCapMicros: 0 });
    await expect(providerCall(spec, unmarked, async () => ({ value: 1, usage }))).rejects.toMatchObject({ kind: "budget" });
    const free = deps({ paidCapMicros: 0 });
    const gemini = { provider: "gemini" as const, model: "gemini-3.5-flash-lite" as const, step: "generate" as const, tier: "free" as const };
    expect(await providerCall(gemini, free, async () => ({ value: 7, usage }))).toBe(7);
    expect(free.sink.records[0]).toMatchObject({ tier: "free", costMicros: 0, outcome: "ok", requests: 1 });
  });

  it("reads AI_PAID_CAP_USD: unset or empty is $0; a bad value is refused", () => {
    expect(paidCapMicrosFromEnv({})).toBe(0);
    expect(paidCapMicrosFromEnv({ AI_PAID_CAP_USD: "" })).toBe(0);
    expect(paidCapMicrosFromEnv({ AI_PAID_CAP_USD: "25" })).toBe(25_000_000);
    expect(() => paidCapMicrosFromEnv({ AI_PAID_CAP_USD: "lots" })).toThrow();
    expect(() => paidCapMicrosFromEnv({ AI_PAID_CAP_USD: "-1" })).toThrow();
  });
});

describe("the free tier's quota", () => {
  const gemini = { provider: "gemini" as const, model: "gemini-embedding-2" as const, step: "embed" as const, tier: "free" as const, requests: 16 };

  it("a spent daily quota refuses the call before it's made", async () => {
    let ran = 0;
    const asked: { model: string; requests: number }[] = [];
    const d = deps({ freeQuota: { check: async (q) => { asked.push(q); return "gemini-embedding-2's free daily quota is spent"; } } });
    await expect(providerCall(gemini, d, async () => { ran++; return { value: 1, usage }; })).rejects.toMatchObject({ kind: "rate_limited" });
    expect(ran).toBe(0);
    expect(asked).toEqual([{ model: "gemini-embedding-2", requests: 16 }]);
  });

  it("counts every request a call sends, retries included", async () => {
    const d = deps({ freeQuota: { check: async () => null } });
    let n = 0;
    await providerCall(gemini, d, async () => { if (n++ === 0) throw new ProviderError("server", "503"); return { value: 1, usage }; });
    expect(d.sink.records[0]).toMatchObject({ requests: 32, attempts: 2 });
  });
});

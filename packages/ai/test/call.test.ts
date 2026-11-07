import { describe, expect, it } from "vitest";
import { Breakers, MemorySink, noBudget, ProviderError, ProviderUnavailable, providerCall, withCallContext, type CallDeps } from "../src/index.js";

const spec = { provider: "anthropic" as const, model: "claude-sonnet-5-5" as const, step: "generate" as const };
const deps = (over: Partial<CallDeps> = {}): CallDeps & { sink: MemorySink } => ({
  sink: new MemorySink(), budget: noBudget, breakers: new Breakers({ failureThreshold: 2, cooldownMs: 60_000 }),
  retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 }, timeoutMs: 1000, sleep: async () => {}, log: () => {}, ...over,
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

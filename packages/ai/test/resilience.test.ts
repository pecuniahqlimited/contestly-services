import { describe, expect, it } from "vitest";
import { backoffMs, CircuitBreaker, ProviderError, retryAfterMs, withRetry, withTimeout } from "../src/index.js";

const fast = { attempts: 3, baseDelayMs: 100, maxDelayMs: 1000 };
const noSleep = async () => {};

describe("backoff", () => {
  it("grows with the attempt, is capped, and honours a longer Retry-After", () => {
    expect(backoffMs(0, fast, undefined, () => 1)).toBe(100);
    expect(backoffMs(2, fast, undefined, () => 1)).toBe(400);
    expect(backoffMs(9, fast, undefined, () => 1)).toBe(1000);
    expect(backoffMs(0, fast, 700, () => 0.5)).toBe(700);
    expect(backoffMs(0, fast, 5000, () => 0.5)).toBe(1000);
  });

  it("reads Retry-After in seconds or as a date", () => {
    expect(retryAfterMs("3")).toBe(3000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(retryAfterMs(null)).toBeUndefined();
  });
});

describe("withRetry", () => {
  it("retries transient failures and reports the attempts", async () => {
    let n = 0;
    const r = await withRetry(async () => {
      if (++n < 3) throw new ProviderError("rate_limited", "busy");
      return "ok";
    }, fast, noSleep);
    expect(r).toEqual({ value: "ok", attempts: 3 });
  });

  it("gives up after the last attempt, and never retries a non-transient failure", async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw new ProviderError("server", "down"); }, fast, noSleep)).rejects.toMatchObject({ kind: "server", attempts: 3 });
    expect(n).toBe(3);
    n = 0;
    await expect(withRetry(async () => { n++; throw new ProviderError("malformed", "garbage"); }, fast, noSleep)).rejects.toMatchObject({ kind: "malformed" });
    expect(n).toBe(1);
  });
});

describe("withTimeout", () => {
  it("aborts the request and fails as a timeout", async () => {
    let aborted = false;
    const never = (signal: AbortSignal) => new Promise<string>((_, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }));
    await expect(withTimeout(never, 10)).rejects.toMatchObject({ kind: "timeout" });
    expect(aborted).toBe(true);
  });
});

describe("CircuitBreaker", () => {
  it("opens after the threshold, lets one trial through after the cooldown, and closes on its success", () => {
    let t = 0;
    const b = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 100, now: () => t });
    b.failure();
    expect(b.tryPass()).toBe(true);
    b.failure();
    expect(b.state).toBe("open");
    expect(b.tryPass()).toBe(false);
    t = 100;
    expect(b.tryPass()).toBe(true);
    expect(b.tryPass()).toBe(false); // only one trial at a time
    b.success();
    expect(b.state).toBe("closed");
  });

  it("a failed trial opens it again for another cooldown", () => {
    let t = 0;
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 50, now: () => t });
    b.failure();
    t = 50;
    expect(b.tryPass()).toBe(true);
    b.failure();
    expect(b.state).toBe("open");
    t = 99;
    expect(b.tryPass()).toBe(false);
  });
});

/**
 * Timeouts, retries with jittered exponential backoff, and a circuit breaker: the three things every provider
 * call goes through (providerCall). Pure apart from the clock and sleep, which are injectable for tests.
 */
import { isTransient, ProviderError } from "./errors.js";

export interface RetryPolicy {
  /** Total attempts, the first included. */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Full jitter: a random wait up to base·2^n, capped; a provider's Retry-After wins when it's longer. */
export function backoffMs(attempt: number, policy: RetryPolicy, retryAfter?: number, random = Math.random): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  const jittered = Math.round(random() * ceiling);
  return retryAfter !== undefined ? Math.min(policy.maxDelayMs, Math.max(jittered, retryAfter)) : jittered;
}

/** Run fn, retrying transient ProviderErrors. Anything else, or the last transient one, is thrown. `attempt` is 0-based. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, policy: RetryPolicy, sleep: Sleep = realSleep): Promise<{ value: T; attempts: number }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return { value: await fn(attempt), attempts: attempt + 1 };
    } catch (err) {
      if (!isTransient(err) || attempt + 1 >= policy.attempts) throw Object.assign(err as Error, { attempts: attempt + 1 });
      await sleep(backoffMs(attempt, policy, err.retryAfterMs));
    }
  }
}

/** Abort fn's request after `ms`, as a ProviderError("timeout") whatever the adapter throws on abort. */
export async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Reject first: aborting makes the request fail at once, and the race must see the timeout, not that.
      reject(new ProviderError("timeout", `no answer within ${ms} ms`));
      controller.abort();
    }, ms);
  });
  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface BreakerOptions {
  /** Consecutive failures that open the circuit. */
  failureThreshold: number;
  /** How long it stays open before one trial call is let through. */
  cooldownMs: number;
  now?: () => number;
}

/**
 * Closed: calls pass, failures count. Open: calls are refused until the cooldown is over. Half-open: one
 * trial call; its success closes the circuit, its failure opens it again for another cooldown.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private trialInFlight = false;
  private readonly now: () => number;

  constructor(private readonly opts: BreakerOptions) {
    this.now = opts.now ?? Date.now;
  }

  get state(): "closed" | "open" | "half_open" {
    if (this.openedAt === null) return "closed";
    return this.now() - this.openedAt >= this.opts.cooldownMs ? "half_open" : "open";
  }

  /** Whether a call may go out now (claims the single half-open trial when it's that). */
  tryPass(): boolean {
    const state = this.state;
    if (state === "closed") return true;
    if (state === "open" || this.trialInFlight) return false;
    this.trialInFlight = true;
    return true;
  }

  success(): void {
    this.failures = 0;
    this.openedAt = null;
    this.trialInFlight = false;
  }

  failure(): void {
    this.trialInFlight = false;
    this.failures++;
    if (this.openedAt !== null || this.failures >= this.opts.failureThreshold) this.openedAt = this.now();
  }
}

/** One breaker per key (provider and step), created on first use. */
export class Breakers {
  private readonly byKey = new Map<string, CircuitBreaker>();
  constructor(private readonly opts: BreakerOptions) {}
  for(key: string): CircuitBreaker {
    let b = this.byKey.get(key);
    if (!b) this.byKey.set(key, (b = new CircuitBreaker(this.opts)));
    return b;
  }
}

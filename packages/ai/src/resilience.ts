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

/**
 * At most `limit` requests in any sliding `windowMs`, for a provider whose quota is a request rate (Gemini's
 * free tier: 100 embed requests a minute). acquire() waits its turn, in order, instead of letting the request
 * fail; one limiter per process and quota. Other processes on the same key still count against the quota, so
 * a 429 can still happen: the retries handle it.
 */
export class RateLimiter {
  private readonly sent: number[] = [];
  private queue: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly opts: { limit: number; windowMs: number; now?: () => number; sleep?: Sleep }) {
    if (opts.limit < 1) throw new Error("RateLimiter limit must be at least 1");
    this.now = opts.now ?? Date.now;
  }

  /** Resolves once `n` more requests fit in the window (n above the limit waits for whole windows). */
  acquire(n = 1): Promise<void> {
    const turn = this.queue.then(async () => {
      for (let i = 0; i < n; i++) await this.one();
    });
    this.queue = turn.catch(() => {});
    return turn;
  }

  private async one(): Promise<void> {
    const sleep = this.opts.sleep ?? realSleep;
    for (;;) {
      const t = this.now();
      while (this.sent.length && this.sent[0] <= t - this.opts.windowMs) this.sent.shift();
      if (this.sent.length < this.opts.limit) {
        this.sent.push(t);
        return;
      }
      await sleep(this.sent[0] + this.opts.windowMs - t);
    }
  }
}

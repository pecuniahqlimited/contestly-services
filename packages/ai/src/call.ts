/**
 * The one path every provider call takes (ADR 0016): the paid cap (a paid call with a $0 cap is refused here,
 * before anything else) → the free tier's daily quota and rate (free calls) → budget → circuit breaker →
 * timeout → retries → one usage record (model, tier, requests, tokens, latency, estimated cost, outcome, tied
 * to the party and the step) and one log line. Whatever goes wrong comes out as ProviderUnavailable. Never
 * logs a key or a prompt: only counts and the error.
 */
import { estimateCostMicros, MICRO_USD_PER_USD, type CallTier, type CallUsage, type PricedModel, type ProviderName, type ProviderStep } from "@contestly/shared";
import { currentCallContext } from "./context.js";
import { ProviderError, ProviderUnavailable, type FailureKind } from "./errors.js";
import { Breakers, RateLimiter, realSleep, withRetry, withTimeout, type RetryPolicy, type Sleep } from "./resilience.js";

export interface CallRecord {
  provider: ProviderName;
  model: string;
  step: ProviderStep;
  tier: CallTier;
  /** Requests sent, retries included (an embedding batch is one per text): what a free tier's quota counts. */
  requests: number;
  partyId: string | null;
  job: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  searchQueries: number;
  latencyMs: number;
  costMicros: number;
  attempts: number;
  outcome: "ok" | FailureKind;
  error: string | null;
}

/** Where call records go (Postgres in the services, memory in tests and the eval). */
export interface UsageSink {
  record(r: CallRecord): Promise<void>;
}

/** Whether a call may be made: null, or why not (the party's or the day's spend has reached its cap). */
export interface BudgetGate {
  check(input: { partyId: string | null; step: ProviderStep; tier: CallTier }): Promise<string | null>;
}

/** Whether a free-tier call fits the model's daily quota: null, or why not. */
export interface FreeQuotaGate {
  check(input: { model: PricedModel; requests: number }): Promise<string | null>;
}

/** One rate limiter per model, for the free tier's requests-a-minute (created on first use). */
export class Limiters {
  private readonly byModel = new Map<string, RateLimiter>();
  constructor(private readonly rpmOf: (model: PricedModel) => number | undefined) {}
  for(model: PricedModel): RateLimiter | undefined {
    const rpm = this.rpmOf(model);
    if (!rpm) return undefined;
    let l = this.byModel.get(model);
    if (!l) this.byModel.set(model, (l = new RateLimiter({ limit: rpm, windowMs: 60_000 })));
    return l;
  }
}

/**
 * The hard ceiling on paid calls, per day, from AI_PAID_CAP_USD (US dollars). Unset or 0 means paid providers
 * are off: every paid call is refused before it's made. Only a deliberate setting turns them on.
 */
export function paidCapMicrosFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AI_PAID_CAP_USD?.trim();
  if (!raw) return 0;
  const usd = Number(raw);
  if (!Number.isFinite(usd) || usd < 0) throw new Error(`AI_PAID_CAP_USD=${raw} must be a number of US dollars, 0 or more`);
  return Math.round(usd * MICRO_USD_PER_USD);
}

export interface CallDeps {
  sink: UsageSink;
  budget: BudgetGate;
  breakers: Breakers;
  retry: RetryPolicy;
  timeoutMs: number;
  /** The paid ceiling in micro-USD; read from AI_PAID_CAP_USD when not given, so code that builds its own deps is capped too. */
  paidCapMicros?: number;
  /** Free calls: the daily quota (Postgres in the services) and the per-minute rate. */
  freeQuota?: FreeQuotaGate;
  limiters?: Limiters;
  sleep?: Sleep;
  now?: () => number;
  log?: (line: string) => void;
}

export interface CallOutput<T> {
  value: T;
  usage: CallUsage;
}

export interface CallSpec {
  provider: ProviderName;
  model: PricedModel;
  step: ProviderStep;
  /** Paid unless the caller knows it's the free tier: a call nobody marked costs money until shown otherwise. */
  tier?: CallTier;
  /** Requests this call sends (an embedding batch: one per text). Default 1. */
  requests?: number;
}

/** Sensible defaults for a provider call; the timeout is per attempt. */
export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, baseDelayMs: 500, maxDelayMs: 8_000 };
export const DEFAULT_BREAKER = { failureThreshold: 5, cooldownMs: 60_000 };

const zeroUsage: CallUsage = { inputTokens: 0, outputTokens: 0 };

export async function providerCall<T>(spec: CallSpec, deps: CallDeps, fn: (signal: AbortSignal) => Promise<CallOutput<T>>): Promise<T> {
  const ctx = currentCallContext();
  const now = deps.now ?? Date.now;
  const started = now();
  const tier: CallTier = spec.tier ?? "paid";
  const perAttempt = spec.requests ?? 1;
  const breaker = deps.breakers.for(`${spec.provider}:${spec.step}`);
  const finish = async (outcome: CallRecord["outcome"], usage: CallUsage, attempts: number, error: string | null) => {
    const record: CallRecord = {
      provider: spec.provider, model: spec.model, step: spec.step, tier, requests: perAttempt * attempts, partyId: ctx.partyId ?? null, job: ctx.job ?? null,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cachedInputTokens ?? 0, searchQueries: usage.searchQueries ?? 0,
      // The free tier costs nothing; the estimate is for paid calls only.
      latencyMs: now() - started, costMicros: outcome === "ok" && tier === "paid" ? estimateCostMicros(spec.model, usage) : 0, attempts, outcome, error,
    };
    (deps.log ?? console.log)(logLine(record));
    if (ctx.tally) {
      const t = ctx.tally;
      t.calls++;
      if (outcome !== "ok") t.failed++;
      t.byStep[spec.step] = (t.byStep[spec.step] ?? 0) + 1;
      t.inputTokens += record.inputTokens;
      t.outputTokens += record.outputTokens;
      t.costMicros += record.costMicros;
    }
    try {
      await deps.sink.record(record);
    } catch (err) {
      // A lost usage row must not fail the question it paid for; it's reported, and the call's answer stands.
      console.error(`[ai] usage record failed: ${(err as Error).message}`);
    }
  };
  const unavailable = async (kind: FailureKind, message: string, attempts: number, retryAfterMs?: number) => {
    await finish(kind, zeroUsage, attempts, message);
    return new ProviderUnavailable(kind, spec.provider, spec.step, message, retryAfterMs);
  };

  if (tier === "paid" && (deps.paidCapMicros ?? paidCapMicrosFromEnv()) <= 0) {
    throw await unavailable("budget", "paid providers are off (AI_PAID_CAP_USD is 0)", 0);
  }
  if (tier === "free") {
    const over = await deps.freeQuota?.check({ model: spec.model, requests: perAttempt });
    if (over) throw await unavailable("rate_limited", over, 0);
  }
  const refused = await deps.budget.check({ partyId: ctx.partyId ?? null, step: spec.step, tier });
  if (refused) throw await unavailable("budget", refused, 0);
  if (tier === "free") await deps.limiters?.for(spec.model)?.acquire(perAttempt);
  if (!breaker.tryPass()) throw await unavailable("circuit_open", "too many recent failures; waiting before trying again", 0);

  try {
    const { value: out, attempts } = await withRetry(() => withTimeout(fn, deps.timeoutMs), deps.retry, deps.sleep ?? realSleep);
    breaker.success();
    await finish("ok", out.usage, attempts, null);
    return out.value;
  } catch (err) {
    breaker.failure();
    const attempts = (err as { attempts?: number }).attempts ?? 1;
    if (err instanceof ProviderError) throw await unavailable(err.kind, err.message, attempts, err.retryAfterMs);
    // An adapter bug or an unexpected throw: still counted, still unavailable to the pipeline.
    throw await unavailable("malformed", (err as Error).message ?? String(err), attempts);
  }
}

function logLine(r: CallRecord): string {
  const cost = (r.costMicros / 1_000_000).toFixed(5);
  return `[ai] ${r.step} ${r.provider}/${r.model}${r.tier === "free" ? " (free)" : ""} party=${r.partyId ?? "-"} job=${r.job ?? "-"} in=${r.inputTokens} out=${r.outputTokens}` +
    `${r.searchQueries ? ` searches=${r.searchQueries}` : ""} ${r.latencyMs}ms $${cost} ${r.outcome}${r.attempts > 1 ? ` after ${r.attempts} attempts` : ""}${r.error ? `: ${r.error}` : ""}`;
}

/** For tests and scripts: keeps every record in memory. */
export class MemorySink implements UsageSink {
  readonly records: CallRecord[] = [];
  async record(r: CallRecord) {
    this.records.push(r);
  }
}

export const noBudget: BudgetGate = { async check() { return null; } };

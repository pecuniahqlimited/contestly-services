/**
 * The one path every provider call takes (ADR 0016): budget → circuit breaker → timeout → retries → one usage
 * record (model, tokens, latency, estimated cost, outcome, tied to the party and the step) and one log line.
 * Whatever goes wrong comes out as ProviderUnavailable. Never logs a key or a prompt: only counts and the error.
 */
import { estimateCostMicros, type CallUsage, type PricedModel, type ProviderName, type ProviderStep } from "@contestly/shared";
import { currentCallContext } from "./context.js";
import { ProviderError, ProviderUnavailable, type FailureKind } from "./errors.js";
import { Breakers, realSleep, withRetry, withTimeout, type RetryPolicy, type Sleep } from "./resilience.js";

export interface CallRecord {
  provider: ProviderName;
  model: string;
  step: ProviderStep;
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
  check(input: { partyId: string | null }): Promise<string | null>;
}

export interface CallDeps {
  sink: UsageSink;
  budget: BudgetGate;
  breakers: Breakers;
  retry: RetryPolicy;
  timeoutMs: number;
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
}

/** Sensible defaults for a provider call; the timeout is per attempt. */
export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, baseDelayMs: 500, maxDelayMs: 8_000 };
export const DEFAULT_BREAKER = { failureThreshold: 5, cooldownMs: 60_000 };

const zeroUsage: CallUsage = { inputTokens: 0, outputTokens: 0 };

export async function providerCall<T>(spec: CallSpec, deps: CallDeps, fn: (signal: AbortSignal) => Promise<CallOutput<T>>): Promise<T> {
  const ctx = currentCallContext();
  const now = deps.now ?? Date.now;
  const started = now();
  const breaker = deps.breakers.for(`${spec.provider}:${spec.step}`);
  const finish = async (outcome: CallRecord["outcome"], usage: CallUsage, attempts: number, error: string | null) => {
    const record: CallRecord = {
      ...spec, partyId: ctx.partyId ?? null, job: ctx.job ?? null,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cachedInputTokens ?? 0, searchQueries: usage.searchQueries ?? 0,
      latencyMs: now() - started, costMicros: outcome === "ok" ? estimateCostMicros(spec.model, usage) : 0, attempts, outcome, error,
    };
    (deps.log ?? console.log)(logLine(record));
    try {
      await deps.sink.record(record);
    } catch (err) {
      // A lost usage row must not fail the question it paid for; it's reported, and the call's answer stands.
      console.error(`[ai] usage record failed: ${(err as Error).message}`);
    }
  };
  const unavailable = async (kind: FailureKind, message: string, attempts: number) => {
    await finish(kind, zeroUsage, attempts, message);
    return new ProviderUnavailable(kind, spec.provider, spec.step, message);
  };

  const refused = await deps.budget.check({ partyId: ctx.partyId ?? null });
  if (refused) throw await unavailable("budget", refused, 0);
  if (!breaker.tryPass()) throw await unavailable("circuit_open", "too many recent failures; waiting before trying again", 0);

  try {
    const { value: out, attempts } = await withRetry(() => withTimeout(fn, deps.timeoutMs), deps.retry, deps.sleep ?? realSleep);
    breaker.success();
    await finish("ok", out.usage, attempts, null);
    return out.value;
  } catch (err) {
    breaker.failure();
    const attempts = (err as { attempts?: number }).attempts ?? 1;
    if (err instanceof ProviderError) throw await unavailable(err.kind, err.message, attempts);
    // An adapter bug or an unexpected throw: still counted, still unavailable to the pipeline.
    throw await unavailable("malformed", (err as Error).message ?? String(err), attempts);
  }
}

function logLine(r: CallRecord): string {
  const cost = (r.costMicros / 1_000_000).toFixed(5);
  return `[ai] ${r.step} ${r.provider}/${r.model} party=${r.partyId ?? "-"} job=${r.job ?? "-"} in=${r.inputTokens} out=${r.outputTokens}` +
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

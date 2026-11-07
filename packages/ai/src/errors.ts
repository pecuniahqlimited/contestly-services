/**
 * Provider failures, vendor-neutral. Adapters turn whatever their vendor throws into a ProviderError with a
 * kind; providerCall() retries the transient kinds and turns anything left into ProviderUnavailable, the one
 * error the pipelines catch (generation stops and falls back to the bank; checks fail closed).
 */
export const FAILURE_KINDS = ["rate_limited", "timeout", "server", "network", "bad_request", "auth", "malformed", "refused", "budget", "circuit_open"] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

/** Worth another attempt after a backoff: the provider was busy, slow or unreachable, not wrong. */
const TRANSIENT = new Set<FailureKind>(["rate_limited", "timeout", "server", "network"]);

export class ProviderError extends Error {
  constructor(readonly kind: FailureKind, message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = "ProviderError";
  }
}

export const isTransient = (e: unknown): e is ProviderError => e instanceof ProviderError && TRANSIENT.has(e.kind);

/** A call that won't produce an answer now: budget reached, circuit open, retries exhausted, malformed or refused output. */
export class ProviderUnavailable extends Error {
  constructor(readonly kind: FailureKind, readonly provider: string, readonly step: string, message: string) {
    super(`${provider} ${step} unavailable (${kind}): ${message}`);
    this.name = "ProviderUnavailable";
  }
}

/** HTTP status → failure kind, for adapters that see a status code. */
export function kindForStatus(status: number): FailureKind {
  if (status === 429) return "rate_limited";
  if (status === 408) return "timeout";
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "server";
  return "bad_request";
}

/** Retry-After as milliseconds (seconds or an HTTP date), when the provider sent one. */
export function retryAfterMs(header: string | null | undefined, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/**
 * Money transactions retried on a deadlock or a serialization failure (ADR 0013). The lock order holds
 * within a journal; across journals in one transaction two paths can still cycle (two settles crediting the
 * same two people in opposite orders, say). Postgres breaks the cycle by aborting one side, which rolls back
 * whole; this runs it again, up to `attempts` times with a little jitter, and logs each retry. Anything
 * else, or the last failure, is thrown as it was. The function must be safe to run again (it reads its state
 * inside the transaction, as every money path here does).
 */
import { db, type Tx } from "./client.js";
import { adminAlert } from "./alerts.js";

/** Postgres: deadlock_detected, serialization_failure. */
const RETRYABLE = new Set(["40P01", "40001"]);
const JITTER_MS = 50;

export interface RetryOptions {
  attempts?: number; label?: string; onRetry?: (attempt: number, code: string) => void;
  /** How long one after-commit effect may hold the caller; AFTER_COMMIT_EFFECT_TIMEOUT_MS by default. */
  effectTimeoutMs?: number;
}

/** AFTER_COMMIT_EFFECT_TIMEOUT_MS: a few seconds. Read once; a value that isn't a positive integer stops the process at start. */
const DEFAULT_EFFECT_TIMEOUT_MS = 5_000;
export const AFTER_COMMIT_EFFECT_TIMEOUT_MS = (() => {
  const raw = process.env.AFTER_COMMIT_EFFECT_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_EFFECT_TIMEOUT_MS;
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms <= 0) throw new Error(`AFTER_COMMIT_EFFECT_TIMEOUT_MS must be a positive integer (ms), got "${raw}"`);
  return ms;
})();

type Effect = () => unknown;
/** Effects to run once a money transaction has committed (a log line, later a push): never on an attempt that rolled back. */
const pending = new WeakMap<Tx, Effect[]>();

/**
 * Run `fn` after the transaction commits, once, when `tx` is a money transaction's; anywhere else, now. Rows
 * written in the transaction (an alert) commit or roll back with it; anything that leaves the process
 * (a log line, a delivery) belongs here, so a retried attempt doesn't repeat it.
 */
export function afterCommit(tx: unknown, fn: Effect) {
  const queue = pending.get(tx as Tx);
  if (queue) queue.push(fn);
  else fn();
}

const TIMED_OUT = Symbol("timed_out");
/** `work`'s result, or TIMED_OUT once `ms` have passed: the caller never waits longer. `work` itself runs on. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** An effect's failure or timeout, as an alert; bounded by the same timeout, and never thrown. */
async function raiseEffectAlert(alert: Parameters<typeof adminAlert>[0], label: string, timeoutMs: number) {
  try {
    if ((await within(adminAlert(alert), timeoutMs)) === TIMED_OUT) console.error(`[db] ${label}: raising the ${alert.kind} alert took over ${timeoutMs} ms; not waiting for it`);
  } catch (alertErr) {
    console.error(`[db] ${label}: the ${alert.kind} alert failed too`, alertErr);
  }
}

/**
 * Once committed, the work stands: an effect that throws is logged and raised as an alert, never returned
 * to the caller as a failure (which would make it skip what follows a commit, or retry committed work).
 * Each effect may hold the caller for `timeoutMs` at most: past it, it's logged and alerted and the caller
 * moves on. A promise can't be cancelled, so a slow effect keeps running; a failure after that is logged.
 */
async function runEffects(effects: Effect[], label: string, timeoutMs: number) {
  for (const run of effects) {
    const work = Promise.resolve().then(run);
    try {
      if ((await within(work, timeoutMs)) !== TIMED_OUT) continue;
      work.catch((err) => console.error(`[db] ${label}: an after-commit effect failed after it timed out`, err));
      console.error(`[db] ${label}: an after-commit effect took over ${timeoutMs} ms; not waiting for it (the transaction stands)`);
      await raiseEffectAlert({
        kind: "after_commit_effect_timeout", severity: "warning", subject: `After-commit effect timed out in ${label}; the transaction committed`,
        details: { label, timeoutMs }, dedupeKey: `after_commit_effect_timeout:${label}`,
      }, label, timeoutMs);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[db] ${label}: an after-commit effect failed (the transaction stands)`, err);
      await raiseEffectAlert({
        kind: "after_commit_effect_failed", severity: "warning", subject: `After-commit effect failed in ${label}; the transaction committed`,
        details: { label, error }, dedupeKey: `after_commit_effect_failed:${label}`,
      }, label, timeoutMs);
    }
  }
}

export async function moneyTransaction<T>(fn: (tx: Tx) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  for (let attempt = 1; ; attempt++) {
    const effects: Effect[] = [];
    let out: T;
    try {
      out = await db.transaction((tx) => {
        pending.set(tx, effects);
        return fn(tx);
      });
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      if (!RETRYABLE.has(code) || attempt >= attempts) throw e;
      console.warn(`[db] ${opts.label ?? "money transaction"}: ${code === "40P01" ? "deadlock" : "serialization failure"}, retrying (attempt ${attempt + 1} of ${attempts})`);
      opts.onRetry?.(attempt, code);
      await new Promise((r) => setTimeout(r, Math.random() * JITTER_MS * attempt));
      continue;
    }
    await runEffects(effects, opts.label ?? "money transaction", opts.effectTimeoutMs ?? AFTER_COMMIT_EFFECT_TIMEOUT_MS);
    return out;
  }
}

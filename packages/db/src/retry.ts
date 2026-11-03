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

export interface RetryOptions { attempts?: number; label?: string; onRetry?: (attempt: number, code: string) => void }

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

/**
 * Once committed, the work stands: an effect that throws is logged and raised as an alert, never returned
 * to the caller as a failure (which would make it skip what follows a commit, or retry committed work).
 */
async function runEffects(effects: Effect[], label: string) {
  for (const run of effects) {
    try {
      await run();
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[db] ${label}: an after-commit effect failed (the transaction stands)`, err);
      try {
        await adminAlert({
          kind: "after_commit_effect_failed", severity: "warning", subject: `After-commit effect failed in ${label}; the transaction committed`,
          details: { label, error }, dedupeKey: `after_commit_effect_failed:${label}`,
        });
      } catch (alertErr) {
        console.error(`[db] ${label}: the alert for a failed after-commit effect failed too`, alertErr);
      }
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
    await runEffects(effects, opts.label ?? "money transaction");
    return out;
  }
}

/**
 * Money transactions retried on a deadlock or a serialization failure (ADR 0013). The lock order holds
 * within a journal; across journals in one transaction two paths can still cycle (two settles crediting the
 * same two people in opposite orders, say). Postgres breaks the cycle by aborting one side, which rolls back
 * whole; this runs it again, up to `attempts` times with a little jitter, and logs each retry. Anything
 * else, or the last failure, is thrown as it was. The function must be safe to run again (it reads its state
 * inside the transaction, as every money path here does).
 */
import { db, type Tx } from "./client.js";

/** Postgres: deadlock_detected, serialization_failure. */
const RETRYABLE = new Set(["40P01", "40001"]);
const JITTER_MS = 50;

export interface RetryOptions { attempts?: number; label?: string; onRetry?: (attempt: number, code: string) => void }

export async function moneyTransaction<T>(fn: (tx: Tx) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction(fn);
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      if (!RETRYABLE.has(code) || attempt >= attempts) throw e;
      console.warn(`[db] ${opts.label ?? "money transaction"}: ${code === "40P01" ? "deadlock" : "serialization failure"}, retrying (attempt ${attempt + 1} of ${attempts})`);
      opts.onRetry?.(attempt, code);
      await new Promise((r) => setTimeout(r, Math.random() * JITTER_MS * attempt));
    }
  }
}

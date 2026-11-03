/** Small pieces every payments module uses: typed HTTP errors, the Lagos day, alerts, and the job hook. */
import { lagosDay, type PaymentsJob } from "@contestly/shared";
import { eq } from "drizzle-orm";
import { db, users, type Tx } from "@contestly/db";

export type Conn = Tx | typeof db;

/**
 * Lock a person's row for a money path, first (the lock order, ADR 0013: the person, then transaction rows,
 * then ledger accounts). NO KEY UPDATE: it serialises their money paths without blocking the foreign-key
 * checks other transactions make against the row.
 */
export async function lockPerson(tx: Tx, userId: string) {
  const [u] = await tx.select().from(users).where(eq(users.id, userId)).for("no key update");
  return u;
}

/** An error the API maps to its status and code (with details for the app). */
export const paymentsError = (statusCode: number, code: string, details?: Record<string, unknown>) =>
  Object.assign(new Error(code), { statusCode, ...(details ? { details } : {}) });

/** Where the payments code hands work to the worker. The API and worker pass their queue; tests pass a recorder. */
export interface PaymentsDeps {
  enqueue(job: PaymentsJob, opts?: { jobId?: string; delayMs?: number }): Promise<void>;
}

/** The start of the Lagos day `at` falls in (Lagos is UTC+1 all year). */
export const lagosDayStart = (at: Date) => new Date(`${lagosDay(at)}T00:00:00+01:00`);
export const lagosDayRange = (day: string) => ({ from: new Date(`${day}T00:00:00+01:00`), to: new Date(new Date(`${day}T00:00:00+01:00`).getTime() + 24 * 3600_000) });

/**
 * Payments alerts go through main's adminAlert() (packages/db/src/alerts.ts), kinds prefixed "payments.", always
 * with the transaction they belong to, so a freeze or a pause and its alert commit together. A key that's
 * about one thing (a payout, a top-up, a webhook) uses this window, not the 24-hour default: raised again, it
 * bumps the same alert's count, and once an admin acknowledges it, it stays settled (counted, nobody told).
 */
export const ONCE_PER_THING_SECONDS = 10 * 365 * 24 * 3600;

/** The next check for something still unresolved: first after `firstSeconds`, then doubling, never longer than `maxSeconds`. */
export const backoffMs = (checksSoFar: number, firstSeconds: number, maxSeconds: number) =>
  Math.min(firstSeconds * 2 ** Math.min(checksSoFar, 20), maxSeconds) * 1000;

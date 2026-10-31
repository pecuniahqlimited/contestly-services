/** Small pieces every payments module uses: typed HTTP errors, the Lagos day, alerts, and the job hook. */
import { lagosDay, type PaymentsJob } from "@contestly/shared";
import { db, paymentAlerts, type Tx } from "@contestly/db";

export type Conn = Tx | typeof db;

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

export interface AlertInput { severity: "warning" | "critical"; kind: string; dedupeKey: string; refType?: string; refId?: string; detail: Record<string, unknown> }
/**
 * Raise something an admin must look at; the same dedupe key raises it once. Critical means money may be wrong.
 * Delivery to admins' phones is row 9 (nudges); until then the console's alert list and the log.
 */
export async function raiseAlert(conn: Conn, a: AlertInput) {
  const [row] = await conn.insert(paymentAlerts).values({ ...a, refType: a.refType ?? null, refId: a.refId ?? null }).onConflictDoNothing().returning({ id: paymentAlerts.id });
  if (row) console.error(`[payments] ${a.severity.toUpperCase()} ${a.kind} ${a.refType ?? ""}:${a.refId ?? ""} ${JSON.stringify(a.detail)}`);
  return !!row;
}

/** The next check for something still unresolved: first after `firstSeconds`, then doubling, never longer than `maxSeconds`. */
export const backoffMs = (checksSoFar: number, firstSeconds: number, maxSeconds: number) =>
  Math.min(firstSeconds * 2 ** Math.min(checksSoFar, 20), maxSeconds) * 1000;

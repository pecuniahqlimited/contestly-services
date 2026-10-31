/**
 * Every minute: whatever is due gets a job (pending top-ups to verify, requested withdrawals to send,
 * submitted or unknown ones to check). Jobs are only the trigger; the row's state and next_check_at are the
 * truth, so a lost job, a crashed worker or a restart only delays.
 */
import { and, eq, inArray, isNotNull, lte, or } from "drizzle-orm";
import { db, payouts, topups } from "@contestly/db";
import { currentSettings } from "./settings.js";
import { failUnstartedTopups } from "./topups.js";
import type { PaymentsDeps } from "./common.js";

const BATCH = 200;

export async function sweepDue(deps: PaymentsDeps, now = new Date()) {
  const unstarted = await failUnstartedTopups(now);
  const dueTopups = await db.select({ id: topups.id, checks: topups.checks }).from(topups)
    .where(and(eq(topups.status, "pending"), isNotNull(topups.nextCheckAt), lte(topups.nextCheckAt, now))).limit(BATCH);
  for (const t of dueTopups) await deps.enqueue({ kind: "topup_check", topupId: t.id }, { jobId: `topup-check-${t.id}-${t.checks}` });

  const paused = (await currentSettings()).payoutsPaused;
  const duePayouts = await db.select({ id: payouts.id, status: payouts.status, checks: payouts.checks, sends: payouts.sendAttempts }).from(payouts)
    .where(or(
      // A paused rail leaves requested withdrawals where they are (debited and queued).
      paused ? undefined : eq(payouts.status, "requested"),
      and(inArray(payouts.status, ["submitted", "unknown"]), lte(payouts.nextCheckAt, now)),
    )).limit(BATCH);
  for (const p of duePayouts) {
    if (p.status === "requested") await deps.enqueue({ kind: "payout_submit", payoutId: p.id }, { jobId: `payout-submit-${p.id}-${p.sends}` });
    else await deps.enqueue({ kind: "payout_check", payoutId: p.id }, { jobId: `payout-check-${p.id}-${p.checks}` });
  }
  return { topups: dueTopups.length, unstarted, payouts: duePayouts.length };
}

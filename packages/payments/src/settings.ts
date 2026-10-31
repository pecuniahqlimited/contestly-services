/**
 * Which provider takes top-ups and which sends payouts, and the kill switches: one immutable row per change,
 * the newest current. Changing it never touches a transaction already started: each finishes with the
 * provider that created it (ADR 0013).
 */
import { desc } from "drizzle-orm";
import { db, paymentSettings, type Tx } from "@contestly/db";
import type { PaymentSettingsView } from "@contestly/shared";
import { configuredProviderNames, defaultProviderName } from "./providers/index.js";
import { paymentsError, type Conn } from "./common.js";

export async function currentSettings(conn: Conn = db): Promise<PaymentSettingsView> {
  const [row] = await conn.select().from(paymentSettings).orderBy(desc(paymentSettings.version)).limit(1);
  if (!row) return { version: null, collections: defaultProviderName(), payouts: defaultProviderName(), topupsPaused: false, payoutsPaused: false, pausedBy: null, reason: null, updatedAt: null };
  return {
    version: row.version, collections: row.collections, payouts: row.payouts, topupsPaused: row.topupsPaused, payoutsPaused: row.payoutsPaused,
    pausedBy: row.topupsPaused || row.payoutsPaused ? row.changedBy : null, reason: row.reason, updatedAt: row.createdAt.toISOString(),
  };
}

export interface SettingsChange { collections: string; payouts: string; topupsPaused: boolean; payoutsPaused: boolean; reason: string }

/** An admin's change. Both providers must be configured here (secrets in env). */
export async function saveSettings(tx: Tx, change: SettingsChange, adminUserId: string) {
  const configured = configuredProviderNames();
  for (const name of [change.collections, change.payouts]) if (!configured.includes(name)) throw paymentsError(409, "provider_not_configured", { provider: name, configured });
  await tx.insert(paymentSettings).values({ ...change, changedBy: "admin", createdByUserId: adminUserId });
}

/** The invariant job found a breach: payouts stop (queued ones stay debited and queued) until an admin clears it. */
export async function pausePayoutsBySystem(tx: Tx, reason: string) {
  const now = await currentSettings(tx);
  if (now.payoutsPaused) return false;
  await tx.insert(paymentSettings).values({ collections: now.collections, payouts: now.payouts, topupsPaused: now.topupsPaused, payoutsPaused: true, changedBy: "system", reason });
  return true;
}

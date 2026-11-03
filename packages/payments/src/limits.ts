/**
 * What a person may top up and withdraw today, read with the same queries the limits are enforced with
 * (createTopup, requestPayout), so what the app shows and what the server allows can't drift.
 */
import { and, count, eq, gte, inArray, notInArray, sql } from "drizzle-orm";
import { db, getPaymentsConfig, payouts, topups, type Tx } from "@contestly/db";
import { feeFromTiers, type WalletLimits } from "@contestly/shared";
import { lagosDayStart } from "./common.js";
import { currentSettings } from "./settings.js";
import { providerNamed } from "./providers/index.js";

type Conn = Tx | typeof db;

/** Top-ups counted against today's cap (Lagos day): pending and credited. */
export async function topupsTodayKobo(conn: Conn, userId: string, now: Date): Promise<number> {
  const [{ total }] = await conn.select({ total: sql<number>`coalesce(sum(${topups.amountKobo}), 0)::bigint` }).from(topups)
    .where(and(eq(topups.userId, userId), gte(topups.createdAt, lagosDayStart(now)), inArray(topups.status, ["pending", "succeeded"])));
  return Number(total);
}

/** Withdrawals counted against today's limits (Lagos day): everything but failed and rejected. */
export async function payoutsToday(conn: Conn, userId: string, now: Date): Promise<{ count: number; totalKobo: number }> {
  const [today] = await conn.select({ n: count(), total: sql<number>`coalesce(sum(${payouts.amountKobo}), 0)::bigint` }).from(payouts)
    .where(and(eq(payouts.userId, userId), notInArray(payouts.status, ["failed", "rejected"]), gte(payouts.createdAt, lagosDayStart(now))));
  return { count: Number(today.n), totalKobo: Number(today.total) };
}

/** The current payout provider's fee tiers, or none when payouts aren't configured. */
function payoutFeeTiers(providerName: string) {
  try {
    return providerNamed(providerName).payout?.transferFeeTiers ?? [];
  } catch (e) {
    console.warn(`[payments] fee tiers: payout provider ${providerName} unavailable: ${(e as Error).message}`);
    return [];
  }
}

export async function walletLimits(userId: string, amountKobo?: number, now = new Date()): Promise<WalletLimits> {
  const [settings, cfg, toppedUp, withdrawn] = await Promise.all([currentSettings(), getPaymentsConfig(), topupsTodayKobo(db, userId, now), payoutsToday(db, userId, now)]);
  const tiers = payoutFeeTiers(settings.payouts);
  const estimate = amountKobo !== undefined && tiers.length ? (() => {
    const feeKobo = feeFromTiers(tiers, amountKobo);
    return { amountKobo, feeKobo, sentKobo: cfg.payout.feeBearer === "user" ? amountKobo - feeKobo : amountKobo };
  })() : null;
  return {
    topup: {
      paused: settings.topupsPaused, minKobo: cfg.topup.minKobo, maxKobo: cfg.topup.maxKobo,
      dailyCapKobo: cfg.topup.dailyCapKobo, remainingTodayKobo: Math.max(0, cfg.topup.dailyCapKobo - toppedUp),
    },
    withdrawal: {
      paused: settings.payoutsPaused, minKobo: cfg.payout.minKobo, maxKobo: cfg.payout.maxKobo,
      dailyAmountKobo: cfg.payout.dailyAmountKobo, remainingAmountTodayKobo: Math.max(0, cfg.payout.dailyAmountKobo - withdrawn.totalKobo),
      dailyCount: cfg.payout.dailyCount, remainingCountToday: Math.max(0, cfg.payout.dailyCount - withdrawn.count),
    },
    fee: { bearer: cfg.payout.feeBearer, tiers: [...tiers], estimate },
  };
}

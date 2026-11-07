/**
 * AI provider usage in Postgres (ADR 0016): the call records, the spend caps they're checked against, and the
 * verification cache. The shapes match @contestly/ai's UsageSink and BudgetGate structurally, so this package
 * doesn't depend on the provider code. Days are Africa/Lagos.
 */
import { desc, eq, gte, sql } from "drizzle-orm";
import { addDays, dayStartsAt, lagosDay, MICRO_USD_PER_CENT } from "@contestly/shared";
import { db } from "./client.js";
import { parties, providerCalls, verificationCache } from "./schema.js";
import { getQuestionsConfig } from "./config.js";
import { adminAlert } from "./alerts.js";

export type ProviderCallRow = typeof providerCalls.$inferInsert;

/** Writes one provider_calls row per call. */
export const dbUsageSink = {
  async record(r: Omit<ProviderCallRow, "id" | "createdAt">) {
    await db.insert(providerCalls).values(r);
  },
};

const spent = sql<number>`coalesce(sum(${providerCalls.costMicros}), 0)::bigint`;

export async function daySpendMicros(day = lagosDay()): Promise<number> {
  const [row] = await db.select({ spent }).from(providerCalls).where(gte(providerCalls.createdAt, dayStartsAt(day)));
  return Number(row?.spent ?? 0);
}

export async function partySpendMicros(partyId: string): Promise<number> {
  const [row] = await db.select({ spent }).from(providerCalls).where(eq(providerCalls.partyId, partyId));
  return Number(row?.spent ?? 0);
}

/**
 * The spend caps: refuse a call once the day's (or the party's) recorded spend has reached its cap, so
 * overspend is at most the one call in flight. Crossing alertAtPct of the day raises a warning, reaching the
 * cap a critical alert; a party reaching its own cap an info alert. Each is deduped per day or per party.
 */
export const dbBudgetGate = {
  async check({ partyId }: { partyId: string | null }): Promise<string | null> {
    const { providers } = await getQuestionsConfig();
    const day = lagosDay();
    const dayCap = providers.dailyCents * MICRO_USD_PER_CENT;
    const today = await daySpendMicros(day);
    const usd = (m: number) => `$${(m / 1_000_000).toFixed(2)}`;
    if (today >= dayCap) {
      await adminAlert({
        kind: "ai.budget_reached", severity: "critical", subject: `AI provider spend reached today's cap (${usd(dayCap)})`,
        details: { day, spentMicros: today, capMicros: dayCap }, dedupeKey: `ai.budget_reached:${day}`,
      });
      return `today's provider budget (${usd(dayCap)}) is spent`;
    }
    if (today >= (dayCap * providers.alertAtPct) / 100) {
      await adminAlert({
        kind: "ai.budget_near", severity: "warning", subject: `AI provider spend is at ${Math.floor((today / dayCap) * 100)}% of today's cap`,
        details: { day, spentMicros: today, capMicros: dayCap, alertAtPct: providers.alertAtPct }, dedupeKey: `ai.budget_near:${day}`,
      });
    }
    if (!partyId) return null;
    const partyCap = providers.perPartyCents * MICRO_USD_PER_CENT;
    const party = await partySpendMicros(partyId);
    if (party < partyCap) return null;
    await adminAlert({
      kind: "ai.party_budget", severity: "info", subject: `A party reached its AI provider budget (${usd(partyCap)})`,
      details: { partyId, spentMicros: party, capMicros: partyCap }, dedupeKey: `ai.party_budget:${partyId}`, refType: "party", refId: partyId,
    });
    return `this party's provider budget (${usd(partyCap)}) is spent`;
  },
};

/** A cached verdict for this key, or null. */
export async function cachedVerification(key: string): Promise<unknown | null> {
  const [row] = await db.select({ verdict: verificationCache.verdict }).from(verificationCache).where(eq(verificationCache.key, key));
  return row?.verdict ?? null;
}

export async function cacheVerification(key: string, model: string, verdict: unknown): Promise<void> {
  await db.insert(verificationCache).values({ key, model, verdict }).onConflictDoNothing();
}

/** The admin usage view: per day, provider, step and model; and the costliest parties in the window. */
export async function providerUsage(days: number) {
  const today = lagosDay();
  const from = dayStartsAt(addDays(today, -(days - 1)));
  const dayExpr = sql<string>`to_char(${providerCalls.createdAt} at time zone 'Africa/Lagos', 'YYYY-MM-DD')`;
  const totals = {
    calls: sql<number>`count(*)::int`,
    failed: sql<number>`count(*) filter (where ${providerCalls.outcome} <> 'ok')::int`,
    inputTokens: sql<number>`coalesce(sum(${providerCalls.inputTokens}), 0)::int`,
    outputTokens: sql<number>`coalesce(sum(${providerCalls.outputTokens}), 0)::int`,
    searchQueries: sql<number>`coalesce(sum(${providerCalls.searchQueries}), 0)::int`,
    costMicros: spent,
  };
  const [byDay, byParty, todayMicros] = await Promise.all([
    db.select({ day: dayExpr, provider: providerCalls.provider, step: providerCalls.step, model: providerCalls.model, ...totals })
      .from(providerCalls).where(gte(providerCalls.createdAt, from))
      .groupBy(dayExpr, providerCalls.provider, providerCalls.step, providerCalls.model).orderBy(desc(dayExpr), providerCalls.step),
    db.select({ partyId: providerCalls.partyId, title: parties.title, ...totals })
      .from(providerCalls).innerJoin(parties, eq(parties.id, providerCalls.partyId))
      .where(gte(providerCalls.createdAt, from))
      .groupBy(providerCalls.partyId, parties.title).orderBy(desc(spent)).limit(50),
    daySpendMicros(today),
  ]);
  const num = <T extends Record<string, unknown>>(r: T) => ({ ...r, costMicros: Number(r.costMicros) });
  return { today, todayMicros, days: byDay.map(num), parties: byParty.map((p) => num({ ...p, partyId: p.partyId! })) };
}


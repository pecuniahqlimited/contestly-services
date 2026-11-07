/**
 * AI provider usage in Postgres (ADR 0016): the call records, the spend caps they're checked against, and the
 * verification cache. The shapes match @contestly/ai's UsageSink and BudgetGate structurally, so this package
 * doesn't depend on the provider code. Days are Africa/Lagos.
 */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { addDays, dayStartsAt, FREE_TIER_LIMITS, FREE_TIER_TIME_ZONE, lagosDay, MICRO_USD_PER_CENT, MICRO_USD_PER_USD, type CallTier, type PricedModel, type ProviderStep } from "@contestly/shared";
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
 *
 * The party's cap doesn't apply to embeddings: they cost a few millionths of a dollar, and the bank-only
 * fallback a party falls back to once its cap is spent needs them (retrieval and dedupe embed the spec and
 * the set). The day's cap still does.
 */
const PARTY_CAP_EXEMPT: ReadonlySet<ProviderStep> = new Set(["embed"]);

/** AI_PAID_CAP_USD in micro-USD (0 when unset or unreadable; providerCall refuses a bad value outright). */
function envPaidCapMicros(): number {
  const usd = Number(process.env.AI_PAID_CAP_USD?.trim() || 0);
  return Number.isFinite(usd) && usd > 0 ? Math.round(usd * MICRO_USD_PER_USD) : 0;
}

export const dbBudgetGate = {
  async check({ partyId, step, tier = "paid" }: { partyId: string | null; step: ProviderStep; tier?: CallTier }): Promise<string | null> {
    // Free calls cost nothing; their limit is the free tier's quota (dbFreeQuota), not money.
    if (tier === "free") return null;
    const { providers } = await getQuestionsConfig();
    const day = lagosDay();
    // AI_PAID_CAP_USD above 0 is a ceiling under the admin's cap. At 0, paid calls never get this far (providerCall refuses them first).
    const envCap = envPaidCapMicros();
    const adminCap = providers.dailyCents * MICRO_USD_PER_CENT;
    const dayCap = envCap > 0 ? Math.min(adminCap, envCap) : adminCap;
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
    if (!partyId || PARTY_CAP_EXEMPT.has(step)) return null;
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

/** Midnight Pacific time (when Google's free daily quotas reset) at the start of `now`'s Pacific day. */
export function freeTierDayStart(now = new Date()): Date {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: FREE_TIER_TIME_ZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(now).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offsetMs = asUtc - Math.floor(now.getTime() / 1000) * 1000; // Pacific minus UTC
  return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day) - offsetMs);
}

/** Requests sent to this model since the free tier's day began, across every process (they all record here). */
export async function freeRequestsToday(model: string, now = new Date()): Promise<number> {
  const [row] = await db.select({ n: sql<number>`coalesce(sum(${providerCalls.requests}), 0)::int` }).from(providerCalls)
    .where(and(eq(providerCalls.model, model), eq(providerCalls.tier, "free"), gte(providerCalls.createdAt, freeTierDayStart(now))));
  return Number(row?.n ?? 0);
}

/**
 * The free tier's daily quota, held to before Google's: a call that would take the model past its requests a
 * day is refused (fail closed) until midnight Pacific. A model with no known limit isn't a free model: refused.
 */
export const dbFreeQuota = {
  async check({ model, requests }: { model: PricedModel; requests: number }): Promise<string | null> {
    const limit = FREE_TIER_LIMITS[model];
    if (!limit) return `${model} has no free tier we know of`;
    const used = await freeRequestsToday(model);
    if (used + requests > limit.rpd) return `${model}'s free daily quota is spent (${used} of ${limit.rpd} requests; resets at midnight Pacific)`;
    return null;
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


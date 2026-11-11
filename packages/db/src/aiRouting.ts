/**
 * AI routing in Postgres (ADR 0016, 11 Nov 2026): the versioned config, read at call time, and the route a call
 * takes (the party's tier, the configured profile, the ceiling). Version 1 is written the first time anything
 * reads it, from AI_PROFILE (its only remaining use) and the paid models the questions config had. A route
 * that falls back under the ceiling is logged and raises a warning (one a day per pair).
 */
import { desc, eq } from "drizzle-orm";
import {
  AI_PROFILES, aiRoutingConfigSchema, DEFAULT_PAID_MODELS, initialAiRouting, maxPrizeKobo, tierFor, withinCeiling,
  type AiProfile, type AiRoute, type AiRoutingConfig, type StepModels,
} from "@contestly/shared";
import { db, type Tx } from "./client.js";
import { aiRoutingConfigs, appConfig, type Party } from "./schema.js";
import { adminAlert } from "./alerts.js";

type Conn = Tx | typeof db;

export interface AiRoutingRow { version: number; config: AiRoutingConfig; createdByUserId: string | null; reason: string | null; createdAt: Date }

/** AI_PROFILE, for version 1 only; mock when unset or not a profile name. */
function initialProfile(): AiProfile {
  const name = process.env.AI_PROFILE?.trim() as AiProfile | undefined;
  return name && AI_PROFILES.includes(name) ? name : "mock";
}

/** The per-step models the questions config held before they moved here (questions.providers.models), if any. */
async function storedPaidModels(conn: Conn): Promise<StepModels> {
  const [row] = await conn.select({ value: appConfig.value }).from(appConfig).where(eq(appConfig.key, "questions"));
  const models = (row?.value as { providers?: { models?: Partial<StepModels> } } | undefined)?.providers?.models;
  return { ...DEFAULT_PAID_MODELS, ...(models ?? {}) };
}

/** The current version, writing version 1 first when there's none. */
export async function currentAiRouting(conn: Conn = db): Promise<AiRoutingRow> {
  const [row] = await conn.select().from(aiRoutingConfigs).orderBy(desc(aiRoutingConfigs.version)).limit(1);
  if (row) return { ...row, config: aiRoutingConfigSchema.parse(row.config) };
  const config = aiRoutingConfigSchema.parse(initialAiRouting(initialProfile(), await storedPaidModels(conn)));
  // Two processes starting together: one insert wins, both read it back.
  await conn.insert(aiRoutingConfigs).values({ version: 1, config, reason: `version 1, from AI_PROFILE=${config.defaultProfile}` }).onConflictDoNothing();
  return currentAiRouting(conn);
}

/** A new version (the caller checks the ceiling and logs the admin action in the same transaction). */
export async function saveAiRouting(tx: Tx, config: AiRoutingConfig, byUserId: string, reason: string): Promise<AiRoutingRow> {
  const parsed = aiRoutingConfigSchema.parse(config);
  const current = await currentAiRouting(tx);
  const [row] = await tx.insert(aiRoutingConfigs).values({ version: current.version + 1, config: parsed, createdByUserId: byUserId, reason }).returning();
  return { ...row, config: parsed };
}

/** A party's maximum possible prize: every seat's entry plus the host's cash prize. */
export const partyPrizeKobo = (p: Pick<Party, "entryKobo" | "maxPlayers" | "hostPoolKobo">) =>
  maxPrizeKobo({ entryKobo: p.entryKobo, maxPlayers: p.maxPlayers, hostPrizeKobo: p.hostPoolKobo });

/**
 * The route for a prize (null: not tied to a party, so the default profile) under the allowed ceiling, from the
 * current config. A fallback is logged and alerted; `none` (nothing allowed at or below) calls nothing.
 */
export async function aiRouteFor(prizeKobo: number | null, allowed: readonly AiProfile[], conn: Conn = db): Promise<{ route: AiRoute; config: AiRoutingConfig }> {
  const { version, config } = await currentAiRouting(conn);
  const tier = prizeKobo === null ? null : tierFor(config, prizeKobo);
  const configured = tier ? tier.tier.profile : config.defaultProfile;
  const profile = withinCeiling(configured, allowed);
  const route: AiRoute = { profile, configured, tier: tier ? { index: tier.index, upToKobo: tier.tier.upToKobo } : null, prizeKobo, version };
  if (profile !== configured) await alertFallback(route, allowed);
  return { route, config };
}

async function alertFallback(route: AiRoute, allowed: readonly AiProfile[]) {
  const used = route.profile ?? "none";
  const where = route.tier ? `the ${route.tier.upToKobo === null ? "top" : `up-to-₦${route.tier.upToKobo / 100}`} tier` : "the default";
  console.warn(`[ai] routing v${route.version}: ${where} says ${route.configured}, outside AI_ALLOWED_PROFILES (${allowed.join(",")}); running ${used}`);
  await adminAlert({
    kind: "ai.profile_fallback", severity: "warning",
    subject: `AI routing names ${route.configured}, which this server doesn't allow; ${route.profile ? `running ${route.profile} instead` : "nothing is called (bank only)"}`,
    details: { configured: route.configured, used, allowed, version: route.version, tier: route.tier },
    dedupeKey: `ai.profile_fallback:${route.configured}:${used}`,
  });
}

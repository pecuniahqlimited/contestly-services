import { eq } from "drizzle-orm";
import { DEFAULT_PARTY_CONFIG, DEFAULT_PAYOUT_CONFIG, partyConfigSchema, payoutConfigSchema, type PartyConfig, type PayoutConfig } from "@contestly/shared";
import { db } from "./client.js";
import { appConfig } from "./schema.js";

/** Current Payout Challenge config: the stored admin value, or the default when none is stored. */
export async function getPayoutConfig(): Promise<PayoutConfig> {
  const [row] = await db.select().from(appConfig).where(eq(appConfig.key, "payout"));
  return row ? payoutConfigSchema.parse(row.value) : DEFAULT_PAYOUT_CONFIG;
}

export async function setPayoutConfig(value: unknown): Promise<PayoutConfig> {
  const parsed = payoutConfigSchema.parse(value);
  await db.insert(appConfig).values({ key: "payout", value: parsed }).onConflictDoUpdate({ target: appConfig.key, set: { value: parsed, updatedAt: new Date() } });
  return parsed;
}

/** Current party round + settlement config (rake, host cut, default split, beat timings). */
export async function getPartyConfig(): Promise<PartyConfig> {
  const [row] = await db.select().from(appConfig).where(eq(appConfig.key, "party"));
  return row ? partyConfigSchema.parse(row.value) : DEFAULT_PARTY_CONFIG;
}

export async function setPartyConfig(value: unknown): Promise<PartyConfig> {
  const parsed = partyConfigSchema.parse(value);
  await db.insert(appConfig).values({ key: "party", value: parsed }).onConflictDoUpdate({ target: appConfig.key, set: { value: parsed, updatedAt: new Date() } });
  return parsed;
}

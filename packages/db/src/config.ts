import { eq } from "drizzle-orm";
import { DEFAULT_PAYOUT_CONFIG, payoutConfigSchema, type PayoutConfig } from "@contestly/shared";
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

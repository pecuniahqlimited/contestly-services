/** Email provider choice (admin, versioned) and the send log. Keys and sender addresses never live here: they're env/secrets. */
import { desc } from "drizzle-orm";
import { EMAIL_PROVIDERS, type EmailProviderName } from "@contestly/shared";
import { db } from "./client.js";
import { emailConfigs, emailSends } from "./schema.js";

export interface EmailConfigVersion { version: number | null; primary: EmailProviderName; createdAt: Date | null }

const envPrimary = (): EmailProviderName => {
  const p = process.env.EMAIL_PRIMARY as EmailProviderName | undefined;
  return p && EMAIL_PROVIDERS.includes(p) ? p : "zeptomail";
};

/** The newest admin choice, else EMAIL_PRIMARY (default ZeptoMail). */
export async function currentEmailConfig(): Promise<EmailConfigVersion> {
  const [row] = await db.select().from(emailConfigs).orderBy(desc(emailConfigs.version)).limit(1);
  return row ? { version: row.version, primary: row.primary as EmailProviderName, createdAt: row.createdAt } : { version: null, primary: envPrimary(), createdAt: null };
}

export async function saveEmailConfig(primary: EmailProviderName, byUserId: string): Promise<EmailConfigVersion> {
  const [row] = await db.insert(emailConfigs).values({ primary, createdByUserId: byUserId }).returning();
  return { version: row.version, primary, createdAt: row.createdAt };
}

export async function logEmailSend(entry: typeof emailSends.$inferInsert) {
  await db.insert(emailSends).values(entry);
}

export const recentEmailSends = (limit = 20) => db.select().from(emailSends).orderBy(desc(emailSends.createdAt)).limit(limit);

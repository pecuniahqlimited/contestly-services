/**
 * What the app reads before sign-in (GET /config), from the environment: the support contacts
 * (SUPPORT_EMAIL, SUPPORT_WHATSAPP). Read and checked once at start, so a bad value stops the API
 * instead of reaching the app.
 */
import { publicConfigSchema, type PublicConfig } from "@contestly/shared";

const orNull = (v: string | undefined) => (v?.trim() ? v.trim() : null);

export function publicConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PublicConfig {
  const parsed = publicConfigSchema.safeParse({ support: { email: orNull(env.SUPPORT_EMAIL), whatsapp: orNull(env.SUPPORT_WHATSAPP)?.replace(/[\s-]/g, "") ?? null } });
  if (!parsed.success) throw new Error(`SUPPORT_EMAIL / SUPPORT_WHATSAPP: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

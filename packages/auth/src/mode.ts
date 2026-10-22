/**
 * AUTH_MODE: "firebase" verifies ID tokens only. "dev" also accepts `x-dev-user: <handle>`, for local
 * work and the sims, and is refused outright in production.
 */
export const AUTH_MODES = ["dev", "firebase"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export const authMode = (env: NodeJS.ProcessEnv = process.env): AuthMode => (env.AUTH_MODE ?? "dev") as AuthMode;

/** Secrets every sign-in path needs in production. */
const PRODUCTION_SECRETS = ["FIREBASE_PROJECT_ID", "EMAIL_CODE_SECRET", "PHONE_HASH_SECRET"] as const;

/** Call before listening. Throws on a configuration that must never run. */
export function assertAuthConfig(env: NodeJS.ProcessEnv = process.env): void {
  const mode = env.AUTH_MODE ?? "dev";
  if (!(AUTH_MODES as readonly string[]).includes(mode)) throw new Error(`AUTH_MODE must be one of ${AUTH_MODES.join(", ")} (got "${mode}")`);
  if (env.NODE_ENV !== "production") return;
  if (mode === "dev") throw new Error("AUTH_MODE=dev is refused when NODE_ENV=production");
  const missing = PRODUCTION_SECRETS.filter((k) => !env[k]);
  if (missing.length) throw new Error(`missing in production: ${missing.join(", ")}`);
}

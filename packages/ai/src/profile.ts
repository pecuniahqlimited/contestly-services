/**
 * The environment's say over AI profiles (ADR 0016). Which profile a call runs is the AI routing config (admin,
 * versioned, read at call time); the environment sets only the ceiling (AI_ALLOWED_PROFILES) and, through
 * AI_PROFILE, the default written into routing version 1. Unknown names stop the service rather than pick one.
 */
import { AI_PROFILES, type AiProfile } from "@contestly/shared";

const parse = (name: string, envVar: string): AiProfile => {
  if (!AI_PROFILES.includes(name as AiProfile)) throw new Error(`${envVar}=${name} is not a profile (have: ${AI_PROFILES.join(", ")})`);
  return name as AiProfile;
};

/** AI_PROFILE: only the initial default for routing version 1 (mock when unset). */
export function aiProfileFromEnv(env: NodeJS.ProcessEnv = process.env): AiProfile {
  return parse(env.AI_PROFILE?.trim() || "mock", "AI_PROFILE");
}

/** Without AI_ALLOWED_PROFILES: never paid. */
export const DEFAULT_ALLOWED_PROFILES: readonly AiProfile[] = ["mock", "free"];

/** AI_ALLOWED_PROFILES (comma-separated; dev: mock,free; production: free,paid): what routing may name. */
export function allowedProfilesFromEnv(env: NodeJS.ProcessEnv = process.env): AiProfile[] {
  const raw = env.AI_ALLOWED_PROFILES?.trim();
  if (!raw) return [...DEFAULT_ALLOWED_PROFILES];
  const names = raw.split(",").map((s) => s.trim()).filter(Boolean).map((n) => parse(n, "AI_ALLOWED_PROFILES"));
  if (!names.length) throw new Error("AI_ALLOWED_PROFILES names no profile");
  return AI_PROFILES.filter((p) => names.includes(p));
}

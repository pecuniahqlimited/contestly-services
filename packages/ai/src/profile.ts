/** AI_PROFILE (ADR 0016): mock when unset; an unknown name stops the service rather than picking one. */
import { AI_PROFILES, type AiProfile } from "@contestly/shared";

export function aiProfileFromEnv(env: NodeJS.ProcessEnv = process.env): AiProfile {
  const name = env.AI_PROFILE?.trim() || "mock";
  if (!AI_PROFILES.includes(name as AiProfile)) throw new Error(`AI_PROFILE=${name} is not a profile (have: ${AI_PROFILES.join(", ")})`);
  return name as AiProfile;
}

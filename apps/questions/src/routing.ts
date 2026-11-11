/**
 * Routing a questions job to its providers (ADR 0016, 11 Nov 2026): a party's job runs the profile of the party's
 * prize tier (its maximum possible prize: every seat's entry plus the host's cash prize, as the party stands when
 * the job starts), anything else the default profile, both under the AI_ALLOWED_PROFILES ceiling. Resolved once
 * per job, so a set is made and judged under one profile; the config is read each time, so a change applies to
 * the next job with no restart. The route goes into the call context (provider_calls, the budget gate, the
 * generation records).
 */
import { eq } from "drizzle-orm";
import { allowedProfilesFromEnv } from "@contestly/ai";
import { aiRouteFor, db, parties, partyPrizeKobo } from "@contestly/db";
import { maxPrizeKobo, type AiProfile, type AiRoute, type AiStakes } from "@contestly/shared";
import type { ProviderRegistry } from "./providers/index.js";
import type { Providers } from "./providers/types.js";

export interface Routed {
  route: AiRoute;
  providers: Providers;
}

/** A party's job: its tier's profile (the default when the party is gone). */
export async function routeParty(partyId: string, registry: ProviderRegistry, allowed: readonly AiProfile[] = allowedProfilesFromEnv()): Promise<Routed> {
  const [p] = await db.select({ entryKobo: parties.entryKobo, maxPlayers: parties.maxPlayers, hostPoolKobo: parties.hostPoolKobo }).from(parties).where(eq(parties.id, partyId));
  return routePrize(p ? partyPrizeKobo(p) : null, registry, allowed);
}

/** The builder's draft stakes (distractor suggestions); none given: the default profile. */
export const routeStakes = (stakes: AiStakes | undefined, registry: ProviderRegistry, allowed: readonly AiProfile[] = allowedProfilesFromEnv()) =>
  routePrize(stakes ? maxPrizeKobo(stakes) : null, registry, allowed);

/** Anything not tied to a party (null) or a prize. */
export async function routePrize(prizeKobo: number | null, registry: ProviderRegistry, allowed: readonly AiProfile[] = allowedProfilesFromEnv()): Promise<Routed> {
  const { route } = await aiRouteFor(prizeKobo, allowed);
  return { route, providers: registry.for(route.profile) };
}

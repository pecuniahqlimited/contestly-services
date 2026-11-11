/**
 * AI routing (ADR 0016, 11 Nov 2026): which profile (mock, free, paid) a provider call runs, by the party's stakes,
 * as versioned admin config read at call time. A default profile for anything not tied to a party; prize tiers,
 * ascending, for parties, by the party's maximum possible prize (every seat's entry plus the host's cash prize);
 * the models per step for each profile; and each profile's own caps beside the global ones in questions.providers.
 *
 * The ceiling stays in the environment: AI_ALLOWED_PROFILES (and AI_PAID_CAP_USD, which keeps every paid call
 * refused at $0). A save naming a profile outside the ceiling is refused; at call time a profile outside it falls
 * back to the highest allowed one below it (logged and alerted), and with none below, nothing is called.
 */
import { z } from "zod";
import { AI_PROFILES, chatModel, chatModelOf, DEFAULT_PAID_MODELS, FREE_PROFILE_MODELS, freeChatModel, type AiProfile, type PricedModel } from "./providers.js";
import { reasonSchema } from "./admin.js";

const profile = z.enum(AI_PROFILES);
const differentVerifier = <T extends { generate: string; verify: string }>(m: T) => m.verify !== m.generate;
const verifierRule = { message: "the verifier must be a different model from the generator", path: ["verify"] };

/** The steps a profile picks a model for (embeddings and transcription are fixed per profile: changing the embedder means re-embedding). */
export const ROUTED_STEPS = ["generate", "verify", "safety"] as const;
export type RoutedStep = (typeof ROUTED_STEPS)[number];
export type StepModels = Record<RoutedStep, PricedModel>;

/** One prize tier: parties whose maximum prize is at most `upToKobo` (null: no upper bound, the last tier) run `profile`. */
export const aiTierSchema = z.object({ upToKobo: z.number().int().min(0).nullable(), profile });
export type AiTier = z.infer<typeof aiTierSchema>;

export const aiRoutingConfigSchema = z.object({
  /** Anything not tied to a party: voice-note transcription, admin edits of bank questions, re-embedding, the builder before stakes. */
  defaultProfile: profile,
  /** Ascending by upToKobo; the first is bragging rights (0), the last has no upper bound (null). */
  tiers: z.array(aiTierSchema).min(1).max(10).superRefine((tiers, ctx) => {
    if (!tiers.length) return; // min(1) already said so
    if (tiers[0].upToKobo !== 0) ctx.addIssue({ code: "custom", path: [0, "upToKobo"], message: "the first tier is bragging rights: up to ₦0" });
    if (tiers[tiers.length - 1].upToKobo !== null) ctx.addIssue({ code: "custom", path: [tiers.length - 1, "upToKobo"], message: "the last tier has no upper bound (null)" });
    for (let i = 1; i < tiers.length; i++) {
      const prev = tiers[i - 1].upToKobo;
      const cur = tiers[i].upToKobo;
      if (prev === null || (cur !== null && cur <= prev)) ctx.addIssue({ code: "custom", path: [i, "upToKobo"], message: "tiers go up: each bound above the one before, only the last unbounded" });
    }
  }),
  profiles: z.object({
    /** Gemini's free tier only (FREE_TIER_LIMITS models); caps in calls, since it costs nothing. */
    free: z.object({
      models: z.object({ generate: freeChatModel, verify: freeChatModel, safety: freeChatModel }).refine(differentVerifier, verifierRule),
      caps: z.object({ perPartyCalls: z.number().int().min(1).max(10_000), dailyCalls: z.number().int().min(1).max(1_000_000) }),
    }),
    /** The production setup: Claude writes; verify and safety may be either vendor's (the model picks it). Caps in US cents. */
    paid: z.object({
      models: z.object({ generate: chatModelOf("anthropic"), verify: chatModel, safety: chatModel }).refine(differentVerifier, verifierRule),
      caps: z.object({ perPartyCents: z.number().int().min(1).max(100_000), dailyCents: z.number().int().min(1).max(10_000_000) }),
    }),
  }),
});
export type AiRoutingConfig = z.infer<typeof aiRoutingConfigSchema>;

/** Version 1, written the first time routing is read: every party and the default on `initial` (AI_PROFILE's old value). */
export function initialAiRouting(initial: AiProfile, paidModels: StepModels = DEFAULT_PAID_MODELS): AiRoutingConfig {
  return {
    defaultProfile: initial,
    tiers: [{ upToKobo: 0, profile: initial }, { upToKobo: null, profile: initial }],
    profiles: {
      free: { models: { generate: FREE_PROFILE_MODELS.generate, verify: FREE_PROFILE_MODELS.verify, safety: FREE_PROFILE_MODELS.safety }, caps: { perPartyCalls: 60, dailyCalls: 2_000 } },
      paid: { models: { ...paidModels }, caps: { perPartyCents: 500, dailyCents: 2_500 } },
    },
  };
}

/** What decides a party's tier: the stakes, as set (or as the builder's draft has them). */
export const aiStakesSchema = z.object({
  entryKobo: z.number().int().min(0),
  maxPlayers: z.number().int().min(1),
  /** The host's cash prize (held at creation); goods aren't counted. */
  hostPrizeKobo: z.number().int().min(0).default(0),
});
export type AiStakes = z.infer<typeof aiStakesSchema>;

/** The most a party can pay out: every seat's entry plus the host's cash prize. */
export const maxPrizeKobo = (s: AiStakes) => s.entryKobo * s.maxPlayers + s.hostPrizeKobo;

/** The tier a prize falls in (the first whose bound it doesn't pass), with its index. */
export function tierFor(config: AiRoutingConfig, prizeKobo: number): { index: number; tier: AiTier } {
  const index = config.tiers.findIndex((t) => t.upToKobo === null || prizeKobo <= t.upToKobo);
  return { index, tier: config.tiers[index] };
}

/**
 * The profile a call actually runs under the ceiling: the configured one when allowed, else the highest allowed
 * one below it, else none (nothing is called: generation falls back to the bank, checks fail closed).
 */
export function withinCeiling(configured: AiProfile, allowed: readonly AiProfile[]): AiProfile | null {
  const rank = AI_PROFILES.indexOf(configured);
  for (let i = rank; i >= 0; i--) if (allowed.includes(AI_PROFILES[i])) return AI_PROFILES[i];
  return null;
}

/** Profiles a config names that the ceiling doesn't allow (a save with any is refused). */
export function profilesOutside(config: AiRoutingConfig, allowed: readonly AiProfile[]): AiProfile[] {
  const named = new Set<AiProfile>([config.defaultProfile, ...config.tiers.map((t) => t.profile)]);
  return [...named].filter((p) => !allowed.includes(p));
}

/** Where a call's profile came from, recorded on each generation record and provider call. */
export const aiRouteSchema = z.object({
  /** The profile the calls ran (null: none allowed, nothing called). */
  profile: profile.nullable(),
  /** What the config said, before the ceiling. */
  configured: profile,
  /** The party's tier (its index and bound), or null for the default profile. */
  tier: z.object({ index: z.number().int(), upToKobo: z.number().int().nullable() }).nullable(),
  prizeKobo: z.number().int().nullable(),
  version: z.number().int(),
});
export type AiRoute = z.infer<typeof aiRouteSchema>;

// ---- admin ---------------------------------------------------------------------------------

export const AI_PROFILE_NOT_ALLOWED = "ai_profile_not_allowed";

/** PUT /admin/ai/routing: a new version, logged with the reason. 400 ai_profile_not_allowed { profiles } outside the ceiling. */
export const adminAiRoutingBodySchema = z.object({ config: aiRoutingConfigSchema, reason: reasonSchema });

const fixedModels = z.object({ embed: z.string(), transcribe: z.string() });

/** GET /admin/ai/routing (and the PUT's answer): the current version and the ceiling it runs under. */
export const adminAiRoutingSchema = z.object({
  version: z.number().int(),
  config: aiRoutingConfigSchema,
  createdAt: z.string().datetime(),
  /** Who saved it (null: version 1, written from AI_PROFILE). */
  createdBy: z.object({ id: z.string().uuid(), handle: z.string() }).nullable(),
  reason: z.string().nullable(),
  ceiling: z.object({
    /** AI_ALLOWED_PROFILES: what a tier or the default may name. */
    allowed: z.array(profile),
    /** AI_PAID_CAP_USD in micro-USD; 0 means every paid call is refused, whatever the routing says. */
    paidCapMicros: z.number().int(),
  }),
  /** Models each profile may pick, for the console's pickers. */
  choices: z.object({ free: z.array(z.string()), paidGenerate: z.array(z.string()), paidCheck: z.array(z.string()) }),
  /** Fixed per profile: the embedder (changing it means re-embedding) and the transcriber. */
  fixed: z.object({ mock: fixedModels, free: fixedModels, paid: fixedModels }),
});
export type AdminAiRouting = z.infer<typeof adminAiRoutingSchema>;

/** POST /admin/ai/routing/preview: these stakes against the current config (or a draft of one), changing nothing. */
export const adminAiRoutingPreviewBodySchema = z.object({ stakes: aiStakesSchema, config: aiRoutingConfigSchema.optional() });
export const adminAiRoutingPreviewSchema = z.object({
  prizeKobo: z.number().int(),
  tier: z.object({ index: z.number().int(), upToKobo: z.number().int().nullable() }),
  configured: profile,
  /** What would run under the ceiling (null: nothing allowed; the set would be bank-only). */
  profile: profile.nullable(),
  fellBack: z.boolean(),
  /** The models per step that would be used (null for mock or none). */
  models: z.object({ generate: z.string(), verify: z.string(), safety: z.string(), embed: z.string() }).nullable(),
  /** Paid, but AI_PAID_CAP_USD is 0: every call would be refused. */
  paidOff: z.boolean(),
});
export type AdminAiRoutingPreview = z.infer<typeof adminAiRoutingPreviewSchema>;

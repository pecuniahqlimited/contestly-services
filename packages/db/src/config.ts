import { desc, eq } from "drizzle-orm";
import type { z } from "zod";
import {
  DEFAULT_CLIMB_SETTINGS, DEFAULT_ONBOARDING_CONFIG, DEFAULT_PARTY_CONFIG, DEFAULT_QUESTIONS_CONFIG,
  climbSettingsSchema, onboardingConfigSchema, partyConfigSchema, questionsConfigSchema, type OnboardingConfig,
} from "@contestly/shared";
import { db } from "./client.js";
import { appConfig, onboardingConfigs } from "./schema.js";

/**
 * One admin-editable JSON document per key, validated by its shared schema. Stored values are
 * layered over the defaults, so a key added to a schema later takes its default until an admin
 * sets it, and existing admin edits survive.
 */
function configEntry<T extends object>(key: string, schema: z.ZodType<T>, fallback: T) {
  return {
    async get(): Promise<T> {
      const [row] = await db.select().from(appConfig).where(eq(appConfig.key, key));
      return row ? schema.parse({ ...fallback, ...(row.value as object) }) : fallback;
    },
    async set(value: unknown): Promise<T> {
      const parsed = schema.parse(value);
      await db.insert(appConfig).values({ key, value: parsed }).onConflictDoUpdate({ target: appConfig.key, set: { value: parsed, updatedAt: new Date() } });
      return parsed;
    },
  };
}

/** The Climb's settings that aren't the ladder (weekly prizes, pauses, Today's challenge defaults). The ladder is versioned in climb_ladders. */
const climb = configEntry("climb", climbSettingsSchema, DEFAULT_CLIMB_SETTINGS);
export const getClimbSettings = climb.get;
export const setClimbSettings = climb.set;

/** Party round + settlement config (rake, host cut, default split, beat timings). */
const party = configEntry("party", partyConfigSchema, DEFAULT_PARTY_CONFIG);
export const getPartyConfig = party.get;
export const setPartyConfig = party.set;

/** Question-engine config (reserves, generation timeout, dedupe threshold, flag rules). */
const questions = configEntry("questions", questionsConfigSchema, DEFAULT_QUESTIONS_CONFIG);
export const getQuestionsConfig = questions.get;
export const setQuestionsConfig = questions.set;

/**
 * The onboarding round (matchmaking wait, timings, scoring, the coins it pays) is versioned: one row per
 * admin save, the newest current, the default until anyone saves. Stored values are layered over the
 * defaults like the other config.
 */
export async function currentOnboardingConfig(): Promise<{ version: number | null; config: OnboardingConfig; createdAt: Date | null }> {
  const [row] = await db.select().from(onboardingConfigs).orderBy(desc(onboardingConfigs.version)).limit(1);
  if (!row) return { version: null, config: DEFAULT_ONBOARDING_CONFIG, createdAt: null };
  return { version: row.version, config: onboardingConfigSchema.parse({ ...DEFAULT_ONBOARDING_CONFIG, ...row.config }), createdAt: row.createdAt };
}
export const getOnboardingConfig = async () => (await currentOnboardingConfig()).config;
export async function saveOnboardingConfig(config: OnboardingConfig, byUserId: string | null) {
  const [row] = await db.insert(onboardingConfigs).values({ config: onboardingConfigSchema.parse(config), createdByUserId: byUserId }).returning();
  return { version: row.version, config: row.config, createdAt: row.createdAt };
}

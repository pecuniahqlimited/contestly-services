import { and, desc, eq } from "drizzle-orm";
import type { z } from "zod";
import { challengeConfigSchema, DEFAULT_CHALLENGE_CONFIG,
  DEFAULT_ABOUT, DEFAULT_ACCOUNTS_CONFIG, DEFAULT_CHAT_CONFIG, DEFAULT_PAYMENTS_CONFIG, DEFAULT_CLIMB_SETTINGS, DEFAULT_SOCIAL_CONFIG, DEFAULT_PARTY_CONFIG, DEFAULT_QUESTIONS_CONFIG, DEFAULT_NUDGE_CONFIG, nudgeConfigSchema, DEFAULT_SAFETY_CONFIG, safetyConfigSchema,
  DEFAULT_PARTY_TEMPLATES, partyTemplatesConfigSchema, type PartyTemplatesConfig,
  aboutConfigSchemaFor, accountsConfigSchema, chatConfigSchema, paymentsConfigSchema, climbSettingsSchema, socialConfigSchema, partyConfigSchema, questionsConfigSchema,
  type AboutAudience, type AboutConfig,
} from "@contestly/shared";
import { db, type Tx } from "./client.js";
import { aboutConfigs, appConfig, partyTemplateConfigs } from "./schema.js";

type Conn = Tx | typeof db;

/**
 * One admin-editable JSON document per key, validated by its shared schema. Stored values are
 * layered over the defaults, so a key added to a schema later takes its default until an admin
 * sets it, and existing admin edits survive.
 */
// The schema's input may differ from T (a field with a default is optional going in); T is what reads return.
function configEntry<T extends object>(key: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, fallback: T) {
  return {
    /** Pass a transaction to read (or write) as part of it, e.g. with the admin log entry for the change. */
    async get(conn: Conn = db): Promise<T> {
      const [row] = await conn.select().from(appConfig).where(eq(appConfig.key, key));
      return row ? schema.parse({ ...fallback, ...(row.value as object) }) : fallback;
    },
    async set(value: unknown, conn: Conn = db): Promise<T> {
      const parsed = schema.parse(value);
      await conn.insert(appConfig).values({ key, value: parsed }).onConflictDoUpdate({ target: appConfig.key, set: { value: parsed, updatedAt: new Date() } });
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

/** Chat: voice note caps, rate limits, message requests, the post-game window, voice retention. */
const chat = configEntry("chat", chatConfigSchema, DEFAULT_CHAT_CONFIG);
export const getChatConfig = chat.get;
export const setChatConfig = chat.set;

/** Social: crew size, party points (bragging-rights parties only), challenges a day, streak milestones. */
/** Accounts: how long a deleted account's archive is kept before the worker clears it (ADR 0010). Null = forever. */
const accounts = configEntry("accounts", accountsConfigSchema, DEFAULT_ACCOUNTS_CONFIG);
export const getAccountsConfig = accounts.get;
export const setAccountsConfig = accounts.set;

/** Payments: top-up and withdrawal limits, approval and maker-checker thresholds, the requery clock (ADR 0013). */
const payments = configEntry("payments", paymentsConfigSchema as unknown as z.ZodType<typeof DEFAULT_PAYMENTS_CONFIG>, DEFAULT_PAYMENTS_CONFIG);
export const getPaymentsConfig = payments.get;
export const setPaymentsConfig = payments.set;

const social = configEntry("social", socialConfigSchema, DEFAULT_SOCIAL_CONFIG);
export const getSocialConfig = social.get;
export const setSocialConfig = social.set;

/** Challenges (ADR 0019): the invite expiry and join window ranges, with the preset's defaults. */
const challenges = configEntry("challenges", challengeConfigSchema, DEFAULT_CHALLENGE_CONFIG);
export const getChallengeConfig = challenges.get;
export const setChallengeConfig = challenges.set;

/** Nudges (row 9): the daily push cap, quiet hours, batching gaps and each kind's knobs. */
const nudgeCfg = configEntry("nudges", nudgeConfigSchema, DEFAULT_NUDGE_CONFIG);
export const getNudgeConfig = nudgeCfg.get;
export const setNudgeConfig = nudgeCfg.set;

/** Trust and safety (ADR 0014): report holds, the automatic chat timeout, ops' extra name-filter terms. */
const safety = configEntry("safety", safetyConfigSchema, DEFAULT_SAFETY_CONFIG);
export const getSafetyConfig = safety.get;
export const setSafetyConfig = safety.set;

export interface AboutConfigRow { audience: AboutAudience; version: number; config: AboutConfig; createdAt: Date }
const asRow = (r: typeof aboutConfigs.$inferSelect): AboutConfigRow => ({ audience: r.audience as AboutAudience, version: r.version, config: r.config, createdAt: r.createdAt });

/**
 * About you for an audience: the newest version is current. Version 1 comes from migration 0014 (and
 * db:seed), so a missing set is a broken database: an error, never a write here.
 */
export async function currentAboutConfig(audience: AboutAudience, conn: Conn = db): Promise<AboutConfigRow> {
  const [row] = await conn.select().from(aboutConfigs).where(eq(aboutConfigs.audience, audience)).orderBy(desc(aboutConfigs.version)).limit(1);
  if (!row) throw new Error(`about_config_missing: no About you set for "${audience}" (run db:migrate, or db:seed)`);
  return asRow(row);
}

/** One version, as answered against. Null if there's no such version. */
export async function aboutConfigVersion(audience: AboutAudience, version: number, conn: Conn = db): Promise<AboutConfigRow | null> {
  const [row] = await conn.select().from(aboutConfigs).where(and(eq(aboutConfigs.audience, audience), eq(aboutConfigs.version, version)));
  return row ? asRow(row) : null;
}

/**
 * Save a new version (the next number for the audience). Existing rows are never changed, so users'
 * answers keep meaning what they meant. Two saves at once: the second fails on the key, not silently.
 */
export async function saveAboutConfig(tx: Tx, audience: AboutAudience, config: unknown, byUserId: string | null): Promise<AboutConfigRow> {
  const parsed = aboutConfigSchemaFor(audience).parse(config);
  const current = await currentAboutConfig(audience, tx);
  const [row] = await tx.insert(aboutConfigs).values({ audience, version: current.version + 1, config: parsed, createdByUserId: byUserId }).returning();
  return asRow(row);
}

/** The seed: version 1 of each set (DEFAULT_ABOUT), if it isn't there yet; the same rows migration 0014 writes. */
export async function seedAboutConfigs(conn: Conn = db) {
  for (const audience of ["person", "brand"] as const) {
    await conn.insert(aboutConfigs).values({ audience, version: 1, config: aboutConfigSchemaFor(audience).parse(DEFAULT_ABOUT[audience]) }).onConflictDoNothing();
  }
}

export interface PartyTemplatesRow { version: number; config: PartyTemplatesConfig; createdAt: Date }
const templatesRow = (r: typeof partyTemplateConfigs.$inferSelect): PartyTemplatesRow => ({ version: r.version, config: partyTemplatesConfigSchema.parse(r.config), createdAt: r.createdAt });

/**
 * Party templates and the host-written rules (ADR 0015): the newest version is current. Version 1 comes from
 * migration 0050 (and db:seed), so a missing config is a broken database: an error, never a write here.
 */
export async function currentPartyTemplates(conn: Conn = db): Promise<PartyTemplatesRow> {
  const [row] = await conn.select().from(partyTemplateConfigs).orderBy(desc(partyTemplateConfigs.version)).limit(1);
  if (!row) throw new Error("party_templates_missing: no party template config (run db:migrate, or db:seed)");
  return templatesRow(row);
}

/** One version, as a party was made against. Null if there's no such version. */
export async function partyTemplatesVersion(version: number, conn: Conn = db): Promise<PartyTemplatesRow | null> {
  const [row] = await conn.select().from(partyTemplateConfigs).where(eq(partyTemplateConfigs.version, version));
  return row ? templatesRow(row) : null;
}

/** Save a new version (the next number). Rows are never changed; two saves at once: the second fails on the key. */
export async function savePartyTemplates(tx: Tx, config: unknown, byUserId: string | null): Promise<PartyTemplatesRow> {
  const parsed = partyTemplatesConfigSchema.parse(config);
  const current = await currentPartyTemplates(tx);
  const [row] = await tx.insert(partyTemplateConfigs).values({ version: current.version + 1, config: parsed, createdByUserId: byUserId }).returning();
  return templatesRow(row);
}

/** The seed: version 1 (DEFAULT_PARTY_TEMPLATES), if it isn't there yet; the same row migration 0050 writes. */
export async function seedPartyTemplates(conn: Conn = db) {
  await conn.insert(partyTemplateConfigs).values({ version: 1, config: partyTemplatesConfigSchema.parse(DEFAULT_PARTY_TEMPLATES) }).onConflictDoNothing();
}

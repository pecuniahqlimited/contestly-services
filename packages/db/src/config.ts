import { and, desc, eq } from "drizzle-orm";
import type { z } from "zod";
import {
  DEFAULT_ABOUT, DEFAULT_CHAT_CONFIG, DEFAULT_CLIMB_SETTINGS, DEFAULT_SOCIAL_CONFIG, DEFAULT_PARTY_CONFIG, DEFAULT_QUESTIONS_CONFIG,
  aboutConfigSchemaFor, chatConfigSchema, climbSettingsSchema, socialConfigSchema, partyConfigSchema, questionsConfigSchema,
  type AboutAudience, type AboutConfig,
} from "@contestly/shared";
import { db, type Tx } from "./client.js";
import { aboutConfigs, appConfig } from "./schema.js";

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

/** Chat: voice note caps, rate limits, message requests, the post-game window, voice retention. */
const chat = configEntry("chat", chatConfigSchema, DEFAULT_CHAT_CONFIG);
export const getChatConfig = chat.get;
export const setChatConfig = chat.set;

/** Social: crew size, party points (bragging-rights parties only), challenges a day, streak milestones. */
const social = configEntry("social", socialConfigSchema, DEFAULT_SOCIAL_CONFIG);
export const getSocialConfig = social.get;
export const setSocialConfig = social.set;

type Conn = Tx | typeof db;
export interface AboutConfigRow { audience: AboutAudience; version: number; config: AboutConfig; createdAt: Date }
const asRow = (r: typeof aboutConfigs.$inferSelect): AboutConfigRow => ({ audience: r.audience as AboutAudience, version: r.version, config: r.config, createdAt: r.createdAt });

/** Version 1 is the default set (the seed); written the first time anything asks, so there's always a current version. */
async function ensureFirstAbout(audience: AboutAudience, conn: Conn) {
  await conn.insert(aboutConfigs).values({ audience, version: 1, config: aboutConfigSchemaFor(audience).parse(DEFAULT_ABOUT[audience]) }).onConflictDoNothing();
}

/** About you for an audience: the newest version is current. Never empty. */
export async function currentAboutConfig(audience: AboutAudience, conn: Conn = db): Promise<AboutConfigRow> {
  const newest = () => conn.select().from(aboutConfigs).where(eq(aboutConfigs.audience, audience)).orderBy(desc(aboutConfigs.version)).limit(1);
  let [row] = await newest();
  if (!row) {
    await ensureFirstAbout(audience, conn);
    [row] = await newest();
  }
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

/** The seed: version 1 of each set, if it isn't there yet. */
export async function seedAboutConfigs(conn: Conn = db) {
  for (const audience of ["person", "brand"] as const) await ensureFirstAbout(audience, conn);
}

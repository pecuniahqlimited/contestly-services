import { eq } from "drizzle-orm";
import type { z } from "zod";
import {
  DEFAULT_PARTY_CONFIG, DEFAULT_PAYOUT_CONFIG, DEFAULT_QUESTIONS_CONFIG,
  partyConfigSchema, payoutConfigSchema, questionsConfigSchema,
} from "@contestly/shared";
import { db } from "./client.js";
import { appConfig } from "./schema.js";

/** One admin-editable JSON document per key, validated by its shared schema, defaulting when nothing is stored. */
function configEntry<T>(key: string, schema: z.ZodType<T>, fallback: T) {
  return {
    async get(): Promise<T> {
      const [row] = await db.select().from(appConfig).where(eq(appConfig.key, key));
      return row ? schema.parse(row.value) : fallback;
    },
    async set(value: unknown): Promise<T> {
      const parsed = schema.parse(value);
      await db.insert(appConfig).values({ key, value: parsed }).onConflictDoUpdate({ target: appConfig.key, set: { value: parsed, updatedAt: new Date() } });
      return parsed;
    },
  };
}

/** Payout Challenge config (entry, decision timer, stages). */
const payout = configEntry("payout", payoutConfigSchema, DEFAULT_PAYOUT_CONFIG);
export const getPayoutConfig = payout.get;
export const setPayoutConfig = payout.set;

/** Party round + settlement config (rake, host cut, default split, beat timings). */
const party = configEntry("party", partyConfigSchema, DEFAULT_PARTY_CONFIG);
export const getPartyConfig = party.get;
export const setPartyConfig = party.set;

/** Question-engine config (reserves, generation timeout, dedupe threshold, flag rules). */
const questions = configEntry("questions", questionsConfigSchema, DEFAULT_QUESTIONS_CONFIG);
export const getQuestionsConfig = questions.get;
export const setQuestionsConfig = questions.set;

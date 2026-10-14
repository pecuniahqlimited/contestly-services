import { pgTable, uuid, text, integer, bigint, boolean, timestamp, jsonb, primaryKey, uniqueIndex, index, pgEnum } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const partyStatus = pgEnum("party_status", ["open", "live", "finished", "cancelled"]);
export const fundingKind = pgEnum("funding_kind", ["pooled", "host"]);
export const visibilityKind = pgEnum("visibility_kind", ["public", "private"]);
export const accountKind = pgEnum("account_kind", ["cash", "bonus"]);
export const questionFormat = pgEnum("question_format", ["pick_one", "pick_all", "order", "match", "picture"]);
export const partyQuestionStatus = pgEnum("party_question_status", ["pending", "played", "voided"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  firebaseUid: text("firebase_uid").unique(),
  phone: text("phone"),
  handle: text("handle").notNull().unique(),
  displayName: text("display_name").notNull(),
  avatarEmoji: text("avatar_emoji").notNull().default("😎"),
  bio: text("bio"),
  interests: text("interests").array().notNull().default(sql`'{}'::text[]`),
  isBrand: boolean("is_brand").notNull().default(false),
  isVerified: boolean("is_verified").notNull().default(false),
  streakDays: integer("streak_days").notNull().default(0),
  lastPlayedOn: text("last_played_on"), // YYYY-MM-DD, used for streaks
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const follows = pgTable("follows", {
  followerId: uuid("follower_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  followeeId: uuid("followee_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  notify: boolean("notify").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.followerId, t.followeeId] }), index("follows_followee_idx").on(t.followeeId)]);

export const parties = pgTable("parties", {
  id: uuid("id").primaryKey().defaultRandom(),
  /**
   * Who clicked create; never null. The *public* host is resolved only through
   * `publicHost()` in host.ts (ADR 0001): today the creator, from step 4 the brand when
   * a nullable brand_id lands here. Don't read this column directly for display.
   */
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  title: text("title").notNull(),
  category: text("category").notNull(),
  entryKobo: integer("entry_kobo").notNull().default(0),
  maxPlayers: integer("max_players").notNull(),
  questionCount: integer("question_count").notNull().default(5),
  questionSeconds: integer("question_seconds").notNull().default(15),
  funding: fundingKind("funding").notNull(),
  hostPoolKobo: integer("host_pool_kobo").notNull().default(0),
  split: integer("split").array().notNull(),
  visibility: visibilityKind("visibility").notNull().default("public"),
  coverColor: text("cover_color").notNull().default("#7B5CFF"),
  coverEmoji: text("cover_emoji").notNull().default("🎉"),
  status: partyStatus("status").notNull().default("open"),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("parties_status_starts_idx").on(t.status, t.startsAt)]);

export const partyPlayers = pgTable("party_players", {
  partyId: uuid("party_id").notNull().references(() => parties.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  score: integer("score"),
  rank: integer("rank"),
  prizeKobo: integer("prize_kobo"),
}, (t) => [primaryKey({ columns: [t.partyId, t.userId] })]);

/**
 * The set attached to a party when it goes live. `payload` is the full server payload, correct
 * answers included — it never leaves the server before the question closes; clients get the
 * stripped public view from packages/game. Reserves (`reserve: true`) sit after the play order
 * and are appended by flag → void → replace (step 2).
 */
export const partyQuestions = pgTable("party_questions", {
  id: uuid("id").primaryKey().defaultRandom(),
  partyId: uuid("party_id").notNull().references(() => parties.id, { onDelete: "cascade" }),
  idx: integer("idx").notNull(), // play order, 0-based; reserves continue the numbering
  format: questionFormat("format").notNull(),
  payload: jsonb("payload").notNull(),
  seconds: integer("seconds").notNull(),
  explanation: text("explanation"),
  status: partyQuestionStatus("status").notNull().default("pending"),
  reserve: boolean("reserve").notNull().default(false),
  sourceRef: text("source_ref"), // step 2: bank question id / file chunk the question came from
}, (t) => [uniqueIndex("party_questions_party_idx").on(t.partyId, t.idx)]);

/**
 * One row per (question, player): the submitted answer, server-measured time, and the grade.
 * Written when the round closes each question; the live tally stays in the room's memory.
 */
export const partyAnswers = pgTable("party_answers", {
  partyId: uuid("party_id").notNull().references(() => parties.id, { onDelete: "cascade" }),
  questionId: uuid("question_id").notNull().references(() => partyQuestions.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id),
  answer: jsonb("answer"), // format-specific; null = no answer submitted
  answeredMs: integer("answered_ms"), // server receive − server open; null = no answer
  correctness: integer("correctness_pct").notNull().default(0), // 0–100, partial credit included
  points: integer("points").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.questionId, t.userId] }), index("party_answers_party_idx").on(t.partyId)]);

export const chatMessages = pgTable("chat_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  partyId: uuid("party_id").notNull().references(() => parties.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => users.id),
  text: text("text"),
  sticker: text("sticker"),
  system: boolean("system").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("chat_party_created_idx").on(t.partyId, t.createdAt)]);

/** One account per (user, kind). balance is materialised and only ever changed inside the ledger transaction. */
export const ledgerAccounts = pgTable("ledger_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  kind: accountKind("kind").notNull(),
  balanceKobo: bigint("balance_kobo", { mode: "number" }).notNull().default(0),
}, (t) => [uniqueIndex("ledger_accounts_user_kind").on(t.userId, t.kind)]);

/** Append-only. Never update or delete rows here. */
export const ledgerEntries = pgTable("ledger_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => ledgerAccounts.id),
  amountKobo: bigint("amount_kobo", { mode: "number" }).notNull(), // signed
  type: text("type").notNull(), // welcome_bonus | party_entry | party_prize | party_refund | payout_entry | payout_prize | topup | withdrawal
  refType: text("ref_type"),
  refId: text("ref_id"),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("ledger_entries_account_idx").on(t.accountId, t.createdAt)]);

/** Admin-editable settings, one JSON document per key (e.g. "payout"). Read through packages/db/src/config.ts, which validates. */
export const appConfig = pgTable("app_config", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type Party = typeof parties.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;

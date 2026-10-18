import { pgTable, uuid, text, integer, bigint, real, boolean, timestamp, jsonb, vector, primaryKey, uniqueIndex, index, pgEnum } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { EMBEDDING_DIM, PARTY_FILE_STATUSES, QUESTIONS_STATUSES } from "@contestly/shared";

export const partyStatus = pgEnum("party_status", ["open", "live", "finished", "cancelled"]);
export const fundingKind = pgEnum("funding_kind", ["pooled", "host"]);
export const visibilityKind = pgEnum("visibility_kind", ["public", "private"]);
export const accountKind = pgEnum("account_kind", ["cash", "bonus"]);
export const questionFormat = pgEnum("question_format", ["pick_one", "pick_all", "order", "match", "picture"]);
/** "draft" exists only in curate mode: generated, awaiting host approval (approve → "pending"). */
export const partyQuestionStatus = pgEnum("party_question_status", ["pending", "played", "voided", "draft"]);
export const partyMode = pgEnum("party_mode", ["sealed", "curate"]);
export const questionsStatus = pgEnum("questions_status", QUESTIONS_STATUSES);
export const partyFileStatus = pgEnum("party_file_status", PARTY_FILE_STATUSES);
export const questionEventKind = pgEnum("question_event_kind", ["flag", "void", "replace", "approve", "edit", "swap", "regenerate"]);
export const prizeKind = pgEnum("prize_kind", ["cash", "noncash"]);
export const fulfilmentStatus = pgEnum("fulfilment_status", ["awarded", "arranged", "delivered", "disputed"]);
export const partyDifficulty = pgEnum("party_difficulty", ["easy", "mixed", "hard", "brutal"]);
export const difficultySource = pgEnum("difficulty_source", ["model_estimate", "play_stats"]);
export const bankQuestionStatus = pgEnum("bank_question_status", ["active", "pending_review", "retired"]);
export const generationOutcome = pgEnum("generation_outcome", ["accepted", "rejected_invalid", "rejected_verify", "rejected_dedupe", "rejected_safety"]);

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
  /** Internal accounts (the rake treasury). Never shown in discovery, never plays. */
  isSystem: boolean("is_system").notNull().default(false),
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
  /** The host's free-text source for question generation. Files land in step 2b. */
  brief: text("brief").notNull().default(""),
  /** Inferred from the brief (no category picker); the engine may refine it when it builds the spec. */
  category: text("category").notNull(),
  difficulty: partyDifficulty("difficulty").notNull().default("mixed"),
  formats: questionFormat("formats").array().notNull().default(sql`'{pick_one,pick_all,order,match,picture}'::question_format[]`),
  /** The engine's one-line "what we understood", written when the set is generated. */
  specSummary: text("spec_summary"),
  /**
   * sealed: generated at start, nobody sees it first, the host plays.
   * curate: generated at creation as drafts the host's team reviews; the host can't play (ADR 0003).
   */
  mode: partyMode("mode").notNull().default("sealed"),
  /**
   * The set's state, shown on party detail and in the lobby without any content. Sealed parties
   * start generating at creation; the room starts a round only once this is "ready" (ADR 0002).
   */
  questionsStatus: questionsStatus("questions_status").notNull().default("not_started"),
  /** Why the set failed, worded for the host. Never anything from the questions themselves. */
  questionsError: text("questions_error"),
  entryKobo: integer("entry_kobo").notNull().default(0),
  maxPlayers: integer("max_players").notNull(),
  questionCount: integer("question_count").notNull().default(5),
  questionSeconds: integer("question_seconds").notNull().default(15),
  funding: fundingKind("funding").notNull(),
  hostPoolKobo: integer("host_pool_kobo").notNull().default(0),
  /** Non-cash prizes (a product, an experience) are a fulfilment state machine, never a ledger entry. */
  prizeKind: prizeKind("prize_kind").notNull().default("cash"),
  prizeText: text("prize_text"),
  /** Non-cash prizes only: what it's roughly worth, for display. No money moves on it. */
  prizeValueKobo: integer("prize_value_kobo"),
  split: integer("split").array().notNull(),
  visibility: visibilityKind("visibility").notNull().default("public"),
  coverColor: text("cover_color").notNull().default("#7B5CFF"),
  coverEmoji: text("cover_emoji").notNull().default("🎉"),
  status: partyStatus("status").notNull().default("open"),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  /** When the party went live; the worker's watchdog cancels if no set lands within the generation timeout. */
  liveAt: timestamp("live_at", { withTimezone: true }),
  /** When it finished or was cancelled; the source sweep counts its retention window from here. */
  endedAt: timestamp("ended_at", { withTimezone: true }),
  /** Set when record_play has folded this party's answer stats into the bank (job idempotency). */
  playStatsRecordedAt: timestamp("play_stats_recorded_at", { withTimezone: true }),
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
  /** The bank question this came from (the bank row cites its file chunk). Null for host-authored edits, which stay out of the bank. */
  sourceRef: text("source_ref"),
  /** Edited by the host in curate mode. */
  hostAuthored: boolean("host_authored").notNull().default(false),
}, (t) => [uniqueIndex("party_questions_party_idx").on(t.partyId, t.idx)]);

/**
 * Per-party log of everything that happened to a party's questions: player flags, voids (with
 * the tally and threshold), replacements, and curate-mode review actions (approve, edit, swap,
 * regenerate) — so an admin can see who approved what, and why a question disappeared mid-game.
 */
export const partyQuestionEvents = pgTable("party_question_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  partyId: uuid("party_id").notNull().references(() => parties.id, { onDelete: "cascade" }),
  questionId: uuid("question_id").notNull().references(() => partyQuestions.id, { onDelete: "cascade" }),
  kind: questionEventKind("kind").notNull(),
  userId: uuid("user_id").references(() => users.id), // null for engine actions (void, replace)
  reason: text("reason"), // flag reason
  detail: jsonb("detail"), // void: { flaggers, threshold, playerCount }; replace: { replacedQuestionId }; …
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("party_question_events_party_idx").on(t.partyId, t.createdAt)]);

/** Who has seen a curate party's drafts. Anyone here is barred from playing that party. */
export const partyDraftViews = pgTable("party_draft_views", {
  partyId: uuid("party_id").notNull().references(() => parties.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id),
  firstViewedAt: timestamp("first_viewed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.partyId, t.userId] })]);

/**
 * A source file the host attached to a party (PDF/DOCX), as metadata only: the API read it in memory
 * and kept just its text, chunked (file_chunks); the bytes were never stored. The questions service
 * embeds the chunks. Questions are generated only from them and cite the chunk they came from. A new
 * file replaces the old one; the source sweep deletes both a retention window after the party ends.
 */
export const partyFiles = pgTable("party_files", {
  id: uuid("id").primaryKey().defaultRandom(),
  partyId: uuid("party_id").notNull().references(() => parties.id, { onDelete: "cascade" }),
  uploaderId: uuid("uploader_id").notNull().references(() => users.id),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  status: partyFileStatus("status").notNull().default("parsing"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("party_files_party_idx").on(t.partyId)]);

export const fileChunks = pgTable("file_chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  fileId: uuid("file_id").notNull().references(() => partyFiles.id, { onDelete: "cascade" }),
  idx: integer("idx").notNull(),
  text: text("text").notNull(),
  /** Null until the questions service has embedded it (file status "parsing"). */
  embedding: vector("embedding", { dimensions: EMBEDDING_DIM }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("file_chunks_file_idx").on(t.fileId, t.idx)]);

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

/**
 * The question bank: every question that passed the generation gate, plus (from step 2b) host-authored
 * ones. Retrieval pulls from here before generating; play stats flow back in via record_play and
 * recalibrate difficulty once a question has been answered enough. `payload` includes correct answers
 * and never leaves the server. Stats are raw counters so recalibration is pure math over the row.
 */
export const bankQuestions = pgTable("bank_questions", {
  id: uuid("id").primaryKey().defaultRandom(),
  format: questionFormat("format").notNull(),
  payload: jsonb("payload").notNull(),
  explanation: text("explanation"),
  categoryTag: text("category_tag").notNull(),
  language: text("language").notNull().default("en"),
  embedding: vector("embedding", { dimensions: EMBEDDING_DIM }).notNull(),
  /** 0 (everyone gets it) … 1 (nobody does). Marked by provenance: a model estimate until real answer rates recalibrate it. */
  difficulty: real("difficulty").notNull(),
  difficultySource: difficultySource("difficulty_source").notNull().default("model_estimate"),
  status: bankQuestionStatus("status").notNull().default("active"),
  origin: text("origin").notNull().default("generated"),
  sourceChunkId: uuid("source_chunk_id"), // the file chunk this question was generated from (file-sourced parties)
  timesPlayed: integer("times_played").notNull().default(0), // parties this question ran in
  timesAnswered: integer("times_answered").notNull().default(0),
  correctnessSum: integer("correctness_sum").notNull().default(0), // sum of per-answer correctness (0–100)
  answeredMsSum: bigint("answered_ms_sum", { mode: "number" }).notNull().default(0),
  timesSkipped: integer("times_skipped").notNull().default(0), // graded with no answer submitted
  flagCount: integer("flag_count").notNull().default(0), // player flags across all parties
  retiredReason: text("retired_reason"), // flagged | too_hard | skipped (set by the retirement sweep)
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastPlayedAt: timestamp("last_played_at", { withTimezone: true }),
}, (t) => [
  index("bank_questions_status_category_idx").on(t.status, t.categoryTag),
  index("bank_questions_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
]);

/**
 * The generation record: one row per generated draft, accepted or rejected, so an admin can see for
 * any question the brief, the spec, what the verifier said, what it nearly duplicated, and why the
 * gate let it through or not. Bank-reused questions get no row; their provenance is party_questions.source_ref.
 * `outcome` is the per-draft gate result. `bank_question_id` is set only when the whole set sealed:
 * an "accepted" row without one belonged to an attempt that couldn't fill count + reserves (each
 * retry of a failed generate_set leaves its own batch of rows).
 */
export const questionGenerations = pgTable("question_generations", {
  id: uuid("id").primaryKey().defaultRandom(),
  partyId: uuid("party_id").notNull().references(() => parties.id, { onDelete: "cascade" }),
  bankQuestionId: uuid("bank_question_id").references(() => bankQuestions.id), // null when rejected
  brief: text("brief").notNull(),
  spec: jsonb("spec").notNull(), // the full GenerationSpec, one-line summary included
  draft: jsonb("draft").notNull(), // { format, payload, explanation, claim } as generated
  verify: jsonb("verify"), // { verdict, sources, note } from the independent verification pass
  dedupe: jsonb("dedupe"), // { nearestId, similarity } against bank + batch
  difficulty: jsonb("difficulty"), // { value, source }
  safety: jsonb("safety"), // { passed, reasons }
  outcome: generationOutcome("outcome").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("question_generations_party_idx").on(t.partyId)]);

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

/**
 * Non-cash prize fulfilment: awarded → arranged → delivered, or disputed. Winner and host are
 * both notified by the worker (day 3 and 7 nudges land in roadmap step 7). One prize per party.
 */
export const prizeFulfilments = pgTable("prize_fulfilments", {
  id: uuid("id").primaryKey().defaultRandom(),
  partyId: uuid("party_id").notNull().references(() => parties.id),
  winnerUserId: uuid("winner_user_id").notNull().references(() => users.id),
  /** Who owes delivery: the party's creator today, the brand's team from step 4. */
  hostUserId: uuid("host_user_id").notNull().references(() => users.id),
  prizeText: text("prize_text").notNull(),
  status: fulfilmentStatus("status").notNull().default("awarded"),
  awardedAt: timestamp("awarded_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("prize_fulfilments_party").on(t.partyId)]);

/** Admin-editable settings, one JSON document per key (e.g. "payout"). Read through packages/db/src/config.ts, which validates. */
export const appConfig = pgTable("app_config", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type Party = typeof parties.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type BankQuestion = typeof bankQuestions.$inferSelect;
export type PartyQuestion = typeof partyQuestions.$inferSelect;

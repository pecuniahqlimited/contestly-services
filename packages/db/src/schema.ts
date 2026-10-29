import { pgTable, uuid, text, integer, bigint, real, boolean, timestamp, jsonb, vector, primaryKey, uniqueIndex, index, pgEnum, serial, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { CREW_ROLES, FEED_KINDS, CHAT_MEMBER_STATES, CHAT_MESSAGE_KINDS, CHAT_THREAD_KINDS, CLIMB_AWARD_STATUSES, CLIMB_RUN_STATUSES, EMBEDDING_DIM, PARTY_FILE_STATUSES, PRIZE_KINDS, QUESTIONS_STATUSES, type ChallengeQuestion, type ClimbLadder, type ForgeProgress, type AboutAnswers, type AboutConfig, type PartyLimits } from "@contestly/shared";

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
export const inviteStatus = pgEnum("invite_status", ["pending", "accepted", "dismissed"]);
export const prizeKind = pgEnum("prize_kind", PRIZE_KINDS);
export const fulfilmentStatus = pgEnum("fulfilment_status", ["awarded", "arranged", "delivered", "disputed"]);
export const partyDifficulty = pgEnum("party_difficulty", ["easy", "mixed", "hard", "brutal"]);
export const difficultySource = pgEnum("difficulty_source", ["model_estimate", "play_stats"]);
export const bankQuestionStatus = pgEnum("bank_question_status", ["active", "pending_review", "retired"]);
export const generationOutcome = pgEnum("generation_outcome", ["accepted", "rejected_invalid", "rejected_verify", "rejected_dedupe", "rejected_safety"]);

/**
 * A person (or, until row 8, a brand) — or a guest. Every session is a Firebase user from the first
 * screen; an anonymous one is a guest row (is_guest) that can play but not hold coins, be on boards or
 * win. Signing up turns the same row into an account, so nothing is copied or merged (ADR 0006).
 * How a session reaches this row is user_identities.
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  isGuest: boolean("is_guest").notNull().default(false),
  isAdmin: boolean("is_admin").notNull().default(false),
  /** Lowercased; the account key. Set only once verified (email code, Google or Apple). */
  email: text("email").unique(),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  /** E.164, verified by SMS. Optional; needed before the first withdrawal. Never shown. */
  phone: text("phone"),
  phoneVerifiedAt: timestamp("phone_verified_at", { withTimezone: true }),
  /** HMAC(PHONE_HASH_SECRET, sha256(phone)): what contact matching compares. One account per number. */
  phoneHmac: text("phone_hmac").unique(),
  /** Who's playing (person | brand), asked once and editable from Me. */
  who: text("who"),
  /**
   * About you: the picks, against the version of the audience's set they were given for. Lanes go to
   * `interests`; the archetype is what Home leads with. A new config version never touches these.
   */
  aboutAudience: text("about_audience"),
  aboutVersion: integer("about_version"),
  aboutAnswers: jsonb("about_answers").$type<AboutAnswers>(),
  aboutAnsweredAt: timestamp("about_answered_at", { withTimezone: true }),
  archetype: text("archetype"),
  /** Banned by an admin: can't sign in, join, host or play (assertNotBanned). Unban clears both. */
  bannedAt: timestamp("banned_at", { withTimezone: true }),
  banReason: text("ban_reason"),
  /** A staked invite this person opened before signing up: onboarding ends in its lobby. */
  invitePartyId: uuid("invite_party_id").references((): AnyPgColumn => parties.id, { onDelete: "set null" }),
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
  /** The longest streak they've ever had (profiles, crew records). */
  bestStreakDays: integer("best_streak_days").notNull().default(0),
  lastPlayedOn: text("last_played_on"), // YYYY-MM-DD, used for streaks
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /**
   * Deleted by its owner (ADR 0010): a soft delete. The row and its id stay, with the ledger and every
   * record that points here. The live email is cleared (it can sign up again as a new account), the live
   * handle, name and face become the deleted placeholders, and what they were moves to the archive below
   * until the retention job clears it (archive_cleared_at).
   */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedReason: text("deleted_reason"),
  archivedEmail: text("archived_email"),
  archivedHandle: text("archived_handle"),
  archivedDisplayName: text("archived_display_name"),
  archivedAvatarEmoji: text("archived_avatar_emoji"),
  archivedBio: text("archived_bio"),
  archivedPhone: text("archived_phone"),
  archivedPhoneHmac: text("archived_phone_hmac"),
  archiveClearedAt: timestamp("archive_cleared_at", { withTimezone: true }),
}, (t) => [index("users_archived_email_idx").on(t.archivedEmail), index("users_archived_handle_idx").on(t.archivedHandle)]);

/**
 * How a session or a sign-in reaches an account: (provider, external id). "firebase" is the session
 * uid (a guest's anonymous uid, kept when it signs up); "google" and "apple" are the provider's
 * subject, from our own OAuth flow. "supabase" joins in the migration (row 11b).
 */
export const userIdentities = pgTable("user_identities", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull(),
  externalId: text("external_id").notNull(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /**
   * Set when the account was deleted: the row is kept (who it was) but reaches nothing, and the same
   * Google/Apple subject may then belong to a new account. Live identities are unique.
   */
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("user_identities_live_key").on(t.provider, t.externalId).where(sql`disabled_at is null`),
  index("user_identities_user_idx").on(t.userId),
]);

/**
 * Append-only: every admin action, who did it, to what, the state before and after, and why. Destructive
 * actions carry a reason. Never updated or deleted (like the ledger).
 */
export const adminActions = pgTable("admin_actions", {
  id: uuid("id").primaryKey().defaultRandom(),
  adminUserId: uuid("admin_user_id").notNull().references(() => users.id),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  reason: text("reason"),
  before: jsonb("before"),
  after: jsonb("after"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("admin_actions_target_idx").on(t.targetType, t.targetId, t.createdAt), index("admin_actions_created_idx").on(t.createdAt)]);

/**
 * About you, per audience (person | brand): one immutable row per admin save, numbered 1, 2, … within
 * the audience; the highest is current. Users' answers name the version they answered.
 */
export const aboutConfigs = pgTable("about_configs", {
  audience: text("audience").notNull(),
  version: integer("version").notNull(),
  config: jsonb("config").$type<AboutConfig>().notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.audience, t.version] })]);

/** Which email provider sends first: one immutable row per admin save; the newest is current. The other is the fallback. */
export const emailConfigs = pgTable("email_configs", {
  version: serial("version").primaryKey(),
  primary: text("primary").notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Every email send: which providers were tried and which one delivered (null: none did). */
export const emailSends = pgTable("email_sends", {
  id: uuid("id").primaryKey().defaultRandom(),
  template: text("template").notNull(),
  to: text("to").notNull(),
  deliveredBy: text("delivered_by"),
  /** [{ provider, ok, error? }] in the order tried. */
  attempts: jsonb("attempts").$type<{ provider: string; ok: boolean; error?: string }[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("email_sends_created_idx").on(t.createdAt)]);

export const follows = pgTable("follows", {
  followerId: uuid("follower_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  followeeId: uuid("followee_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  notify: boolean("notify").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.followerId, t.followeeId] }), index("follows_followee_idx").on(t.followeeId)]);

/**
 * Follows of or by a deleted account (ADR 0010), moved here from `follows` in the delete's transaction:
 * out of every live query, kept so an admin can see who the account was connected to.
 */
export const archivedFollows = pgTable("archived_follows", {
  id: uuid("id").primaryKey().defaultRandom(),
  followerId: uuid("follower_id").notNull().references(() => users.id),
  followeeId: uuid("followee_id").notNull().references(() => users.id),
  notify: boolean("notify").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("archived_follows_follower_idx").on(t.followerId), index("archived_follows_followee_idx").on(t.followeeId)]);

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
  /** The Forge: the engine's stage and the cards made so far (formats only), written as it goes. */
  forgeProgress: jsonb("forge_progress").$type<ForgeProgress>(),
  entryKobo: integer("entry_kobo").notNull().default(0),
  maxPlayers: integer("max_players").notNull(),
  questionCount: integer("question_count").notNull().default(5),
  questionSeconds: integer("question_seconds").notNull().default(15),
  funding: fundingKind("funding").notNull(),
  hostPoolKobo: integer("host_pool_kobo").notNull().default(0),
  /** Goods (a product, an experience) are a fulfilment state machine per winning place, never a ledger entry; their prizes are party_prizes. */
  prizeKind: prizeKind("prize_kind").notNull().default("cash"),
  /** The split's shares by place (SPLITS in shared); host cash and pooled pots are paid by it, goods use its number of places. */
  split: integer("split").array().notNull(),
  /** The admin's party limits when this party was created; later changes to the limits never apply to it. Null before limits existed. */
  limits: jsonb("limits").$type<PartyLimits>(),
  visibility: visibilityKind("visibility").notNull().default("public"),
  coverColor: text("cover_color").notNull().default("#7B5CFF"),
  coverEmoji: text("cover_emoji").notNull().default("🎉"),
  /** A crew party: started from a crew, its members invited; its wins are the crew's "most crew-party wins". */
  crewId: uuid("crew_id").references((): AnyPgColumn => crews.id, { onDelete: "set null" }),
  /** The party this one is a rematch of. One rematch per party: everyone who taps Rematch lands in it. */
  rematchOf: uuid("rematch_of").unique().references((): AnyPgColumn => parties.id, { onDelete: "set null" }),
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
  /** This seat. Leaving and rejoining makes a new one, so each entry's charge and refund keys are its own. */
  id: uuid("id").notNull().defaultRandom().unique(),
  /** The ledger key the entry was charged under; null for seats from before leaving existed (entryChargeKey()). */
  entryKey: text("entry_key"),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  score: integer("score"),
  rank: integer("rank"),
  prizeKobo: integer("prize_kobo"),
}, (t) => [primaryKey({ columns: [t.partyId, t.userId] }), index("party_players_user_idx").on(t.userId)]);

/**
 * A seat given up before the party locked (POST /parties/:id/leave): what was refunded, kept so a retry
 * answers with the same result and so a party's history shows who left.
 */
export const partyLeaves = pgTable("party_leaves", {
  /** The seat's id (party_players.id) as it was. */
  entryId: uuid("entry_id").primaryKey(),
  partyId: uuid("party_id").notNull().references(() => parties.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull(),
  refundedBonusKobo: integer("refunded_bonus_kobo").notNull(),
  refundedCashKobo: integer("refunded_cash_kobo").notNull(),
  leftAt: timestamp("left_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("party_leaves_party_user_idx").on(t.partyId, t.userId, t.leftAt)]);

/**
 * Someone asked to a party by a player or the host's team. Only people the inviter is connected to
 * (follows, is followed by, or has played with), capped per party. Shown in the invitee's Chats ›
 * Parties until they join (accepted) or dismiss it; nudges deliver it from step 7.
 */
export const partyInvites = pgTable("party_invites", {
  partyId: uuid("party_id").notNull().references(() => parties.id, { onDelete: "cascade" }),
  inviteeId: uuid("invitee_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  inviterId: uuid("inviter_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  status: inviteStatus("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  respondedAt: timestamp("responded_at", { withTimezone: true }),
}, (t) => [primaryKey({ columns: [t.partyId, t.inviteeId] }), index("party_invites_invitee_idx").on(t.inviteeId, t.status)]);

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

/**
 * An admin's edit of a bank question, re-checked like a new draft (verify, safety, dedupe) by the
 * questions service before it replaces the bank row. Pending until judged; the bank is untouched on a
 * rejection. The edit itself and every check result stay here.
 */
export const questionReviews = pgTable("question_reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  bankQuestionId: uuid("bank_question_id").notNull().references(() => bankQuestions.id, { onDelete: "cascade" }),
  adminUserId: uuid("admin_user_id").notNull().references(() => users.id),
  reason: text("reason").notNull(),
  /** { payload, explanation, claim } as the admin wrote it. */
  edit: jsonb("edit").notNull(),
  status: text("status").notNull().default("pending"), // pending | accepted | rejected_invalid | rejected_verify | rejected_dedupe | rejected_safety
  verify: jsonb("verify"),
  safety: jsonb("safety"),
  dedupe: jsonb("dedupe"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  judgedAt: timestamp("judged_at", { withTimezone: true }),
}, (t) => [index("question_reviews_bank_idx").on(t.bankQuestionId, t.createdAt)]);

export const chatThreadKind = pgEnum("chat_thread_kind", CHAT_THREAD_KINDS);
export const chatMessageKind = pgEnum("chat_message_kind", CHAT_MESSAGE_KINDS);
export const chatMemberState = pgEnum("chat_member_state", CHAT_MEMBER_STATES);
export const voiceNoteStatus = pgEnum("voice_note_status", ["pending", "attached", "expired"]);

/**
 * One conversation (ADR 0007): a party's room (one per party), two people (dm_key = their ids, sorted),
 * or a crew (row 6b). Lines are chat_messages; who's in it and what they've read is chat_members.
 */
export const chatThreads = pgTable("chat_threads", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: chatThreadKind("kind").notNull(),
  partyId: uuid("party_id").unique().references(() => parties.id, { onDelete: "cascade" }),
  dmKey: text("dm_key").unique(),
  crewId: uuid("crew_id").unique().references((): AnyPgColumn => crews.id, { onDelete: "cascade" }),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Who's in a thread and how far they've read. Party: the host's team and every seat (guests too). DM: both
 * people; the recipient of a message request is `request` until they accept (or `declined`). Crew: members.
 */
export const chatMembers = pgTable("chat_members", {
  threadId: uuid("thread_id").notNull().references(() => chatThreads.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  state: chatMemberState("state").notNull().default("active"),
  lastReadAt: timestamp("last_read_at", { withTimezone: true }).notNull().defaultNow(),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.threadId, t.userId] }), index("chat_members_user_idx").on(t.userId)]);

/**
 * A voice note: the client asks for an upload URL (pending), uploads straight to object storage, then sends
 * a line with it (attached). The worker transcribes it into moderation_items. Retention deletes the object
 * later (expired); the line stays.
 */
export const voiceNotes = pgTable("voice_notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  threadId: uuid("thread_id").notNull().references(() => chatThreads.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id),
  objectKey: text("object_key").notNull().unique(),
  contentType: text("content_type").notNull(),
  bytes: integer("bytes").notNull(),
  /** As the recorder reported it (capped); measuredMs is the transcriber's own measure, when it gives one. */
  durationMs: integer("duration_ms").notNull(),
  measuredMs: integer("measured_ms"),
  status: voiceNoteStatus("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  attachedAt: timestamp("attached_at", { withTimezone: true }),
  transcribedAt: timestamp("transcribed_at", { withTimezone: true }),
}, (t) => [index("voice_notes_status_created_idx").on(t.status, t.createdAt)]);

/**
 * One line in a thread. `client_msg_id` is the sender's id for it: a repeat send returns the first line.
 * System lines have no author. A party card points at a party (a challenge, a crew party).
 */
export const chatMessages = pgTable("chat_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  threadId: uuid("thread_id").notNull().references(() => chatThreads.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => users.id),
  kind: chatMessageKind("kind").notNull().default("text"),
  text: text("text"),
  sticker: text("sticker"),
  /** Handles of the real users this line @-mentions, resolved when it's sent; only these are tappable. */
  mentions: text("mentions").array().notNull().default(sql`'{}'::text[]`),
  voiceNoteId: uuid("voice_note_id").references(() => voiceNotes.id),
  cardPartyId: uuid("card_party_id").references(() => parties.id, { onDelete: "set null" }),
  clientMsgId: uuid("client_msg_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("chat_thread_created_idx").on(t.threadId, t.createdAt),
  uniqueIndex("chat_messages_client_msg").on(t.userId, t.clientMsgId),
]);

/**
 * Things a person needs to look at (row 11 reviews them). Today: every voice note's transcript. Reports,
 * flagged text and the rest join with their own `kind`.
 */
export const moderationItems = pgTable("moderation_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull(),
  refId: uuid("ref_id").notNull(),
  userId: uuid("user_id").references(() => users.id),
  threadId: uuid("thread_id").references(() => chatThreads.id, { onDelete: "set null" }),
  transcript: text("transcript"),
  provider: text("provider"),
  detail: jsonb("detail"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("moderation_items_ref").on(t.kind, t.refId), index("moderation_items_status_idx").on(t.status, t.createdAt)]);

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
  type: text("type").notNull(), // welcome_bonus | party_entry | party_prize | party_refund | climb_prize | topup | withdrawal
  refType: text("ref_type"),
  refId: text("ref_id"),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("ledger_entries_account_idx").on(t.accountId, t.createdAt)]);

/** A goods party's prize for one winning place: what it is and, optionally, roughly what it's worth (no money moves on it). */
export const partyPrizes = pgTable("party_prizes", {
  partyId: uuid("party_id").notNull().references(() => parties.id, { onDelete: "cascade" }),
  place: integer("place").notNull(),
  text: text("text").notNull(),
  valueKobo: integer("value_kobo"),
}, (t) => [primaryKey({ columns: [t.partyId, t.place] })]);

/**
 * Goods prize fulfilment, one per winning place: awarded → arranged → delivered, or disputed. Winner and host are
 * both notified by the worker (day 3 and 7 nudges land in roadmap step 7). The prize is copied in when awarded.
 */
export const prizeFulfilments = pgTable("prize_fulfilments", {
  id: uuid("id").primaryKey().defaultRandom(),
  partyId: uuid("party_id").notNull().references(() => parties.id),
  winnerUserId: uuid("winner_user_id").notNull().references(() => users.id),
  /** Who owes delivery: the party's creator today, the brand's team from step 4. */
  hostUserId: uuid("host_user_id").notNull().references(() => users.id),
  place: integer("place").notNull().default(1),
  prizeText: text("prize_text").notNull(),
  prizeValueKobo: integer("prize_value_kobo"),
  status: fulfilmentStatus("status").notNull().default("awarded"),
  awardedAt: timestamp("awarded_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("prize_fulfilments_party_place").on(t.partyId, t.place)]);

/** Admin-editable settings, one JSON document per key (e.g. "payout"). Read through packages/db/src/config.ts, which validates. */
export const appConfig = pgTable("app_config", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------- The Climb

export const climbRunStatus = pgEnum("climb_run_status", CLIMB_RUN_STATUSES);
export const climbAwardStatus = pgEnum("climb_award_status", CLIMB_AWARD_STATUSES);

/** The ladder, one immutable row per admin save. The newest is current; a run keeps the version it started on. */
export const climbLadders = pgTable("climb_ladders", {
  version: serial("version").primaryKey(),
  config: jsonb("config").$type<ClimbLadder>().notNull(),
  /** Null for the default written on first use. */
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Weekly prizes, one immutable row per admin save (winners, and kobo per place best first). */
export const climbPrizeConfigs = pgTable("climb_prize_configs", {
  version: serial("version").primaryKey(),
  winners: integer("winners").notNull(),
  prizeKobo: integer("prize_kobo").array().notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The prize version a week closes with: the one current when the week began. Pinned by the worker as each
 * Lagos day begins, and by the first score of the week if the worker missed it.
 */
export const climbWeekPrizes = pgTable("climb_week_prizes", {
  week: text("week").primaryKey(),
  prizeVersion: integer("prize_version").notNull().references(() => climbPrizeConfigs.version),
  pinnedAt: timestamp("pinned_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One climb up the ladder. At most one active run per player; starting another ends it (abandoned, its points kept). */
export const climbRuns = pgTable("climb_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  ladderVersion: integer("ladder_version").notNull().references(() => climbLadders.version),
  status: climbRunStatus("status").notNull().default("active"),
  /** 0-based stage being played, or the last one reached once over. */
  stageIdx: integer("stage_idx").notNull().default(0),
  stagesCleared: integer("stages_cleared").notNull().default(0),
  points: integer("points").notNull().default(0),
  /** The Lagos day the run started: its points count towards that day (a run can't outlast its ladder's clock). */
  day: text("day").notNull(),
  /** Per cleared stage, ms from its first round opening to the answer that cleared it (records: fastest stage 1). */
  stageMs: integer("stage_ms").array().notNull().default(sql`'{}'::integer[]`),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
}, (t) => [
  index("climb_runs_user_day_idx").on(t.userId, t.day),
  uniqueIndex("climb_runs_one_active").on(t.userId).where(sql`status = 'active'`),
]);

/** One round of a run: generated, stored with its answer, timed and graded on the server. */
export const climbRounds = pgTable("climb_rounds", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => climbRuns.id, { onDelete: "cascade" }),
  /** Order within the run. */
  seq: integer("seq").notNull(),
  stageIdx: integer("stage_idx").notNull(),
  gameType: text("game_type").notNull(),
  /** The full round, answer included. Only its public view leaves the server while it's open. */
  payload: jsonb("payload").notNull(),
  opensAt: timestamp("opens_at", { withTimezone: true }).notNull(),
  closesAt: timestamp("closes_at", { withTimezone: true }).notNull(),
  answer: jsonb("answer"),
  answeredAt: timestamp("answered_at", { withTimezone: true }),
  /** Null while open; false for a wrong, late or missing answer. */
  correct: boolean("correct"),
}, (t) => [uniqueIndex("climb_rounds_run_seq").on(t.runId, t.seq)]);

/** A player's Climb day: the best run's points, and Today's challenge. The record the boards are rebuilt from. */
export const climbDays = pgTable("climb_days", {
  userId: uuid("user_id").notNull().references(() => users.id),
  day: text("day").notNull(),
  /** The Monday of the day's week. */
  week: text("week").notNull(),
  runs: integer("runs").notNull().default(0),
  bestRunPoints: integer("best_run_points").notNull().default(0),
  bestRunStages: integer("best_run_stages").notNull().default(0),
  bestRunId: uuid("best_run_id").references(() => climbRuns.id),
  challengePoints: integer("challenge_points").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.userId, t.day] }), index("climb_days_week_idx").on(t.week)]);

/** A player's week: the sum of their days. Written with each day, in the same transaction. */
export const climbWeeks = pgTable("climb_weeks", {
  userId: uuid("user_id").notNull().references(() => users.id),
  week: text("week").notNull(),
  points: integer("points").notNull().default(0),
  /** Best run of the week in stages cleared, and whether it cleared its whole ladder. */
  bestRunStages: integer("best_run_stages").notNull().default(0),
  clearedAll: boolean("cleared_all").notNull().default(false),
  /** When the points last went up: the tie-break for weekly prizes (first there wins). */
  reachedAt: timestamp("reached_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.week] }), index("climb_weeks_week_points_idx").on(t.week, t.points)]);

/** Today's challenge: written by an admin for one Lagos day. Off on days without one. */
export const climbChallenges = pgTable("climb_challenges", {
  id: uuid("id").primaryKey().defaultRandom(),
  day: text("day").notNull().unique(),
  title: text("title").notNull(),
  questions: jsonb("questions").$type<ChallengeQuestion[]>().notNull(),
  seconds: integer("seconds").notNull(),
  maxPoints: integer("max_points").notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A player's one go at a challenge. */
export const climbChallengeAttempts = pgTable("climb_challenge_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  challengeId: uuid("challenge_id").notNull().references(() => climbChallenges.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  /** Per question, this player's option order: shown[i] = original option index. */
  optionOrder: jsonb("option_order").$type<number[][]>().notNull(),
  correct: integer("correct").notNull().default(0),
  points: integer("points").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [uniqueIndex("climb_attempts_one_per_user").on(t.challengeId, t.userId)]);

/** One question of an attempt, timed and graded on the server. `answer` is in original option order. */
export const climbChallengeAnswers = pgTable("climb_challenge_answers", {
  attemptId: uuid("attempt_id").notNull().references(() => climbChallengeAttempts.id, { onDelete: "cascade" }),
  idx: integer("idx").notNull(),
  opensAt: timestamp("opens_at", { withTimezone: true }).notNull(),
  closesAt: timestamp("closes_at", { withTimezone: true }).notNull(),
  answer: integer("answer"),
  answeredAt: timestamp("answered_at", { withTimezone: true }),
  correct: boolean("correct"),
}, (t) => [primaryKey({ columns: [t.attemptId, t.idx] })]);

/**
 * A closed week's final standings per board scope, written once by the worker at week close. "everyone":
 * the Climb's prize board (Climb points). "crew" (scope id = crew id): a crew's board, whose points are Climb
 * points plus party points (ADR 0008); first place wears the crown the week after.
 */
export const climbWeekResults = pgTable("climb_week_results", {
  week: text("week").notNull(),
  scope: text("scope").notNull(),
  scopeId: text("scope_id").notNull().default(""),
  userId: uuid("user_id").notNull().references(() => users.id),
  place: integer("place").notNull(),
  points: integer("points").notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.week, t.scope, t.scopeId, t.userId] }), uniqueIndex("climb_week_results_place").on(t.week, t.scope, t.scopeId, t.place)]);

/**
 * A weekly prize. Pending until an admin approves or rejects it. Approving pays it through the ledger
 * (key climb_award:<id>) when the winner has a signed-in account; otherwise it stays approved, unpaid.
 */
export const climbAwards = pgTable("climb_awards", {
  id: uuid("id").primaryKey().defaultRandom(),
  week: text("week").notNull(),
  scope: text("scope").notNull(),
  scopeId: text("scope_id").notNull().default(""),
  place: integer("place").notNull(),
  userId: uuid("user_id").notNull().references(() => users.id),
  points: integer("points").notNull(),
  amountKobo: integer("amount_kobo").notNull(),
  status: climbAwardStatus("status").notNull().default("pending"),
  decidedByUserId: uuid("decided_by_user_id").references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("climb_awards_place").on(t.week, t.scope, t.scopeId, t.place), index("climb_awards_status_idx").on(t.status)]);

export const crewRole = pgEnum("crew_role", CREW_ROLES);
export const feedKind = pgEnum("feed_kind", FEED_KINDS);

/** A private, invite-only group (row 6b). Archived when its last member leaves. */
export const crews = pgTable("crews", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  emoji: text("emoji").notNull(),
  color: text("color").notNull(),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
});

/** A crew's members. Exactly one creator; admins invite; the creator promotes, demotes and removes. */
export const crewMembers = pgTable("crew_members", {
  crewId: uuid("crew_id").notNull().references(() => crews.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: crewRole("role").notNull().default("member"),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.crewId, t.userId] }),
  index("crew_members_user_idx").on(t.userId),
  uniqueIndex("crew_members_one_creator").on(t.crewId).where(sql`role = 'creator'`),
]);

/** Someone asked to join a crew by its creator or an admin. They accept (a member) or dismiss it. Asking again re-opens it. */
export const crewInvites = pgTable("crew_invites", {
  crewId: uuid("crew_id").notNull().references(() => crews.id, { onDelete: "cascade" }),
  inviteeId: uuid("invitee_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  inviterId: uuid("inviter_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  status: inviteStatus("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  respondedAt: timestamp("responded_at", { withTimezone: true }),
}, (t) => [primaryKey({ columns: [t.crewId, t.inviteeId] }), index("crew_invites_invitee_idx").on(t.inviteeId, t.status)]);

/** Crew invites to or from a deleted account (ADR 0010), moved here from `crew_invites` like archived_follows. */
export const archivedCrewInvites = pgTable("archived_crew_invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  crewId: uuid("crew_id").notNull().references(() => crews.id),
  inviteeId: uuid("invitee_id").notNull().references(() => users.id),
  inviterId: uuid("inviter_id").notNull().references(() => users.id),
  status: inviteStatus("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  respondedAt: timestamp("responded_at", { withTimezone: true }),
  archivedAt: timestamp("archived_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("archived_crew_invites_invitee_idx").on(t.inviteeId), index("archived_crew_invites_inviter_idx").on(t.inviterId)]);

/**
 * A player's party points for one Lagos day (ADR 0008): written at settlement, bragging-rights parties only,
 * capped per day. The friends and crew boards add these to Climb points.
 */
export const partyDays = pgTable("party_days", {
  userId: uuid("user_id").notNull().references(() => users.id),
  day: text("day").notNull(),
  week: text("week").notNull(),
  points: integer("points").notNull().default(0),
  /** Parties that earned points that day (the cap counts these). */
  parties: integer("parties").notNull().default(0),
  wins: integer("wins").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.userId, t.day] }), index("party_days_week_idx").on(t.week)]);

/** What someone did, for their people's feed: written where it happens, never made up. No money in `data`. */
export const feedEvents = pgTable("feed_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: feedKind("kind").notNull(),
  data: jsonb("data").notNull(),
  /** A private party's finish is shown only to people who were in it. */
  partyId: uuid("party_id").references(() => parties.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("feed_events_user_created_idx").on(t.userId, t.createdAt), uniqueIndex("feed_events_party_once").on(t.userId, t.partyId).where(sql`kind = 'party_finished'`)]);

export type Crew = typeof crews.$inferSelect;
export type CrewMember = typeof crewMembers.$inferSelect;
export type PartyInvite = typeof partyInvites.$inferSelect;
export type User = typeof users.$inferSelect;
export type AdminActionRow = typeof adminActions.$inferSelect;
export type QuestionReviewRow = typeof questionReviews.$inferSelect;
export type Party = typeof parties.$inferSelect;
export type PartyPrize = typeof partyPrizes.$inferSelect;
export type ChatMessageRow = typeof chatMessages.$inferSelect;
export type ChatThread = typeof chatThreads.$inferSelect;
export type VoiceNote = typeof voiceNotes.$inferSelect;
export type BankQuestion = typeof bankQuestions.$inferSelect;
export type PartyQuestion = typeof partyQuestions.$inferSelect;
export type ClimbRunRow = typeof climbRuns.$inferSelect;
export type ClimbRoundRow = typeof climbRounds.$inferSelect;
export type ClimbChallengeRow = typeof climbChallenges.$inferSelect;
export type ClimbAttemptRow = typeof climbChallengeAttempts.$inferSelect;
export type ClimbAwardRow = typeof climbAwards.$inferSelect;

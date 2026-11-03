import { pgTable, uuid, text, integer, bigint, real, boolean, timestamp, jsonb, vector, primaryKey, uniqueIndex, index, pgEnum, serial, check, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { ALERT_SEVERITIES, CREW_ROLES, FEED_KINDS, CHAT_MEMBER_STATES, CHAT_MESSAGE_KINDS, CHAT_THREAD_KINDS, CLIMB_AWARD_STATUSES, CLIMB_RUN_STATUSES, EMBEDDING_DIM, PARTY_FILE_STATUSES, PRIZE_KINDS, QUESTIONS_STATUSES, type CancelledBy, type ChallengeQuestion, type ClimbLadder, type ClimbWordGame, type ForgeProgress, type AboutAnswers, type AboutConfig, type PartyLimits, FEE_BEARERS, PAYMENT_PERMISSIONS, PAYOUT_STATUSES, TOPUP_STATUSES, CORNER_STATUSES, type CornerUnlockConfig, type NewPlayerExclusion, type NewPlayerStatus, type NewPlayerVia } from "@contestly/shared";

export const partyStatus = pgEnum("party_status", ["open", "live", "finished", "cancelled"]);
export const fundingKind = pgEnum("funding_kind", ["pooled", "host"]);
export const visibilityKind = pgEnum("visibility_kind", ["public", "private"]);
/** cash and bonus are a person's; the rest are the platform's side of every journal (ledger.ts SYSTEM_ACCOUNT_KINDS, ADR 0013). */
/** entry_forfeited is unused (banned players' entries are refunded; ADR 0013); Postgres can't drop an enum value. */
export const accountKind = pgEnum("account_kind", ["cash", "bonus", "party_pot", "bonus_issued", "prize_funding", "dev_mint", "topup_in", "payout_pending", "payout_settled", "payout_fees", "platform_funds", "payout_owed", "contradiction_hold", "entry_forfeited", "fee_variance"]);
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
  /** Withdrawals frozen because a payout we reversed turned out to have been paid (ADR 0013); cleared when an admin resolves it. */
  withdrawalsFrozenAt: timestamp("withdrawals_frozen_at", { withTimezone: true }),
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
  /** normaliseEmail(archived email): Gmail dots and +tags dropped, so an alias of a deleted account's address matches it (ADR 0013). */
  archivedEmailKey: text("archived_email_key"),
  archiveClearedAt: timestamp("archive_cleared_at", { withTimezone: true }),
}, (t) => [
  index("users_archived_email_idx").on(t.archivedEmail), index("users_archived_handle_idx").on(t.archivedHandle),
  index("users_archived_email_key_idx").on(t.archivedEmailKey), index("users_archived_phone_hmac_idx").on(t.archivedPhoneHmac),
]);

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
 * Something an admin should look at (adminAlert() in alerts.ts). The same dedupe key inside its window
 * bumps count and last_seen_at instead of adding a row; once acknowledged, the next one is a new row.
 * `delivered` is, per channel (email, webhook), how many of `count` that channel has sent, so the worker
 * delivers each occurrence once per channel and a failing channel doesn't hold up the other.
 * Rows are acknowledged, never deleted.
 */
export const adminAlerts = pgTable("admin_alerts", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull(),
  severity: text("severity", { enum: ALERT_SEVERITIES }).notNull(),
  subject: text("subject").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  /** What it's about, for finding a thing's alerts (a payout, a party, a user). */
  refType: text("ref_type"),
  refId: text("ref_id"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  /** A repeat of the key before this bumps the row; after it, a new row. */
  windowEndsAt: timestamp("window_ends_at", { withTimezone: true }).notNull(),
  count: integer("count").notNull().default(1),
  delivered: jsonb("delivered").$type<Record<string, number>>().notNull().default({}),
  acknowledgedByUserId: uuid("acknowledged_by_user_id").references(() => users.id),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  ackNote: text("ack_note"),
}, (t) => [
  index("admin_alerts_dedupe_idx").on(t.dedupeKey, t.windowEndsAt),
  index("admin_alerts_open_idx").on(t.severity, t.lastSeenAt).where(sql`acknowledged_at is null`),
  index("admin_alerts_kind_idx").on(t.kind, t.lastSeenAt),
  index("admin_alerts_ref_idx").on(t.refType, t.refId),
]);

/** Every message the worker sent (or tried to) for admin alerts: the throttle and digest clock, and a record. */
export const adminAlertDeliveries = pgTable("admin_alert_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  channel: text("channel").notNull(),
  /** "immediate" (critical, one kind) or "digest" (warnings, every kind). */
  mode: text("mode", { enum: ["immediate", "digest"] }).notNull(),
  /** The alert kind for an immediate message; null for a digest. */
  kind: text("kind"),
  alertIds: uuid("alert_ids").array().notNull(),
  occurrences: integer("occurrences").notNull(),
  ok: boolean("ok").notNull(),
  error: text("error"),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("admin_alert_deliveries_clock_idx").on(t.channel, t.mode, t.kind, t.sentAt)]);

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

/** Someone follows a corner (ADR 0012): people follow hosts' corners, never each other. Per-corner party alerts, on by default. */
export const follows = pgTable("follows", {
  followerId: uuid("follower_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  cornerId: uuid("corner_id").notNull().references((): AnyPgColumn => corners.id, { onDelete: "cascade" }),
  notify: boolean("notify").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.followerId, t.cornerId] }), index("follows_corner_created_idx").on(t.cornerId, t.createdAt)]);

/**
 * Follows of or by a deleted account (ADR 0010), moved here from `follows` in the delete's transaction:
 * out of every live query, kept so an admin can see who the account was connected to. A deleted host's
 * corner is archived and its followers' follows move here too.
 */
export const archivedFollows = pgTable("archived_follows", {
  id: uuid("id").primaryKey().defaultRandom(),
  followerId: uuid("follower_id").notNull().references(() => users.id),
  cornerId: uuid("corner_id").notNull().references((): AnyPgColumn => corners.id),
  notify: boolean("notify").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("archived_follows_follower_idx").on(t.followerId), index("archived_follows_corner_idx").on(t.cornerId)]);

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
  /**
   * Who cancelled it, once cancelled: "host" (the host, POST /parties/:id/cancel), "admin" (who and why are
   * in admin_actions) or "system" (the start job, a failed set, a lost room).
   */
  cancelledBy: text("cancelled_by").$type<CancelledBy>(),
  /** The host who cancelled (cancelledBy "host"). */
  cancelledByUserId: uuid("cancelled_by_user_id").references(() => users.id),
  /** The host's optional reason; never shown publicly. */
  cancelReason: text("cancel_reason"),
  /** Written by the room each time a question opens: the worker's stall check reads how long since (from liveAt before the first). */
  roundProgressAt: timestamp("round_progress_at", { withTimezone: true }),
  /** When the worker last republished the start of a stalled live party; a second stall after it cancels and refunds. */
  stallRekickedAt: timestamp("stall_rekicked_at", { withTimezone: true }),
  /** What the start asked of the questions service when it went live (a roster swap, a set never built), so a replayed start job queues it again. */
  startFollowUp: text("start_follow_up", { enum: ["reseal", "generate"] }),
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

/**
 * One account per (user, kind, scope). balance is materialised and only ever changed inside ledger.journal().
 * A person's cash and bonus can't go below zero; platform accounts (owned by the treasury) can.
 */
export const ledgerAccounts = pgTable("ledger_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  kind: accountKind("kind").notNull(),
  /** Splits a platform account: a party's pot by party id, the payment accounts by provider. '' for a person's. */
  scope: text("scope").notNull().default(""),
  balanceKobo: bigint("balance_kobo", { mode: "number" }).notNull().default(0),
}, (t) => [
  uniqueIndex("ledger_accounts_user_kind_scope").on(t.userId, t.kind, t.scope),
  check("ledger_accounts_person_not_negative", sql`${t.kind} not in ('cash', 'bonus') or ${t.balanceKobo} >= 0`),
]);

/** Append-only. Never update or delete rows here. Every journal's legs sum to zero (ledger.journal()). */
export const ledgerEntries = pgTable("ledger_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** The legs written together. Null only on entries from before double entry (migration 0022). */
  journalId: uuid("journal_id"),
  accountId: uuid("account_id").notNull().references(() => ledgerAccounts.id),
  amountKobo: bigint("amount_kobo", { mode: "number" }).notNull(), // signed
  type: text("type").notNull(), // welcome_bonus | party_entry | party_prize | party_refund | climb_prize | topup | withdrawal
  refType: text("ref_type"),
  refId: text("ref_id"),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("ledger_entries_account_idx").on(t.accountId, t.createdAt), index("ledger_entries_journal_idx").on(t.journalId), index("ledger_entries_ref_idx").on(t.refType, t.refId)]);

// ---- Payments (row 10, ADR 0013) ----

/**
 * Which provider takes top-ups and which sends payouts, and whether either is paused: one immutable row per
 * change (an admin's, or the system's when an invariant breaks); the newest is current. Secrets are env only.
 */
export const paymentSettings = pgTable("payment_settings", {
  version: serial("version").primaryKey(),
  collections: text("collections").notNull(),
  payouts: text("payouts").notNull(),
  topupsPaused: boolean("topups_paused").notNull().default(false),
  payoutsPaused: boolean("payouts_paused").notNull().default(false),
  /** "admin" (who and why are also in admin_actions), or "system": the invariant job paused payouts. */
  changedBy: text("changed_by", { enum: ["admin", "system"] }).notNull().default("admin"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Admin permissions beyond the admin role (payments.*). Grants and revokes are logged in admin_actions. */
export const adminPermissions = pgTable("admin_permissions", {
  userId: uuid("user_id").notNull().references(() => users.id),
  permission: text("permission", { enum: PAYMENT_PERMISSIONS }).notNull(),
  grantedByUserId: uuid("granted_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.permission] })]);

/**
 * A top-up. Our reference, made by the server; credited once, only from a verified provider confirmation
 * that matches this row (ledger key topup:<provider>:<reference>). Finished by the provider that created it.
 */
export const topups = pgTable("topups", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  amountKobo: bigint("amount_kobo", { mode: "number" }).notNull(),
  currency: text("currency").notNull().default("NGN"),
  provider: text("provider").notNull(),
  reference: text("reference").notNull(),
  status: text("status", { enum: TOPUP_STATUSES }).notNull().default("pending"),
  checkoutUrl: text("checkout_url"),
  /** What the last verify said, in our terms and the provider's own words. */
  lastCheck: jsonb("last_check"),
  checks: integer("checks").notNull().default(0),
  nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
  /** Why it's a mismatch (or failed): what disagreed with our record. */
  problem: jsonb("problem"),
  creditedAt: timestamp("credited_at", { withTimezone: true }),
  /** What credited it: webhook, check (the worker), admin_verify, admin_finalize. */
  creditedVia: text("credited_via"),
  /** What was credited: the amount the provider verified (equal to amountKobo unless an admin credited a different verified amount). */
  creditedKobo: bigint("credited_kobo", { mode: "number" }),
  /** The provider last said an attempt failed; the checkout stays payable, so the top-up stays pending until it expires. */
  attemptFailedAt: timestamp("attempt_failed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("topups_provider_reference").on(t.provider, t.reference),
  uniqueIndex("topups_reference").on(t.reference),
  index("topups_user_created_idx").on(t.userId, t.createdAt),
  index("topups_due_idx").on(t.nextCheckAt).where(sql`status = 'pending'`),
  check("topups_amount_positive", sql`${t.amountKobo} > 0`),
]);

/** A bank account a person confirmed, resolved by (and so usable with) one payout provider. */
export const payoutAccounts = pgTable("payout_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  provider: text("provider").notNull(),
  bankCode: text("bank_code").notNull(),
  bankName: text("bank_name").notNull(),
  accountNumber: text("account_number").notNull(),
  /** As the bank resolved it and the person confirmed it. */
  accountName: text("account_name").notNull(),
  /** The provider's id for this recipient (Paystack's recipient_code). */
  recipientCode: text("recipient_code").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  removedAt: timestamp("removed_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("payout_accounts_live").on(t.userId, t.provider, t.bankCode, t.accountNumber).where(sql`removed_at is null`),
  index("payout_accounts_user_idx").on(t.userId),
]);

/**
 * A withdrawal. Debited into payout_pending when requested, before any provider call; then settled once on
 * a definite success, or reversed once on a definite failure (both under ledger key payout_final:<id>, so at
 * most one of them can ever exist). Anything else is unknown and requeried. Pinned to its provider.
 */
export const payouts = pgTable("payouts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  clientRequestId: uuid("client_request_id").notNull(),
  payoutAccountId: uuid("payout_account_id").notNull().references(() => payoutAccounts.id),
  amountKobo: bigint("amount_kobo", { mode: "number" }).notNull(),
  /** What the provider is asked to send: the amount, less the fee when the user bears it. */
  sentKobo: bigint("sent_kobo", { mode: "number" }).notNull(),
  /** The fee: estimated at request, the provider's figure once it succeeds. */
  feeKobo: bigint("fee_kobo", { mode: "number" }).notNull(),
  feeBearer: text("fee_bearer", { enum: FEE_BEARERS }).notNull(),
  currency: text("currency").notNull().default("NGN"),
  provider: text("provider").notNull(),
  /** Ours, and the provider's idempotency reference for the transfer. */
  reference: text("reference").notNull(),
  status: text("status", { enum: PAYOUT_STATUSES }).notNull(),
  /** Why it waits for an admin (threshold, daily ceiling, velocity, frozen). */
  holdReason: text("hold_reason"),
  sendAttempts: integer("send_attempts").notNull().default(0),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  checks: integer("checks").notNull().default(0),
  nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
  lastCheck: jsonb("last_check"),
  decidedByUserId: uuid("decided_by_user_id").references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  /** What made it final: send, check, webhook, admin_reject, admin_finalize. */
  finalVia: text("final_via"),
  finalAt: timestamp("final_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("payouts_provider_reference").on(t.provider, t.reference),
  uniqueIndex("payouts_reference").on(t.reference),
  uniqueIndex("payouts_user_request").on(t.userId, t.clientRequestId),
  index("payouts_user_created_idx").on(t.userId, t.createdAt),
  index("payouts_status_due_idx").on(t.status, t.nextCheckAt),
  check("payouts_amounts", sql`${t.amountKobo} > 0 and ${t.sentKobo} > 0 and ${t.feeKobo} >= 0 and ${t.sentKobo} <= ${t.amountKobo}`),
]);

/**
 * Every authenticated provider webhook, stored before it's acknowledged and processed by the worker. One row
 * per distinct event (a redelivery of the same body is the same row). Raw body kept for disputes.
 */
export const paymentWebhookEvents = pgTable("payment_webhook_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull(),
  eventId: text("event_id").notNull(),
  type: text("type").notNull(),
  reference: text("reference"),
  body: text("body").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  deliveries: integer("deliveries").notNull().default(1),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  outcome: text("outcome"),
  /** Processing attempts; one that left its top-up still pending, or threw, is tried again from next_attempt_at (the sweep). */
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  /** Given up on after webhooks.maxAttempts (alerted); never retried again. The top-up's own checks still run. */
  deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("payment_webhook_events_provider_event").on(t.provider, t.eventId), index("payment_webhook_events_reference_idx").on(t.reference),
  index("payment_webhook_events_retry_idx").on(t.nextAttemptAt).where(sql`processed_at is null`),
]);

/**
 * A webhook refused before it was stored (unknown provider, off the allow-list, bad signature): when, from
 * where, why, and the first 500 bytes, never the whole body. Capped per hour and kept 30 days (ADR 0013).
 * A spike (every webhook failing after a key rotation, say) alerts.
 */
export const paymentWebhookRejections = pgTable("payment_webhook_rejections", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull(),
  sourceIp: text("source_ip").notNull(),
  reason: text("reason").notNull(),
  head: text("head").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("payment_webhook_rejections_created_idx").on(t.createdAt)]);

/**
 * An admin's manual finalize of a stuck payout or top-up: the provider's answer when they asked, their
 * choice and reason, and (over the threshold) the second admin who confirmed it. Applied through the same
 * transitions as the automatic path.
 */
export const paymentFinalizations = pgTable("payment_finalizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  targetType: text("target_type", { enum: ["topup", "payout"] }).notNull(),
  targetId: uuid("target_id").notNull(),
  outcome: text("outcome", { enum: ["success", "failed"] }).notNull(),
  reason: text("reason").notNull(),
  providerCheck: jsonb("provider_check").notNull(),
  /** What it applies: a top-up credits the provider-verified amount; a payout its own amount. */
  amountKobo: bigint("amount_kobo", { mode: "number" }),
  /** Why a second admin must confirm: over_threshold, check_not_definite, check_disagrees, amount_differs. Empty: one admin. */
  secondAdminBecause: text("second_admin_because").array().notNull().default(sql`'{}'::text[]`),
  status: text("status", { enum: ["awaiting_second_admin", "applied", "superseded"] }).notNull(),
  requestedByUserId: uuid("requested_by_user_id").notNull().references(() => users.id),
  confirmedByUserId: uuid("confirmed_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
}, (t) => [
  index("payment_finalizations_target_idx").on(t.targetType, t.targetId),
  uniqueIndex("payment_finalizations_one_open").on(t.targetType, t.targetId).where(sql`status = 'awaiting_second_admin'`),
]);

/**
 * A payout we reversed that the provider later said was paid: the person got the money twice. Raised with
 * their withdrawals frozen, in the same transaction as the alert. An admin (payments.finalize) asks to
 * resolve it and a second admin confirms: the debit is re-applied up to the cash available, the rest is
 * recorded as owed (payout_owed), and withdrawals unfreeze once nothing else is open for them.
 */
export const payoutContradictions = pgTable("payout_contradictions", {
  id: uuid("id").primaryKey().defaultRandom(),
  payoutId: uuid("payout_id").notNull().references(() => payouts.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  amountKobo: bigint("amount_kobo", { mode: "number" }).notNull(),
  /** resolved: the transfer was confirmed paid, the hold became the recovery. dissolved: the provider later said it failed or was reversed. */
  status: text("status", { enum: ["open", "awaiting_second_admin", "resolved", "dissolved"] }).notNull().default("open"),
  /** The provider's answer that contradicted the reversal. */
  providerCheck: jsonb("provider_check").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  requestedByUserId: uuid("requested_by_user_id").references(() => users.id),
  requestReason: text("request_reason"),
  requestedAt: timestamp("requested_at", { withTimezone: true }),
  confirmedByUserId: uuid("confirmed_by_user_id").references(() => users.id),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  /** At the freeze: what was held from the person's cash, and what their cash didn't cover (booked as owed then). */
  recoveredKobo: bigint("recovered_kobo", { mode: "number" }),
  owedKobo: bigint("owed_kobo", { mode: "number" }),
}, (t) => [uniqueIndex("payout_contradictions_payout").on(t.payoutId), index("payout_contradictions_user_idx").on(t.userId)]);

/**
 * An invariant breach admins have acknowledged (ADR 0013): payments.config asks with a reason, a second
 * admin confirms. A breach of the same kind on the same items, no larger, doesn't pause payouts again; a new
 * or growing one does. Never edited after (except its status).
 */
export const invariantAcknowledgments = pgTable("invariant_acknowledgments", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull(),
  /** What it covers: item (account, party, provider…) → magnitude when acknowledged. */
  items: jsonb("items").notNull(),
  detail: jsonb("detail").notNull(),
  reason: text("reason").notNull(),
  status: text("status", { enum: ["awaiting_second_admin", "applied"] }).notNull(),
  requestedByUserId: uuid("requested_by_user_id").notNull().references(() => users.id),
  confirmedByUserId: uuid("confirmed_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
}, (t) => [index("invariant_acknowledgments_kind_idx").on(t.kind)]);

/**
 * Banning an admin who holds any payments permission (ADR 0013): one admin asks with a reason, a different
 * one confirms, neither of them the admin being banned. Otherwise a ban could lock out the other payments
 * admins (the config-holder floor counts only unbanned ones). Never edited after.
 */
export const adminBanRequests = pgTable("admin_ban_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  reason: text("reason").notNull(),
  status: text("status", { enum: ["awaiting_second_admin", "applied"] }).notNull(),
  requestedByUserId: uuid("requested_by_user_id").notNull().references(() => users.id),
  confirmedByUserId: uuid("confirmed_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
}, (t) => [uniqueIndex("admin_ban_requests_one_open").on(t.userId).where(sql`status = 'awaiting_second_admin'`)]);

/**
 * Clearing linked_payment_issue for an account (ADR 0013) is loosening: one admin with payments.finalize
 * asks with a reason, a different one confirms; neither may be the account holder. Never edited after.
 */
export const linkedIssueClearances = pgTable("linked_issue_clearances", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  /** The deleted accounts it was checked against: it clears those only; a new match blocks again. */
  coveredUserIds: uuid("covered_user_ids").array().notNull().default(sql`'{}'::uuid[]`),
  reason: text("reason").notNull(),
  status: text("status", { enum: ["awaiting_second_admin", "applied"] }).notNull(),
  requestedByUserId: uuid("requested_by_user_id").notNull().references(() => users.id),
  confirmedByUserId: uuid("confirmed_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
}, (t) => [uniqueIndex("linked_issue_clearances_one_open").on(t.userId).where(sql`status = 'awaiting_second_admin'`)]);

/**
 * Granting payments permissions is loosening (ADR 0013): a payments.config holder asks, a different one
 * confirms; never the grantee, never for themselves. Revoking applies at once. Never edited after.
 */
export const paymentPermissionGrants = pgTable("payment_permission_grants", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  /** grant: adding permissions. revoke: taking payments.config from one of the last two holders. */
  change: text("change", { enum: ["grant", "revoke"] }).notNull().default("grant"),
  permissions: text("permissions").array().notNull(),
  reason: text("reason").notNull(),
  status: text("status", { enum: ["awaiting_second_admin", "applied", "superseded"] }).notNull(),
  requestedByUserId: uuid("requested_by_user_id").notNull().references(() => users.id),
  confirmedByUserId: uuid("confirmed_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
}, (t) => [uniqueIndex("payment_permission_grants_one_open").on(t.userId).where(sql`status = 'awaiting_second_admin'`)]);

/**
 * Waiving what a person owes after a duplicate payout (ADR 0013): one admin with payments.finalize asks with
 * a reason, a different one confirms; the platform bears it (payout_owed ← platform_funds). Never edited after.
 */
export const owedWaivers = pgTable("owed_waivers", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  /** Owed when it was asked; no more than this is waived. */
  amountKobo: bigint("amount_kobo", { mode: "number" }).notNull(),
  reason: text("reason").notNull(),
  status: text("status", { enum: ["awaiting_second_admin", "applied", "superseded"] }).notNull(),
  requestedByUserId: uuid("requested_by_user_id").notNull().references(() => users.id),
  confirmedByUserId: uuid("confirmed_by_user_id").references(() => users.id),
  /** What was waived on confirm: the smaller of the request and what was still owed. */
  waivedKobo: bigint("waived_kobo", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
}, (t) => [uniqueIndex("owed_waivers_one_open").on(t.userId).where(sql`status = 'awaiting_second_admin'`)]);

/**
 * A change to payments config or settings that loosens a control (raises a limit or threshold, switches a
 * provider, un-pauses): it waits here for a second admin. Tightening applies at once. Never edited after.
 */
export const paymentConfigChanges = pgTable("payment_config_changes", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind", { enum: ["config", "settings"] }).notNull(),
  before: jsonb("before").notNull(),
  proposed: jsonb("proposed").notNull(),
  /** What it loosens, field by field. */
  loosens: text("loosens").array().notNull(),
  reason: text("reason").notNull(),
  status: text("status", { enum: ["awaiting_second_admin", "applied", "superseded"] }).notNull(),
  requestedByUserId: uuid("requested_by_user_id").notNull().references(() => users.id),
  confirmedByUserId: uuid("confirmed_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
}, (t) => [uniqueIndex("payment_config_changes_one_open").on(t.kind).where(sql`status = 'awaiting_second_admin'`)]);

/** A nightly comparison of our records with one provider's for one Lagos day. */
export const paymentReconRuns = pgTable("payment_recon_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull(),
  day: text("day").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  error: text("error"),
  counts: jsonb("counts"),
}, (t) => [index("payment_recon_runs_day_idx").on(t.provider, t.day)]);

/** One difference a reconciliation found. Never fixed automatically; an admin notes what they did. */
export const paymentReconItems = pgTable("payment_recon_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => paymentReconRuns.id),
  provider: text("provider").notNull(),
  object: text("object", { enum: ["topup", "payout"] }).notNull(),
  kind: text("kind", { enum: ["missing_ours", "missing_theirs", "amount_differs", "status_differs"] }).notNull(),
  reference: text("reference").notNull(),
  ours: jsonb("ours"),
  theirs: jsonb("theirs"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  note: text("note"),
}, (t) => [index("payment_recon_items_run_idx").on(t.runId), index("payment_recon_items_open_idx").on(t.createdAt).where(sql`resolved_at is null`)]);

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

/**
 * The Climb's word list: scramble, word search and word hunt draw from the active words allowed for them. Normalised
 * (lowercase letters, 3–12 long, past the safety filter) by checkClimbWord in @contestly/shared before it's written.
 * Words are switched off, never deleted, so rounds already played still read.
 */
export const climbWords = pgTable("climb_words", {
  id: uuid("id").primaryKey().defaultRandom(),
  word: text("word").notNull().unique(),
  active: boolean("active").notNull().default(true),
  games: text("games").array().$type<ClimbWordGame[]>().notNull(),
  /** Optional tag for finding words ("food", "places"); not used by the games yet. */
  theme: text("theme"),
  /** Null for the starter list. */
  addedByUserId: uuid("added_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("climb_words_active_idx").on(t.active)]);

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
  /** A corner_post event: the post (deleting it takes the event with it). */
  cornerPostId: uuid("corner_post_id").references((): AnyPgColumn => cornerPosts.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("feed_events_user_created_idx").on(t.userId, t.createdAt), index("feed_events_corner_post_idx").on(t.cornerPostId), uniqueIndex("feed_events_party_once").on(t.userId, t.partyId).where(sql`kind = 'party_finished'`)]);

// ---------------------------------------------------------------- Corners (ADR 0012, row 6c)

export const cornerStatus = pgEnum("corner_status", CORNER_STATUSES);

/**
 * A host's home, one per account, made the first time a party they host finishes (locked) or when a verified
 * brand is approved (createBrandCorner, unlocked). Shown only while unlocked, not archived and its owner isn't
 * banned: a ban hides it and an unban brings it back, with nothing written (cornerShown in corners.ts).
 */
export const corners = pgTable("corners", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull().unique().references(() => users.id),
  name: text("name").notNull(),
  bio: text("bio"),
  status: cornerStatus("status").notNull().default("locked"),
  level: integer("level").notNull().default(1),
  unlockedAt: timestamp("unlocked_at", { withTimezone: true }),
  /** The corner_configs version whose thresholds it met; null for a brand's corner (no unlock). */
  unlockConfigVersion: integer("unlock_config_version"),
  /** Who made up N when it unlocked, so an admin can spot-check it. */
  unlockContributors: uuid("unlock_contributors").array().notNull().default(sql`'{}'::uuid[]`),
  revokedByUserId: uuid("revoked_by_user_id").references(() => users.id),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedReason: text("revoked_reason"),
  /** Its owner deleted their account (ADR 0010): archived, its follows moved to archived_follows. */
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("corners_status_idx").on(t.status)]);

/** The unlock thresholds (P, R, D, N): one immutable row per admin save; the newest is current. Version 1 from the migration. */
export const cornerConfigs = pgTable("corner_configs", {
  version: integer("version").primaryKey(),
  config: jsonb("config").$type<CornerUnlockConfig>().notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Unlock progress, read model 1: every finished party a host hosted, with how many real players it had
 * (signed in, actually answered, host excluded) and whether that met R then. Written at settlement.
 */
export const cornerParties = pgTable("corner_parties", {
  partyId: uuid("party_id").primaryKey().references(() => parties.id, { onDelete: "cascade" }),
  hostUserId: uuid("host_user_id").notNull().references(() => users.id),
  realPlayers: integer("real_players").notNull(),
  counts: boolean("counts").notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
}, (t) => [index("corner_parties_host_idx").on(t.hostUserId, t.finishedAt)]);

/** Read model 2: the real players of each counted party (D is the distinct ones per host). */
export const cornerPartyPlayers = pgTable("corner_party_players", {
  partyId: uuid("party_id").notNull().references(() => parties.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id),
  hostUserId: uuid("host_user_id").notNull().references(() => users.id),
}, (t) => [primaryKey({ columns: [t.partyId, t.userId] }), index("corner_party_players_host_idx").on(t.hostUserId, t.userId)]);

/**
 * Read model 3: who brought each person to Contestly. One row per person, for the first host only: whoever
 * hosted their first finished party, or whose invite they signed up from. Pending until they've finished one
 * of that host's parties; then counted or excluded (with why), once. A ban takes a counted player out of N
 * without touching the row.
 */
export const cornerNewPlayers = pgTable("corner_new_players", {
  userId: uuid("user_id").primaryKey().references(() => users.id),
  hostUserId: uuid("host_user_id").notNull().references(() => users.id),
  via: text("via").$type<NewPlayerVia>().notNull(),
  status: text("status").$type<NewPlayerStatus>().notNull().default("pending"),
  reason: text("reason").$type<NewPlayerExclusion>(),
  /** The party that attributed them (first_party) or the invite's party. */
  partyId: uuid("party_id").references(() => parties.id, { onDelete: "set null" }),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("corner_new_players_host_idx").on(t.hostUserId, t.status)]);

/**
 * Soft signals per account, for the new-player rule and the unlock cluster warning: the install id the app
 * sends (INSTALL_ID_HEADER) and the client IP, each recorded the first time an account is seen with it.
 * Never shown to people; admins see them only through the unlock alerts.
 */
export const userSignals = pgTable("user_signals", {
  kind: text("kind").$type<"install" | "ip">().notNull(),
  value: text("value").notNull(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.kind, t.value, t.userId] }), index("user_signals_user_idx").on(t.userId)]);

/**
 * Played-with, a read model (ADR 0012): each pair of signed-up people who finished a party together, how many
 * times and when last. user_a < user_b. Written at settlement; DMs, your people and invites read it.
 */
export const playedWith = pgTable("played_with", {
  userA: uuid("user_a").notNull().references(() => users.id),
  userB: uuid("user_b").notNull().references(() => users.id),
  parties: integer("parties").notNull().default(1),
  lastPlayedAt: timestamp("last_played_at", { withTimezone: true }).notNull(),
}, (t) => [primaryKey({ columns: [t.userA, t.userB] }), index("played_with_b_idx").on(t.userB, t.lastPlayedAt), check("played_with_ordered", sql`${t.userA} < ${t.userB}`)]);

/** Contacts matched by phone hash (POST /me/contacts/match): `userId` has `contactUserId`'s number. Either way makes them contacts. */
export const contactMatches = pgTable("contact_matches", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  contactUserId: uuid("contact_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  matchedAt: timestamp("matched_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.contactUserId] }), index("contact_matches_contact_idx").on(t.contactUserId)]);

/** A host's post on their corner. Text only in v1. Deleting keeps the row (who deleted it) and hides it. */
export const cornerPosts = pgTable("corner_posts", {
  id: uuid("id").primaryKey().defaultRandom(),
  cornerId: uuid("corner_id").notNull().references(() => corners.id),
  authorUserId: uuid("author_user_id").notNull().references(() => users.id),
  text: text("text").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedByUserId: uuid("deleted_by_user_id").references(() => users.id),
}, (t) => [index("corner_posts_corner_created_idx").on(t.cornerId, t.createdAt)]);

/** One reaction per person per post, changeable. `muted`: sent while muted in the corner, so only its sender sees it. */
export const cornerPostReactions = pgTable("corner_post_reactions", {
  postId: uuid("post_id").notNull().references(() => cornerPosts.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id),
  emoji: text("emoji").notNull(),
  muted: boolean("muted").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.postId, t.userId] })]);

/** A reply to a post, one level deep, masked like a chat line. `muted`: written while muted, so only its author sees it. */
export const cornerPostReplies = pgTable("corner_post_replies", {
  id: uuid("id").primaryKey().defaultRandom(),
  postId: uuid("post_id").notNull().references(() => cornerPosts.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id),
  text: text("text").notNull(),
  clientMsgId: uuid("client_msg_id").notNull(),
  muted: boolean("muted").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedByUserId: uuid("deleted_by_user_id").references(() => users.id),
}, (t) => [index("corner_post_replies_post_idx").on(t.postId, t.createdAt), uniqueIndex("corner_post_replies_client").on(t.userId, t.clientMsgId)]);

/** A follower muted in a corner by its host: their replies and reactions there reach only themselves. They aren't told. */
export const cornerMutes = pgTable("corner_mutes", {
  cornerId: uuid("corner_id").notNull().references(() => corners.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  mutedByUserId: uuid("muted_by_user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.cornerId, t.userId] })]);

export type Corner = typeof corners.$inferSelect;
export type CornerPostRow = typeof cornerPosts.$inferSelect;

export type Crew = typeof crews.$inferSelect;
export type CrewMember = typeof crewMembers.$inferSelect;
export type PartyInvite = typeof partyInvites.$inferSelect;
export type User = typeof users.$inferSelect;
export type AdminActionRow = typeof adminActions.$inferSelect;
export type Topup = typeof topups.$inferSelect;
export type Payout = typeof payouts.$inferSelect;
export type PayoutAccount = typeof payoutAccounts.$inferSelect;
export type PaymentWebhookEvent = typeof paymentWebhookEvents.$inferSelect;
export type PaymentFinalization = typeof paymentFinalizations.$inferSelect;
export type PayoutContradiction = typeof payoutContradictions.$inferSelect;
export type PaymentConfigChange = typeof paymentConfigChanges.$inferSelect;
export type OwedWaiver = typeof owedWaivers.$inferSelect;
export type PaymentPermissionGrant = typeof paymentPermissionGrants.$inferSelect;
export type LinkedIssueClearance = typeof linkedIssueClearances.$inferSelect;
export type AdminBanRequest = typeof adminBanRequests.$inferSelect;
export type InvariantAcknowledgment = typeof invariantAcknowledgments.$inferSelect;
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
export type ClimbWordRow = typeof climbWords.$inferSelect;

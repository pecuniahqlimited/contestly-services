/**
 * Trust and safety (row 11, ADR 0014): block, mute, report, the moderation queue and its actions, notices the
 * app shows once, the banned screen, and the safety config. The app and the admin console parse these.
 */
import { z } from "zod";
import { personSchema } from "./person.js";
import { chatMessageSchema } from "./chat.js";
import { reasonSchema } from "./admin.js";

const iso = z.string();
const isoOrNull = iso.nullable();
const uuid = z.string().uuid();

// ---- reports ------------------------------------------------------------------------------

/** Why someone reports. `other` needs a note. The banned screen and a warning name one of these. */
export const REPORT_REASONS = ["harassment", "hate", "sexual_content", "spam_scam", "cheating", "impersonation", "self_harm", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/** What a report points at. A chat line is filed by its thread (party, DM, crew), a voice line as its voice note. */
export const REPORT_TARGET_TYPES = ["user", "message", "corner_post", "corner_reply", "party", "voice_note"] as const;
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];

/** The queue's kinds of item (filter by these). */
export const MODERATION_KINDS = ["user", "party_message", "dm_message", "crew_message", "corner_post", "corner_reply", "party", "voice_note"] as const;
export type ModerationKind = (typeof MODERATION_KINDS)[number];

export const MODERATION_STATUSES = ["open", "actioned", "dismissed"] as const;
export type ModerationStatus = (typeof MODERATION_STATUSES)[number];

export const REPORT_NOTE_MAX = 500;

/** POST /reports. */
export const reportBodySchema = z.object({
  target: z.object({ type: z.enum(REPORT_TARGET_TYPES), id: uuid }),
  reason: z.enum(REPORT_REASONS),
  note: z.string().trim().max(REPORT_NOTE_MAX).optional(),
}).refine((b) => b.reason !== "other" || !!b.note, { message: "say what's wrong", path: ["note"] });
export type ReportBody = z.infer<typeof reportBodySchema>;

/**
 * POST /reports → 201 (200 `replayed`: you'd reported it already). `offerBlock`: the person behind it, for the
 * app's "Block them too?", unless it's you or you've blocked them already.
 */
export const reportResponseSchema = z.object({ reportId: uuid, replayed: z.boolean(), offerBlock: personSchema.nullable() });
export type ReportResponse = z.infer<typeof reportResponseSchema>;

// ---- block and mute -----------------------------------------------------------------------

/** POST/DELETE /users/:id/block. Silent: they're never told. */
export const blockResponseSchema = z.object({ blocked: z.boolean() });
/** POST/DELETE /users/:id/mute: their chat lines and nudges about them stop reaching you. */
export const muteResponseSchema = z.object({ muted: z.boolean() });
/** GET /me/blocks: who you've blocked, newest first. */
export const myBlocksSchema = z.object({ blocks: z.array(z.object({ person: personSchema, blockedAt: iso })) });
export type MyBlocks = z.infer<typeof myBlocksSchema>;

// ---- notices (shown once) and the banned screen -------------------------------------------

export const NOTICE_KINDS = ["warning", "report_outcome"] as const;
export const REPORT_OUTCOMES = ["action_taken", "reviewed"] as const;
/**
 * A warning (the reason category, never the admin's note) or what came of your report ("action taken" or
 * "reviewed", never what). GET /me/notices lists the unseen ones; POST /me/notices/:id/seen once shown.
 */
export const userNoticeSchema = z.object({
  id: uuid,
  kind: z.enum(NOTICE_KINDS),
  category: z.enum(REPORT_REASONS).nullable(),
  outcome: z.enum(REPORT_OUTCOMES).nullable(),
  createdAt: iso,
});
export type UserNotice = z.infer<typeof userNoticeSchema>;
export const userNoticesSchema = z.object({ notices: z.array(userNoticeSchema) });

/**
 * Every refusal of a banned or suspended account: 403 { error: "account_banned", details }. The app shows a
 * plain screen with the category and "Contact support" (GET /config's support). `until`: a suspension's end.
 */
export const bannedDetailsSchema = z.object({ category: z.enum(REPORT_REASONS).nullable(), until: isoOrNull });
export type BannedDetails = z.infer<typeof bannedDetailsSchema>;
export const bannedErrorSchema = z.object({ error: z.literal("account_banned"), details: bannedDetailsSchema });

/** 403: no sending in chat, DMs, crews or corner replies until `details.until`. */
export const CHAT_TIMEOUT = "chat_timeout";
/** 422: a name, title or bio with a word we don't allow. */
export const NAME_NOT_ALLOWED = "name_not_allowed";
/** 403: a banned account's wallet takes nothing in or out (entries, top-ups, withdrawals). */
export const WALLET_FROZEN = "wallet_frozen";

// ---- the moderation queue (admin) ---------------------------------------------------------

export const MODERATION_ACTIONS = ["dismiss", "remove", "warn", "chat_timeout", "suspend", "ban"] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];
/** Actions that last a while take hours. */
export const TIMED_MODERATION_ACTIONS: readonly ModerationAction[] = ["chat_timeout", "suspend"];
export const MAX_MODERATION_HOURS = 24 * 365;

/** POST /admin/moderation/:id/actions. `category` defaults to the item's most-reported reason. */
export const moderationActionBodySchema = z.object({
  action: z.enum(MODERATION_ACTIONS),
  reason: reasonSchema,
  hours: z.number().int().min(1).max(MAX_MODERATION_HOURS).optional(),
  category: z.enum(REPORT_REASONS).optional(),
}).refine((b) => !TIMED_MODERATION_ACTIONS.includes(b.action) || b.hours !== undefined, { message: "how many hours", path: ["hours"] });
export type ModerationActionBody = z.infer<typeof moderationActionBodySchema>;

/** POST /admin/users/:id/suspend and /chat-timeout. */
export const adminTimedBodySchema = z.object({ reason: reasonSchema, hours: z.number().int().min(1).max(MAX_MODERATION_HOURS), category: z.enum(REPORT_REASONS).optional() });
/** POST /admin/users/:id/ban: the category the banned screen names (default other). */
export const adminBanBodySchema = z.object({ reason: reasonSchema, category: z.enum(REPORT_REASONS).optional() });

export const MODERATION_PAGE_DEFAULT = 30;
/** GET /admin/moderation: most-reported first, then the most recent report. `status` defaults to open. */
export const moderationQuerySchema = z.object({
  type: z.enum(MODERATION_KINDS).optional(),
  reason: z.enum(REPORT_REASONS).optional(),
  status: z.enum(MODERATION_STATUSES).default("open"),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(MODERATION_PAGE_DEFAULT),
});

/** What the thing looked like at its first report (fields by kind; anything else is omitted). */
export const moderationSnapshotSchema = z.object({
  text: z.string().nullable().optional(),
  title: z.string().optional(),
  coverEmoji: z.string().optional(),
  coverColor: z.string().optional(),
  handle: z.string().optional(),
  displayName: z.string().optional(),
  bio: z.string().nullable().optional(),
  avatarEmoji: z.string().optional(),
  threadKind: z.string().optional(),
  partyId: uuid.optional(),
  cornerId: uuid.optional(),
  postId: uuid.optional(),
  voiceNoteId: uuid.optional(),
  messageId: uuid.optional(),
  sentAt: iso.optional(),
}).passthrough();

export const moderationItemSchema = z.object({
  id: uuid,
  kind: z.enum(MODERATION_KINDS),
  refId: uuid,
  status: z.enum(MODERATION_STATUSES),
  resolution: z.string().nullable(),
  /** Who's behind it (the author, the host, the person reported). */
  subject: personSchema.nullable(),
  snapshot: moderationSnapshotSchema.nullable(),
  reportCount: z.number().int(),
  reasons: z.array(z.object({ reason: z.enum(REPORT_REASONS), count: z.number().int() })),
  /** Hidden for everyone by the automatic hold, pending review. */
  heldAt: isoOrNull,
  lastReportedAt: isoOrNull,
  createdAt: iso,
});
export type ModerationItemView = z.infer<typeof moderationItemSchema>;
export const moderationPageSchema = z.object({ items: z.array(moderationItemSchema), nextOffset: z.number().int().nullable() });

export const moderationItemDetailSchema = z.object({
  item: moderationItemSchema,
  reports: z.array(z.object({ reporter: personSchema, reason: z.enum(REPORT_REASONS), note: z.string().nullable(), at: iso })),
  /** A chat line's neighbours: five either side, as they are now (hidden ones included, flagged). */
  context: z.array(chatMessageSchema.extend({ hidden: z.boolean(), reported: z.boolean() })).nullable(),
  /** A voice note: its transcript (mock until the provider lands) beside a short-lived link to the audio. */
  voice: z.object({ transcript: z.string().nullable(), provider: z.string().nullable(), audioUrl: z.string().nullable(), expiresAt: isoOrNull }).nullable(),
  /** The subject: where they stand now, their other items, and what admins did to them. */
  subjectState: z.object({ bannedAt: isoOrNull, bannedUntil: isoOrNull, banCategory: z.string().nullable(), chatTimeoutUntil: isoOrNull }).nullable(),
  history: z.object({
    items: z.array(moderationItemSchema),
    actions: z.array(z.object({ action: z.string(), reason: z.string().nullable(), admin: personSchema, at: iso })),
  }),
});
export type ModerationItemDetail = z.infer<typeof moderationItemDetailSchema>;

/** POST /admin/moderation/:id/actions and /release → the item as it is now. */
export const moderationActionResponseSchema = z.object({
  item: moderationItemSchema,
  /** A payments admin's suspension or ban waits for a second admin (ADR 0013). */
  banRequestId: uuid.nullable(),
});

// ---- config -------------------------------------------------------------------------------

/**
 * app_config "safety". Holds: distinct reporters on one item that hide it pending review (2 is the floor); distinct
 * people reporting one person's things within the window that time them out of chat. Extra name-filter terms
 * for ops (refused, masked), on top of the built-in list.
 */
export const safetyConfigSchema = z.object({
  holdReporters: z.number().int().min(2).max(1000),
  userTimeoutReporters: z.number().int().min(3).max(1000),
  userReportWindowHours: z.number().int().min(1).max(24 * 30),
  autoTimeoutHours: z.number().int().min(1).max(24 * 30),
  blockedTerms: z.array(z.string().trim().min(2).max(60)).max(2000),
  maskedTerms: z.array(z.string().trim().min(2).max(60)).max(2000),
});
export type SafetyConfig = z.infer<typeof safetyConfigSchema>;
export const DEFAULT_SAFETY_CONFIG: SafetyConfig = {
  holdReporters: 3, userTimeoutReporters: 5, userReportWindowHours: 24, autoTimeoutHours: 72, blockedTerms: [], maskedTerms: [],
};

// ---- realtime -----------------------------------------------------------------------------

/** The base name; publish and subscribe with @contestly/queue's SAFETY_EVENTS_CHANNEL, which carries PUBSUB_PREFIX. */
export const SAFETY_EVENTS_CHANNEL = "safety:events";
/**
 * `people_hidden`: a block or mute between these people changed, so rooms reload who they hide from whom.
 * `line_hidden`: a line was held or removed; rooms tell clients to drop it (MSG.chatHidden, chatHiddenSchema in chat.ts).
 */
export type SafetyEvent =
  | { kind: "people_hidden"; userIds: string[] }
  | { kind: "line_hidden"; threadId: string; messageId: string };

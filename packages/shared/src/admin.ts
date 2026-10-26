/**
 * The admin console's contract (roadmap 5a): request bodies and every response, as the API sends them
 * and the console parses them. Everything here is behind the admin role. Sealed question content never
 * appears before its party starts, here or anywhere.
 */
import { z } from "zod";
import { personSchema } from "./person.js";
import { onboardingConfigSchema } from "./accounts.js";

const iso = z.string();
const isoOrNull = iso.nullable();
const uuid = z.string().uuid();

// ---------------------------------------------------------------- requests

/** Why: required on every destructive action (ban, unban, cancel, retire, restore, edit), kept in admin_actions. */
export const reasonSchema = z.string().trim().min(3, "say why (3+ characters)").max(500);
export const adminReasonBodySchema = z.object({ reason: reasonSchema });

export const adminUserSearchSchema = z.object({ q: z.string().trim().min(1).max(254) });
export const adminLedgerQuerySchema = z.object({ before: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });

export const ADMIN_PARTY_STATUSES = ["live", "open", "finished", "cancelled"] as const;
export const adminPartiesQuerySchema = z.object({
  /** Comma-separated; default live, open (scheduled) and finished in the last RECENT_DAYS. */
  status: z.string().optional(),
  q: z.string().trim().max(100).optional(),
  hostId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
/** "Recently finished" when no status is given: this many days. */
export const ADMIN_RECENT_PARTY_DAYS = 7;

export const ADMIN_QUESTION_VIEWS = ["pending_review", "retired", "flagged"] as const;
export const adminQuestionsQuerySchema = z.object({
  /** pending_review: voided in a room, out of retrieval until reviewed; retired; flagged: any flag at all. */
  view: z.enum(ADMIN_QUESTION_VIEWS).default("pending_review"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** An edit is re-checked (verify, safety, dedupe) before it replaces the bank question. `claim` is the fact it tests, for the verifier. */
export const adminEditQuestionSchema = z.object({
  payload: z.record(z.unknown()),
  explanation: z.string().max(500).optional(),
  claim: z.string().trim().min(3).max(500),
  reason: reasonSchema,
});

/** Tiers best first, ending at 0 points so every score pays something. */
const orderedOnboardingConfig = onboardingConfigSchema.superRefine((c, ctx) => {
  const mins = c.soloTiers.map((t) => t.minPoints);
  if (mins.some((m, i) => i > 0 && m >= mins[i - 1])) ctx.addIssue({ code: "custom", path: ["soloTiers"], message: "tiers go from the most points down" });
  if (mins[mins.length - 1] !== 0) ctx.addIssue({ code: "custom", path: ["soloTiers"], message: "the last tier starts at 0 points" });
});
export const adminOnboardingBodySchema = z.object({ config: orderedOnboardingConfig, reason: z.string().trim().max(500).optional() });

export const adminActionsQuerySchema = z.object({ targetType: z.string().optional(), targetId: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });

// ---------------------------------------------------------------- responses

export const adminSessionSchema = z.object({ admin: personSchema.extend({ email: z.string().nullable() }) });

export const adminUserRowSchema = z.object({
  id: uuid, handle: z.string(), displayName: z.string(), avatarEmoji: z.string(),
  email: z.string().nullable(), isGuest: z.boolean(), isAdmin: z.boolean(), isBrand: z.boolean(),
  bannedAt: isoOrNull, createdAt: iso,
});
export type AdminUserRow = z.infer<typeof adminUserRowSchema>;
export const adminUserSearchResponseSchema = z.object({ users: z.array(adminUserRowSchema) });

export const adminUserDetailSchema = z.object({
  user: adminUserRowSchema.extend({
    banReason: z.string().nullable(), emailVerifiedAt: isoOrNull, phoneAdded: z.boolean(),
    who: z.string().nullable(), why: z.string().nullable(), interests: z.array(z.string()), streakDays: z.number().int(),
  }),
  /** How this account is reached (provider + external id; the Firebase session uid, Google/Apple subjects). */
  identities: z.array(z.object({ provider: z.string(), externalId: z.string(), createdAt: iso })),
  wallet: z.object({ cashKobo: z.number().int(), bonusKobo: z.number().int() }),
  onboarding: z.object({ mode: z.string(), points: z.number().int(), coinsKobo: z.number().int(), claimOutcome: z.string().nullable(), playedAt: iso }).nullable(),
  partiesPlayed: z.array(z.object({ id: uuid, title: z.string(), status: z.string(), startsAt: iso, rank: z.number().int().nullable(), score: z.number().int().nullable(), prizeKobo: z.number().int().nullable() })),
  partiesHosted: z.array(z.object({ id: uuid, title: z.string(), status: z.string(), startsAt: iso, playerCount: z.number().int() })),
  climbWeeks: z.array(z.object({ week: z.string(), points: z.number().int(), bestRunStages: z.number().int() })),
  climbAwards: z.array(z.object({ id: uuid, week: z.string(), place: z.number().int(), amountKobo: z.number().int(), status: z.string(), paidAt: isoOrNull })),
});
export type AdminUserDetail = z.infer<typeof adminUserDetailSchema>;

export const adminLedgerPageSchema = z.object({
  entries: z.array(z.object({ id: uuid, kind: z.enum(["cash", "bonus"]), amountKobo: z.number().int(), type: z.string(), refType: z.string().nullable(), refId: z.string().nullable(), createdAt: iso })),
  /** Pass as ?before= for the next (older) page; null at the end. */
  nextBefore: z.string().nullable(),
});
export type AdminLedgerPage = z.infer<typeof adminLedgerPageSchema>;

export const adminPartyRowSchema = z.object({
  id: uuid, title: z.string(), status: z.string(), mode: z.string(), visibility: z.string(), startsAt: iso, endedAt: isoOrNull,
  /** Shown as host (a brand from row 8); createdBy is who clicked create. */
  host: personSchema, createdBy: personSchema,
  playerCount: z.number().int(), maxPlayers: z.number().int(),
  entryKobo: z.number().int(), funding: z.string(), prizeKind: z.string(), hostPoolKobo: z.number().int(),
  questionsStatus: z.string(),
});
export type AdminPartyRow = z.infer<typeof adminPartyRowSchema>;
export const adminPartiesResponseSchema = z.object({ parties: z.array(adminPartyRowSchema) });

export const adminActionSchema = z.object({
  id: uuid, admin: personSchema, action: z.string(), targetType: z.string(), targetId: z.string(),
  reason: z.string().nullable(), before: z.unknown(), after: z.unknown(), createdAt: iso,
});
export type AdminAction = z.infer<typeof adminActionSchema>;
export const adminActionsResponseSchema = z.object({ actions: z.array(adminActionSchema) });

export const adminPartyDetailSchema = z.object({
  party: adminPartyRowSchema.extend({ split: z.array(z.number().int()), limits: z.unknown(), questionCount: z.number().int(), questionSeconds: z.number().int(), category: z.string() }),
  players: z.array(z.object({ person: personSchema, isGuest: z.boolean(), banned: z.boolean(), joinedAt: iso, score: z.number().int().nullable(), rank: z.number().int().nullable(), prizeKobo: z.number().int().nullable() })),
  /** The set's state only: counts and statuses, never question content. */
  questions: z.object({ status: z.string(), error: z.string().nullable(), total: z.number().int(), played: z.number().int(), voided: z.number().int(), flags: z.number().int() }),
  settlement: z.object({
    /** Money this party moved, by ledger entry type (entries, refunds, prizes, rake, host fund). */
    byType: z.array(z.object({ type: z.string(), totalKobo: z.number().int(), entries: z.number().int() })),
    fulfilments: z.array(z.object({ place: z.number().int(), winner: personSchema, prizeText: z.string(), status: z.string() })),
  }),
  actions: z.array(adminActionSchema),
});
export type AdminPartyDetail = z.infer<typeof adminPartyDetailSchema>;

/** POST /admin/parties/:id/cancel: queued for the worker (refunds go through its cancel path), or already done. */
export const adminCancelResponseSchema = z.object({ status: z.enum(["cancelling", "cancelled"]), replayed: z.boolean() });

const flagTallySchema = z.record(z.number().int());
export const adminQuestionRowSchema = z.object({
  id: uuid, format: z.string(), status: z.string(), categoryTag: z.string(), origin: z.string(),
  flagCount: z.number().int(), flags: flagTallySchema, voids: z.number().int(),
  retiredReason: z.string().nullable(), retiredAt: isoOrNull,
  timesPlayed: z.number().int(), timesAnswered: z.number().int(), correctPct: z.number().nullable(),
  /** Null while a party that hasn't started holds this question: nobody sees a sealed set (or another host's drafts) before start. */
  payload: z.record(z.unknown()).nullable(),
  inUnstartedParty: z.boolean(),
  createdAt: iso,
});
export type AdminQuestionRow = z.infer<typeof adminQuestionRowSchema>;
export const adminQuestionsResponseSchema = z.object({ questions: z.array(adminQuestionRowSchema) });

export const adminQuestionDetailSchema = z.object({
  question: adminQuestionRowSchema.extend({ explanation: z.string().nullable(), difficulty: z.number(), difficultySource: z.string(), sourceChunkId: z.string().nullable() }),
  /** Every void in a room: the party, when, and the tally against the threshold. */
  voidEvents: z.array(z.object({ partyId: uuid, partyTitle: z.string(), at: iso, detail: z.unknown() })),
  /** The generation record (brief, spec, sources, scores) and who approved it: the automated gate (sealed) or a curate host. */
  generation: z.array(z.object({
    partyId: uuid, brief: z.string(), spec: z.unknown(), draft: z.unknown(),
    sourceChunk: z.object({ id: uuid, text: z.string() }).nullable(),
    verify: z.unknown(), dedupe: z.unknown(), difficulty: z.unknown(), safety: z.unknown(), outcome: z.string(),
    approvedBy: z.union([z.object({ kind: z.literal("gate") }), z.object({ kind: z.literal("host"), person: personSchema })]),
    createdAt: iso,
  })),
  reviews: z.array(z.object({ id: uuid, status: z.string(), reason: z.string(), admin: personSchema, edit: z.unknown(), verify: z.unknown(), safety: z.unknown(), dedupe: z.unknown(), createdAt: iso, judgedAt: isoOrNull })),
  actions: z.array(adminActionSchema),
});
export type AdminQuestionDetail = z.infer<typeof adminQuestionDetailSchema>;

/** POST /admin/questions/:id/edit: the review it opened; the questions service judges it. */
export const adminQuestionReviewResponseSchema = z.object({ reviewId: uuid, status: z.literal("pending") });

export const onboardingConfigVersionSchema = z.object({ version: z.number().int().nullable(), config: onboardingConfigSchema, createdAt: isoOrNull });
export type OnboardingConfigVersion = z.infer<typeof onboardingConfigVersionSchema>;

/** Valkey channel for admin events the rooms act on (a ban removes that user from any room). */
export const ADMIN_EVENTS_CHANNEL = "admin:events";
export type AdminEvent = { kind: "user_banned"; userId: string };

/** Errors the admin routes add. */
export const ACCOUNT_BANNED = "account_banned";

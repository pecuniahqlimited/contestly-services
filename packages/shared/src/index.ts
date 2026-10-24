import { z } from "zod";
import { personSchema } from "./person.js";
import { DEFAULT_PARTY_LIMITS, goodsPlaceSchema, MAX_WINNERS, partyLimitsSchema, PRIZE_KINDS, SPLIT_IDS, type SplitId } from "./stakes.js";

export * from "./stakes.js";
export * from "./person.js";
export * from "./climb.js";
export * from "./categories.js";
export * from "./accounts.js";
export * from "./admin.js";
import { CATEGORIES, type Category } from "./categories.js";
import { GUEST_HANDLE_PREFIX } from "./accounts.js";

/** All money is stored in kobo (integer). ₦200 = 20_000 kobo. */
const KOBO_PER_NAIRA = 100;
export const kobo = (naira: number) => Math.round(naira * 100);
export const naira = (k: number) => "₦" + (k / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 });

/** Bonus coins are counted in kobo like cash (1 coin = 100 kobo) but shown without the ₦. */
export const coins = (k: number) => (k / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 });

/**
 * Party round + settlement config. Admin-editable (stored under key "party" in app_config);
 * this is the default when nothing is stored. Rake, host cut and pot split are config, never hard-coded.
 */
export const partyConfigSchema = z.object({
  /** Fewer joined at start time → cancel and refund. */
  minPlayers: z.number().int().min(2),
  basePoints: z.number().int().positive(),
  maxSpeedBonus: z.number().int().min(0),
  revealSeconds: z.number().int().min(1).max(30),
  revealFloorSeconds: z.number().int().min(0).max(30),
  standingsSeconds: z.number().int().min(1).max(30),
  standingsFloorSeconds: z.number().int().min(0).max(30),
  reconnectGraceSeconds: z.number().int().min(5).max(300),
  /** Platform rake on pooled pots, in basis points. Host-funded pots are never raked. */
  rakeBps: z.number().int().min(0).max(5000),
  /** Host's cut of pooled pots, in basis points. 0 today; a planned product lever. */
  hostCutBps: z.number().int().min(0).max(5000),
  /** What hosts may choose in the Stakes scene: entry, seats, host cash prize, quick picks and splits. */
  limits: partyLimitsSchema,
});
export type PartyConfig = z.infer<typeof partyConfigSchema>;
export const DEFAULT_PARTY_CONFIG: PartyConfig = {
  minPlayers: 2,
  basePoints: 100,
  maxSpeedBonus: 100,
  revealSeconds: 6,
  revealFloorSeconds: 3,
  standingsSeconds: 7,
  standingsFloorSeconds: 2,
  reconnectGraceSeconds: 60,
  rakeBps: 1000,
  hostCutBps: 0,
  limits: DEFAULT_PARTY_LIMITS,
};

/**
 * Question-engine config. Admin-editable (stored under key "questions" in app_config);
 * this is the default when nothing is stored. Flag keys are read by flag → void → replace (step 2b).
 */
export const questionsConfigSchema = z.object({
  /** Reserve questions generated on top of every set so a void never needs a live generation call. */
  reserveCount: z.number().int().min(1).max(10),
  /** A live party with no gated set after this long is cancelled and refunded (worker watchdog). */
  generationTimeoutSeconds: z.number().int().min(10).max(600),
  /** Cosine similarity at or above which two questions count as the same fact reworded. */
  dedupeSimilarity: z.number().min(0).max(1),
  /** A question is voided when flaggers reach this share of the room… */
  flagThresholdPct: z.number().int().min(1).max(100),
  /** …but never on fewer than this many flaggers. */
  flagFloorPlayers: z.number().int().min(1),
  /** Retirement sweep: play-stat rules only apply once a question has this many graded answers. */
  retireMinAnswers: z.number().int().min(1),
  /** Retire when the average correctness falls below this (the question is broken or unfair). */
  retireBelowCorrectPct: z.number().min(0).max(100),
  /** Retire when this share of players don't answer at all (unclear, or too slow to read). */
  retireAboveSkipPct: z.number().min(0).max(100),
  /** Retire when flags across all parties reach this many, played or not. */
  retireFlagCount: z.number().int().min(1),
  /** A party's source-file chunks are deleted this many days after it finishes (kept that long for disputes and flag review). */
  sourceRetentionDays: z.number().int().min(1).max(365),
});
export type QuestionsConfig = z.infer<typeof questionsConfigSchema>;
export const DEFAULT_QUESTIONS_CONFIG: QuestionsConfig = {
  reserveCount: 2,
  generationTimeoutSeconds: 120,
  dedupeSimilarity: 0.92,
  flagThresholdPct: 30,
  flagFloorPlayers: 3,
  retireMinAnswers: 30,
  retireBelowCorrectPct: 5,
  retireAboveSkipPct: 50,
  retireFlagCount: 5,
  sourceRetentionDays: 30,
};

export * from "./safety.js";

/** Why a player flagged a question. */
export const FLAG_REASONS = ["wrong_answer", "multiple_correct", "unclear", "out_of_date", "inappropriate"] as const;
export type FlagReason = (typeof FLAG_REASONS)[number];
/** Flags name their question, so a flag that arrives late never lands on the next one. */
export const flagSchema = z.object({ questionId: z.string().uuid(), reason: z.enum(FLAG_REASONS) });

/** Bonus coins a dev-header user (AUTH_MODE=dev) starts with. Real accounts get the onboarding round's coins instead. */
export const WELCOME_BONUS_KOBO = kobo(500);

/**
 * Host source files: sent to the API as multipart (one file, field SOURCE_FILE_FIELD), read in memory
 * and never stored. Only the extracted text is kept, chunked, as the party's retrieval source.
 */
export const UPLOAD_CONTENT_TYPES = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
} as const;
export type UploadContentType = keyof typeof UPLOAD_CONTENT_TYPES;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_FILENAME_CHARS = 200;
export const SOURCE_FILE_FIELD = "file";

/** Curate mode: a host edit replaces the question's payload (validated against its format) and explanation. */
export const editDraftSchema = z.object({
  payload: z.record(z.unknown()),
  explanation: z.string().max(500).optional(),
});


/** Question formats — one source of truth for the engine, the game rules and the app. */
export const QUESTION_FORMATS = ["pick_one", "pick_all", "order", "match", "picture"] as const;
export type QuestionFormat = (typeof QUESTION_FORMATS)[number];

export const DIFFICULTIES = ["easy", "mixed", "hard", "brutal"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/** Width of bank-question and file-chunk embeddings (text-embedding-3-small's size, so a real embedder needs no migration). */
export const EMBEDDING_DIM = 1536;

/**
 * There is no category picker: the engine infers the category tag from the host's brief, and this
 * keyword map is the v1 inference, shared by the API (at create) and the question engine (in the spec).
 * A single clear winner takes the tag; no hit at all, or a tie across topics (a mixed brief), lands
 * on General knowledge.
 */
const CATEGORY_HINTS: Partial<Record<Category, string[]>> = {
  Afrobeats: ["afrobeat", "music", "song", "artist", "burna", "wizkid", "davido", "tems"],
  Football: ["football", "soccer", "super eagles", "premier league", "world cup", "afcon"],
  Nollywood: ["nollywood", "movie", "film", "actor", "actress"],
  History: ["history", "independence", "colonial", "civil war", "president"],
  Science: ["science", "biology", "chemistry", "physics", "space"],
  Tech: ["tech", "startup", "coding", "software", "internet"],
  Fashion: ["fashion", "style", "designer", "ankara"],
  Food: ["food", "dish", "recipe", "jollof", "soup", "cuisine"],
  Geography: ["geography", "capital", "river", "state", "cities", "map"],
  "Brain teasers": ["puzzle", "riddle", "brain teaser", "logic"],
  "Reality TV": ["reality tv", "bbnaija", "big brother"],
  Maths: ["maths", "math", "number", "algebra", "arithmetic"],
  "Hip hop": ["hip hop", "rap", "rapper"],
};
export function inferCategory(brief: string): Category {
  const text = brief.toLowerCase();
  const scored = CATEGORIES.map((cat) => ({ cat, hits: (CATEGORY_HINTS[cat] ?? []).filter((h) => text.includes(h)).length }));
  const top = Math.max(...scored.map((s) => s.hits));
  const leaders = scored.filter((s) => s.hits === top);
  return top > 0 && leaders.length === 1 ? leaders[0].cat : "General knowledge";
}

export const handleSchema = z.string().min(3).max(20).regex(/^[a-z0-9_.]+$/, "lowercase letters, numbers, _ and . only")
  .refine((h) => !h.startsWith(GUEST_HANDLE_PREFIX), "that handle is reserved");

export const upsertMeSchema = z.object({
  displayName: z.string().min(1).max(40),
  handle: handleSchema,
  // Left out = unchanged (the lanes picked in onboarding survive the Name and face screen).
  avatarEmoji: z.string().min(1).max(8).optional(),
  bio: z.string().max(160).optional(),
  interests: z.array(z.enum(CATEGORIES)).max(10).optional(),
});

/** A new party starts this long after it's created unless the host picks a time. */
export const DEFAULT_START_MINUTES = 10;
/** The earliest and latest a host can set a party to start. */
export const MIN_START_LEAD_MINUTES = 1;
export const MAX_START_LEAD_DAYS = 7;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
export const startWindowHolds = (startsAt: Date, now = Date.now()) =>
  startsAt.getTime() >= now + MIN_START_LEAD_MINUTES * MINUTE_MS && startsAt.getTime() <= now + MAX_START_LEAD_DAYS * DAY_MS;
/** When a party created now starts. */
export const startsAtFor = (input: { startsAt?: string }, now = Date.now()) => (input.startsAt ? new Date(input.startsAt) : new Date(now + DEFAULT_START_MINUTES * MINUTE_MS));

export const createPartySchema = z.object({
  title: z.string().min(3).max(60),
  /** The source for question generation: a topic, a vibe, a list of facts — anything. File upload lands in step 2b. */
  brief: z.string().min(3).max(2000),
  /** Omitted → inferred from the brief; the engine may refine it again when it builds the spec. */
  category: z.enum(CATEGORIES).optional(),
  difficulty: z.enum(DIFFICULTIES).default("mixed"),
  formats: z.array(z.enum(QUESTION_FORMATS)).min(1).max(QUESTION_FORMATS.length).default([...QUESTION_FORMATS]),
  /** sealed: generated at creation, the host plays. curate: the host reviews drafts and can't play. */
  mode: z.enum(["sealed", "curate"]).default("sealed"),
  /**
   * The host attaches source files right after creating (they need the party's id). A sealed set then
   * waits for them: it's made once every file is read, instead of straight away from the brief alone.
   */
  awaitFiles: z.boolean().default(false),
  /**
   * Stakes. The ranges (entry, seats, host prize) and the allowed splits are the admin's party limits, checked by
   * checkStakes() on the server; this schema only holds the shape. Amounts are whole naira, in kobo.
   */
  entryKobo: z.number().int().min(0).multipleOf(KOBO_PER_NAIRA),
  maxPlayers: z.number().int().min(2),
  funding: z.enum(["pooled", "host"]),
  /** The host's cash prize, held from their wallet at creation. */
  hostPoolKobo: z.number().int().min(0).multipleOf(KOBO_PER_NAIRA).default(0),
  /** Product and experience (goods) are a fulfilment record per winning place, never a ledger entry; verified brands only. */
  prizeKind: z.enum(PRIZE_KINDS).default("cash"),
  /** Goods only: the prize for each winning place, best first, one per winner of the split. */
  places: z.array(goodsPlaceSchema).max(MAX_WINNERS).default([]),
  /** How the prize is shared by place: the pooled pot, the host's cash prize, or how many places win goods. */
  split: z.enum(SPLIT_IDS as [SplitId, ...SplitId[]]),
  questionCount: z.number().int().min(3).max(30).default(5),
  secondsPerQuestion: z.number().int().min(5).max(60).default(15),
  visibility: z.enum(["public", "private"]).default("public"),
  coverColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#7B5CFF"),
  coverEmoji: z.string().max(8).default("🎉"),
  /** When the first question drops. Omitted → DEFAULT_START_MINUTES from now. */
  startsAt: z.string().datetime({ offset: true }).optional(),
  inviteUserIds: z.array(z.string().uuid()).max(20).default([]),
}).refine((p) => p.funding === "pooled" ? p.prizeKind === "cash" && p.hostPoolKobo === 0 : p.entryKobo === 0, { message: "pooled parties pay cash from the entries; host-funded parties are free to enter" })
  .refine((p) => p.prizeKind === "cash" ? p.places.length === 0 : p.hostPoolKobo === 0, { message: "a cash prize has no goods places, and goods carry no cash prize" })
  .refine((p) => p.startsAt === undefined || startWindowHolds(new Date(p.startsAt)), { message: `a party starts between ${MIN_START_LEAD_MINUTES} minute and ${MAX_START_LEAD_DAYS} days from now`, path: ["startsAt"] });

/** Chat is room-scoped in Colyseus; the party comes from the room, not the message. */
export const chatSendSchema = z.object({
  text: z.string().min(1).max(280).optional(),
  sticker: z.string().min(1).max(8).optional(),
}).refine((m) => !!m.text !== !!m.sticker, "send either text or a sticker");

/** Colyseus room + message names — one source of truth for client and realtime service. */
export const PARTY_ROOM = "party";
export const MSG = {
  // client → server
  /** Send on every change of selection; the last one received before the clock ends is the answer. */
  answer: "answer",
  skip: "skip",
  chat: "chat",
  flag: "flag",
  // server → client
  phase: "phase",
  question: "question",
  reveal: "reveal",
  standings: "standings",
  finalStandings: "final",
  chatMessage: "chat:message",
  presence: "presence",
  /** A question was voided by player flags: { questionId, idx, replacementAdded, total }. */
  questionVoided: "question:voided",
  /** The party's question set changed state (generating / ready / failed). Never carries content. */
  questionsStatus: "questions:status",
  error: "error",
} as const;

/** Realtime heartbeats this Valkey key while a party's round is running; the worker's watchdog refunds if it goes stale. */
export const partyRoomKey = (partyId: string) => `party:room:${partyId}`;

/** Redis pub/sub channel the worker publishes party lifecycle events on; realtime fans them out. */
export const PARTY_EVENTS_CHANNEL = "party:events";

/** BullMQ queue names and job payloads. */
export const QUEUES = { notify: "notify", party: "party", questions: "questions", climb: "climb", housekeeping: "housekeeping" } as const;
/**
 * The Climb's scheduled jobs, both repeatable on the Lagos clock. `day_start`: pin this week's prize
 * version and snapshot its Everyone board for ▲/▼ since yesterday. `week_close`: rank every finished week that hasn't been
 * closed and write its pending weekly awards.
 */
export type ClimbJob = { kind: "day_start" } | { kind: "week_close" };
export type NotifyFollowersJob = { kind: "party_created"; partyId: string; hostId: string };
export type NotifyInviteJob = { kind: "party_invite"; partyId: string; fromUserId: string; toUserIds: string[] };
/** The host's question set couldn't be built; they can retry or edit the brief. */
export type NotifyQuestionsFailedJob = { kind: "questions_failed"; partyId: string; hostId: string; reason: string };
export type NotifyJob = NotifyFollowersJob | NotifyInviteJob | NotifyQuestionsFailedJob;
/**
 * `cancel_generation_failed`: a party that is already live has no playable set (its start-time
 * re-check couldn't be completed); the worker refunds (money only moves in the worker). Before
 * start, a failed generation never cancels: the host is notified and can retry.
 */
export type PartyJob =
  | { kind: "start" | "cancel_if_empty" | "settle" | "watchdog" | "cancel_generation_failed"; partyId: string }
  /** An admin cancelled the party: refund and cancel through the same path as every other cancel. */
  | { kind: "admin_cancel"; partyId: string; reason: string }
  /** Every minute: starts or cancels any open party past its startsAt whose start job was lost. */
  | { kind: "sweep" };
/** Daily clean-up in the worker: `purge_email_sends` deletes the email send log past its retention. */
export type HousekeepingJob = { kind: "purge_email_sends" };
/**
 * Questions-service jobs (ADR 0002). `generate_set` builds and seals the set when the party is
 * created (curate: when the host asks for drafts) and publishes the set's state on
 * PARTY_EVENTS_CHANNEL; `reseal_for_roster` runs at start only if someone seated has already seen
 * a question in the set, and swaps just those; `record_play` folds a finished party's answer
 * stats back into the bank.
 */
export type QuestionsJob =
  | { kind: "generate_set"; partyId: string }
  | { kind: "reseal_for_roster"; partyId: string }
  | { kind: "record_play"; partyId: string }
  /** Curate mode: replace one draft with a freshly generated, gated question. */
  | { kind: "regenerate_one"; partyId: string; partyQuestionId: string; requestedBy: string }
  /** The API has read a source file (or failed to): embed its chunks, then build a set that was waiting for it. */
  | { kind: "file_read"; fileId: string }
  /** A question was voided by flags in a room: take it out of retrieval pending review. */
  | { kind: "question_voided"; partyQuestionId: string; flags: number }
  /** An admin edited a bank question: re-check it (verify, safety, dedupe) and apply it only if it passes. */
  | { kind: "review_edit"; reviewId: string }
  /** Repeatable: retire flagged and underperforming bank questions. */
  | { kind: "retire_sweep" }
  /** Repeatable: delete the source chunks of parties that finished more than sourceRetentionDays ago. */
  | { kind: "source_sweep" };

/** Response shapes. The UI's api-client parses every response with these. */
export const healthResponseSchema = z.object({ ok: z.boolean(), service: z.string(), time: z.string() });
export const walletSchema = z.object({ cashKobo: z.number().int(), bonusKobo: z.number().int() });
export const publicUserSchema = z.object({
  id: z.string().uuid(),
  handle: z.string(),
  displayName: z.string(),
  avatarEmoji: z.string(),
  bio: z.string().nullable(),
  interests: z.array(z.string()),
  isBrand: z.boolean(),
  isVerified: z.boolean(),
  streakDays: z.number().int(),
});
export const meResponseSchema = publicUserSchema.extend({ wallet: walletSchema });
/** GET /me: the session's own account, guests included (their wallet is empty: coins arrive at sign-up). */
export const sessionMeResponseSchema = meResponseSchema.extend({
  isGuest: z.boolean(),
  isAdmin: z.boolean(),
  email: z.string().nullable(),
  /** A verified number is on the account (it's never shown). */
  phoneAdded: z.boolean(),
  canWithdraw: z.boolean(),
});
export type SessionMe = z.infer<typeof sessionMeResponseSchema>;
/** POST /me/guest: the guest's name for a free party. */
export const guestResponseSchema = publicUserSchema.extend({ isGuest: z.literal(true) });


/** How the viewer stands with someone: follows them (with party alerts on or off), is followed back. All false signed out. */
export const viewerFollowSchema = z.object({ following: z.boolean(), notify: z.boolean(), followsYou: z.boolean() });

/** POST/DELETE/PATCH /users/:id/follow → the viewer's follow state for that person. */
export const followStateSchema = z.object({ following: z.boolean(), notify: z.boolean() });
/** PATCH /users/:id/follow: party alerts for this one follow. */
export const followAlertSchema = z.object({ notify: z.boolean() });

/** GET /users/:handle/followers and /following: people the viewer follows come first. */
export const followListEntrySchema = personSchema.extend({ viewer: viewerFollowSchema });
export const followListResponseSchema = z.array(followListEntrySchema);

/** POST /me/contacts/match: people among the viewer's contacts who added a number. */
export const contactsMatchResponseSchema = z.object({ matches: z.array(followListEntrySchema) });

/** GET /me/played-with: people from finished parties I played, whom I don't follow yet. Most parties together first. */
export const playedWithEntrySchema = personSchema.extend({ partiesTogether: z.number().int(), lastPlayedAt: z.string().datetime() });
export const playedWithResponseSchema = z.array(playedWithEntrySchema);

/** GET /users/:handle: a profile with counts, play stats, the viewer's follow state and open parties hosted. */
export const userStatsSchema = z.object({
  parties: z.number().int(),
  wins: z.number().int(),
  /** Best finishing rank in any finished party; null until one has been played. No prize amounts: profiles lead with play. */
  bestRank: z.number().int().nullable(),
});

/** GET /wallet: balances plus the latest ledger entries, newest first. */
export const ledgerEntrySchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["cash", "bonus"]),
  amountKobo: z.number().int(),
  /** party_entry, party_prize, party_refund, party_fund, topup, welcome_bonus, … */
  type: z.string(),
  refType: z.string().nullable(),
  refId: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export const walletResponseSchema = walletSchema.extend({ history: z.array(ledgerEntrySchema) });

/** A party's public host, resolved only through publicHost() (ADR 0001). Step 4 adds kind "brand". */
export const publicHostSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["user", "brand"]),
  handle: z.string(),
  displayName: z.string(),
  avatarEmoji: z.string(),
  isBrand: z.boolean(),
  isVerified: z.boolean(),
});

export const PARTY_STATUSES = ["open", "live", "finished", "cancelled"] as const;
export type PartyStatus = (typeof PARTY_STATUSES)[number];

/** The parties row as the API returns it. */
export const partyRowSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  category: z.string(),
  difficulty: z.enum(DIFFICULTIES),
  formats: z.array(z.enum(QUESTION_FORMATS)),
  mode: z.enum(["sealed", "curate"]),
  entryKobo: z.number().int(),
  maxPlayers: z.number().int(),
  questionCount: z.number().int(),
  questionSeconds: z.number().int(),
  funding: z.enum(["pooled", "host"]),
  hostPoolKobo: z.number().int(),
  prizeKind: z.enum(PRIZE_KINDS),
  split: z.array(z.number().int()),
  /** The split's id; null for a party made before splits were a fixed list. */
  splitId: z.enum(SPLIT_IDS as [SplitId, ...SplitId[]]).nullable(),
  visibility: z.enum(["public", "private"]),
  coverColor: z.string(),
  coverEmoji: z.string(),
  status: z.enum(PARTY_STATUSES),
  startsAt: z.string().datetime(),
});

/** Faces on a party card. */
export const MAX_PARTY_FACES = 4;
/** People the viewer follows, named on a card ("Ada and 2 you follow are in"). */
export const MAX_FRIENDS_NAMED = 2;

/**
 * Who's in a party, as a card shows it: the first faces (the host's, if they play, then by join time),
 * and the people the viewer follows who are in it, the first few named, with how many in all.
 */
export const partyPeopleSchema = z.object({
  faces: z.array(personSchema),
  friendsIn: z.object({ people: z.array(personSchema), count: z.number().int() }),
});

/**
 * What one winning place gets, worked out by the server. Cash (pooled or the host's): `amountKobo`, for a pooled pot
 * its share right now after the rake, growing with every seat. Goods: `text` and, if the host gave one, `valueKobo`.
 */
export const placePrizeSchema = z.object({
  place: z.number().int().positive(),
  amountKobo: z.number().int().nullable(),
  text: z.string().nullable(),
  valueKobo: z.number().int().nullable(),
});
export type PlacePrize = z.infer<typeof placePrizeSchema>;

/** GET /parties: one card in Discover. `potKobo` is the pooled pot before the rake, or the host's cash prize. */
export const partySummarySchema = partyRowSchema.extend({
  host: publicHostSchema,
  playerCount: z.number().int(),
  potKobo: z.number().int(),
  places: z.array(placePrizeSchema),
}).merge(partyPeopleSchema);
export const partiesResponseSchema = z.array(partySummarySchema);

/**
 * Where the party's question set is: not_started (a curate party before the host asks for drafts),
 * generating, ready, or failed (the host can retry or edit the brief; the party stays open).
 */
export const QUESTIONS_STATUSES = ["not_started", "generating", "ready", "failed"] as const;
export type QuestionsStatus = (typeof QUESTIONS_STATUSES)[number];

/** The question engine's pipeline, in order, as the Forge names it while the deck is made. */
export const FORGE_STAGES = ["reading", "drafting", "checking", "dedupe", "balance"] as const;
export type ForgeStage = (typeof FORGE_STAGES)[number];
/**
 * How far the deck is: the stage the engine is at, and the cards made so far (questions that passed
 * every check, of `total`) with each card's format. Nothing else about any question, so it's safe to
 * show everyone, sealed or not. The last report of a ready set holds the play order's formats.
 */
export const forgeProgressSchema = z.object({
  stage: z.enum(FORGE_STAGES),
  done: z.number().int().min(0),
  total: z.number().int().min(0),
  formats: z.array(z.enum(QUESTION_FORMATS)),
});
export type ForgeProgress = z.infer<typeof forgeProgressSchema>;

/**
 * Always disclosed in the lobby and the game: AI-generated, sealed or host-reviewed, and the set's
 * state. Never any content: `error` is a plain reason for the host ("make the brief broader"), not
 * anything from the questions; `forge` is stages and formats only.
 */
export const questionDisclosureSchema = z.object({
  aiGenerated: z.boolean(),
  review: z.enum(["sealed", "host_reviewed"]),
  status: z.enum(QUESTIONS_STATUSES),
  error: z.string().nullable(),
  /** While the set is being made and once it's ready; null before, and when it failed. */
  forge: forgeProgressSchema.nullable(),
});

/** The disclosure for a party row. One builder for the API and the room. */
export const questionDisclosure = (p: { mode: "sealed" | "curate"; questionsStatus: QuestionsStatus; questionsError: string | null; forgeProgress: ForgeProgress | null }): z.infer<typeof questionDisclosureSchema> => ({
  aiGenerated: true,
  review: p.mode === "curate" ? "host_reviewed" : "sealed",
  status: p.questionsStatus,
  error: p.questionsStatus === "failed" ? p.questionsError : null,
  forge: p.questionsStatus === "generating" || p.questionsStatus === "ready" ? p.forgeProgress : null,
});

/** POST /parties/:id/questions/retry → 202: the set is being made again. */
export const retryQuestionsResponseSchema = z.object({ status: z.literal("generating") });

/** POST /parties/:id/questions/retry: try a failed set again, optionally with a changed brief. */
export const retryQuestionsSchema = z.object({
  brief: z.string().min(3).max(2000).optional(),
  difficulty: z.enum(DIFFICULTIES).optional(),
  formats: z.array(z.enum(QUESTION_FORMATS)).min(1).max(QUESTION_FORMATS.length).optional(),
});

export const partyPlayerSchema = z.object({
  id: z.string().uuid(),
  handle: z.string(),
  displayName: z.string(),
  avatarEmoji: z.string(),
  score: z.number().int().nullable(),
  rank: z.number().int().nullable(),
  prizeKobo: z.number().int().nullable(),
});

/** "@ada.o" in chat: a handle token, never ending in "." so "@kemz." is kemz at the end of a sentence. */
const MENTION_TOKEN = /(@[A-Za-z0-9_.]*[A-Za-z0-9_])/;
/** A chat line split around its @handle tokens: the odd indices are the tokens, "@" included. */
export const splitMentions = (text: string) => text.split(MENTION_TOKEN);
/** The handles a chat line mentions, lowercased and once each. The server keeps only those that are real users. */
export const mentionedHandles = (text: string) => [...new Set(splitMentions(text).filter((_, i) => i % 2).map((t) => t.slice(1).toLowerCase()))];

/** A persisted party chat line. System lines have no author. `mentions`: the real users it @-mentions, resolved when sent. */
export const chatMessageSchema = z.object({
  id: z.string().uuid(),
  partyId: z.string().uuid(),
  userId: z.string().uuid().nullable(),
  text: z.string().nullable(),
  sticker: z.string().nullable(),
  system: z.boolean(),
  mentions: z.array(z.string()),
  createdAt: z.string().datetime(),
  handle: z.string().nullable(),
  avatarEmoji: z.string().nullable(),
});

/** The app's URL scheme (app.json "scheme"): contestly://party/<id> opens party detail. */
export const APP_LINK_SCHEME = "contestly";
/** A party's links to share: the app's own scheme, and a web link that opens the app or the store. */
export const partyLinksSchema = z.object({ app: z.string(), web: z.string().url() });

/** GET /parties/:id: the lobby before the room is joined. `joined` is the viewer's seat. */
export const partyDetailSchema = partySummarySchema.extend({
  invite: partyLinksSchema,
  /** Who invited the viewer, while the invite is pending. */
  invitedBy: personSchema.nullable(),
  /** The host's own brief, so their team can fix a failed set; null for everyone else (it can give the answers away). */
  brief: z.string().nullable(),
  questions: questionDisclosureSchema,
  players: z.array(partyPlayerSchema),
  joined: z.boolean(),
  chat: z.array(chatMessageSchema),
});

/** POST /parties/:id/join. A replayed join (already seated) charges nothing and carries no `paid`. */
export const joinPartyResponseSchema = z.object({
  joined: z.literal(true),
  replayed: z.boolean().optional(),
  paid: z.object({ fromBonus: z.number().int(), fromCash: z.number().int() }).optional(),
  potKobo: z.number().int().optional(),
});

/** In finished parties both played: how often each placed above the other. Ties count for neither. */
export const headToHeadSchema = z.object({ me: z.number().int(), them: z.number().int(), played: z.number().int() });

/** One of someone's finished parties on their profile, with where they placed. */
export const recentPartySchema = partyRowSchema.pick({ id: true, title: true, category: true, coverColor: true, coverEmoji: true, startsAt: true }).extend({
  rank: z.number().int().nullable(),
  playerCount: z.number().int(),
});
/** Finished parties on a profile. Only public ones, and private ones the viewer was also in. */
export const MAX_PROFILE_RECENT_PARTIES = 5;

export const userProfileSchema = publicUserSchema.extend({
  followers: z.number().int(),
  following: z.number().int(),
  stats: userStatsSchema,
  viewer: viewerFollowSchema,
  /** Null signed out and on your own profile. */
  headToHead: headToHeadSchema.nullable(),
  recent: z.array(recentPartySchema),
  hosting: z.array(partyRowSchema),
});

/** Each party in GET /me/parties: why it's mine, its last chat line, who invited me, and where I placed. */
export const MY_PARTY_ROLES = ["hosting", "playing", "invited"] as const;
export const lastChatLineSchema = z.object({
  /** Null for system lines ("Ada joined"). */
  author: personSchema.pick({ handle: true, displayName: true }).nullable(),
  text: z.string().nullable(),
  sticker: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export const myPartySchema = partySummarySchema.extend({
  role: z.enum(MY_PARTY_ROLES),
  /** To invite people from Home without opening the party. */
  invite: partyLinksSchema,
  lastLine: lastChatLineSchema.nullable(),
  invitedBy: personSchema.nullable(),
  myRank: z.number().int().nullable(),
});
/**
 * GET /me/parties. invited: pending invites to open parties, soonest first. live, then upcoming
 * (soonest first), then recent: finished or cancelled in the last MY_RECENT_DAYS, newest first.
 */
export const MY_RECENT_DAYS = 14;
export const MY_RECENT_LIMIT = 20;
export const myPartiesResponseSchema = z.object({
  invited: z.array(myPartySchema),
  live: z.array(myPartySchema),
  upcoming: z.array(myPartySchema),
  recent: z.array(myPartySchema),
});

/** Invites per party, from everyone in it together. */
export const MAX_INVITES_PER_PARTY = 50;
/** POST /parties/:id/invites: only people the inviter follows, is followed by, or has played with. */
export const inviteToPartySchema = z.object({ userIds: z.array(z.string().uuid()).min(1).max(MAX_INVITES_PER_PARTY) });
/** → 201: how many were newly invited (already invited, already in, or yourself are skipped). */
export const inviteToPartyResponseSchema = z.object({ invited: z.number().int() });
/** POST /parties/:id/invite/dismiss → the viewer's invite to this party, dismissed. */
export const dismissInviteResponseSchema = z.object({ status: z.literal("dismissed") });

/** POST /parties → 201: the new party, its question set's state, and the host's own seat (sealed) counted. */
export const createPartyResponseSchema = partyRowSchema.extend({
  questions: questionDisclosureSchema,
  playerCount: z.number().int(),
  potKobo: z.number().int(),
  places: z.array(placePrizeSchema),
});

/** GET /parties/limits: what the signed-in host may choose now, the rake the pot preview takes, and whether they may offer goods. */
export const partyLimitsResponseSchema = z.object({
  limits: partyLimitsSchema,
  rakeBps: z.number().int(),
  hostCutBps: z.number().int(),
  canOfferGoods: z.boolean(),
});
export type PartyLimitsResponse = z.infer<typeof partyLimitsResponseSchema>;
/** GET and PUT /admin/party-limits: the limits as stored, quick picks outside their range included. */
export const adminPartyLimitsSchema = z.object({ limits: partyLimitsSchema });

/** parsing: the text is out and chunked, the questions service is indexing it. parsed: ready to make questions from. */
export const PARTY_FILE_STATUSES = ["parsing", "parsed", "failed"] as const;
export type PartyFileStatus = (typeof PARTY_FILE_STATUSES)[number];
/**
 * A party's source file, as metadata only (the bytes were never kept). PUT /parties/:id/files → 201 with
 * one of these, replacing any file before it; GET /parties/:id/files (host's team) lists them. `error` is
 * worded for the host.
 */
export const partyFileSchema = z.object({
  id: z.string().uuid(),
  filename: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  status: z.enum(PARTY_FILE_STATUSES),
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export const partyFilesResponseSchema = z.array(partyFileSchema);

/** POST /parties/:id/drafts → 202: the curate set is being drafted. */
export const requestDraftsResponseSchema = z.object({ status: z.literal("generating") });
/** POST /parties/:id/drafts/:qid/regenerate → 202: a fresh draft replaces this one when it passes the gate. */
export const regenerateDraftResponseSchema = z.object({ status: z.literal("regenerating") });

/** The `error` code in a refused request's body, e.g. insufficient_funds (402), party_full (409). */
export const apiErrorBodySchema = z.object({ error: z.string() });

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type Wallet = z.infer<typeof walletSchema>;
export type PublicUser = z.infer<typeof publicUserSchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;
export type WalletResponse = z.infer<typeof walletResponseSchema>;
export type PublicHost = z.infer<typeof publicHostSchema>;
export type PartySummary = z.infer<typeof partySummarySchema>;
export type PartyDetail = z.infer<typeof partyDetailSchema>;
export type PartyPlayer = z.infer<typeof partyPlayerSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type QuestionDisclosure = z.infer<typeof questionDisclosureSchema>;
export type JoinPartyResponse = z.infer<typeof joinPartyResponseSchema>;
export type UserProfile = z.infer<typeof userProfileSchema>;
export type ViewerFollow = z.infer<typeof viewerFollowSchema>;
export type FollowState = z.infer<typeof followStateSchema>;
export type FollowListEntry = z.infer<typeof followListEntrySchema>;
export type PlayedWithEntry = z.infer<typeof playedWithEntrySchema>;
export type PartyPeople = z.infer<typeof partyPeopleSchema>;
export type PartyLinks = z.infer<typeof partyLinksSchema>;
export type HeadToHead = z.infer<typeof headToHeadSchema>;
export type RecentParty = z.infer<typeof recentPartySchema>;
export type MyPartyRole = (typeof MY_PARTY_ROLES)[number];
export type LastChatLine = z.infer<typeof lastChatLineSchema>;
export type MyParty = z.infer<typeof myPartySchema>;
export type MyPartiesResponse = z.infer<typeof myPartiesResponseSchema>;
export type InviteToPartyInput = z.infer<typeof inviteToPartySchema>;
export type CreatePartyInput = z.infer<typeof createPartySchema>;
export type UpsertMeInput = z.infer<typeof upsertMeSchema>;
export type CreatePartyResponse = z.infer<typeof createPartyResponseSchema>;
export type PartyFile = z.infer<typeof partyFileSchema>;
export type DraftQuestion = z.infer<typeof draftQuestionSchema>;
export type DraftsResponse = z.infer<typeof draftsResponseSchema>;

/**
 * The party room protocol: every message the room sends, as the app parses it. The room builds these
 * from packages/game (publicView, Reveal, StandingRow); the app never trusts an unparsed message.
 */
const roomOptions = z.array(z.string()).min(2).max(6);
/** What each format shows while its question is open: the engine's publicView, answers stripped. */
export const questionViewSchemas = {
  pick_one: z.object({ question: z.string(), options: roomOptions }),
  pick_all: z.object({ question: z.string(), options: roomOptions }),
  order: z.object({ question: z.string(), items: z.array(z.string()).min(2).max(6) }),
  match: z.object({ question: z.string(), left: z.array(z.string()).min(2).max(6), right: z.array(z.string()).min(2).max(6) }),
  picture: z.object({ question: z.string(), imageUrl: z.string(), imageAlt: z.string(), options: roomOptions }),
} as const satisfies Record<QuestionFormat, z.ZodTypeAny>;

/** A player's answer, per format. One source for the engine's graders and the app's answer UIs. */
export const answerSchemas = {
  pick_one: z.object({ index: z.number().int().min(0).max(5) }),
  pick_all: z.object({ indexes: z.array(z.number().int().min(0).max(5)).max(6) }),
  order: z.object({ order: z.array(z.number().int().min(0).max(5)).max(6) }),
  match: z.object({ pairs: z.array(z.number().int().min(0).max(5)).max(6) }),
  picture: z.object({ index: z.number().int().min(0).max(5) }),
} as const satisfies Record<QuestionFormat, z.ZodTypeAny>;
export type AnswerFor<F extends QuestionFormat> = z.infer<(typeof answerSchemas)[F]>;

const payloadOptions = z.array(z.string().min(1)).min(2).max(6);
const payloadIndexes = z.array(z.number().int().min(0)).min(1);
/** `xs` uses each of 0..n-1 exactly once. */
const isPermutation = (xs: number[], n: number) => xs.length === n && new Set(xs).size === n && xs.every((i) => i < n);

/**
 * A question's full payload, answers included: what the engine stores and grades against, and what a
 * curate host's team reviews. Answer keys must point inside the question, so neither a generator slip
 * nor a host edit can make a question unanswerable. Never sent to a player before the question closes.
 */
export const questionPayloadSchemas = {
  pick_one: z.object({
    question: z.string().min(1),
    options: payloadOptions,
    correctIndex: z.number().int().min(0),
  }).refine((p) => p.correctIndex < p.options.length, "correctIndex must point at an option"),
  pick_all: z.object({
    question: z.string().min(1),
    options: payloadOptions,
    correctIndexes: payloadIndexes,
  }).refine((p) => new Set(p.correctIndexes).size === p.correctIndexes.length && p.correctIndexes.every((i) => i < p.options.length), "correctIndexes must be distinct options"),
  /** `items` is the display order (pre-shuffled by the author/generator); `correctOrder` lists item indexes in the right sequence. */
  order: z.object({
    question: z.string().min(1),
    items: z.array(z.string().min(1)).min(3).max(6),
    correctOrder: payloadIndexes,
  }).refine((p) => isPermutation(p.correctOrder, p.items.length), "correctOrder must use every item exactly once"),
  /** `right` is pre-shuffled; `pairs[i]` is the index into `right` that matches `left[i]`. */
  match: z.object({
    question: z.string().min(1),
    left: z.array(z.string().min(1)).min(2).max(6),
    right: z.array(z.string().min(1)).min(2).max(6),
    pairs: payloadIndexes,
  }).refine((p) => p.left.length === p.right.length && isPermutation(p.pairs, p.right.length), "pairs must match every left item to a distinct right item"),
  /** An image with a caption, then pick one. Images come from a licensed/generated pool with alt text. */
  picture: z.object({
    question: z.string().min(1),
    imageUrl: z.string().min(1),
    imageAlt: z.string().min(1),
    options: payloadOptions,
    correctIndex: z.number().int().min(0),
  }).refine((p) => p.correctIndex < p.options.length, "correctIndex must point at an option"),
} as const satisfies Record<QuestionFormat, z.ZodTypeAny>;
export type QuestionPayload<F extends QuestionFormat = QuestionFormat> = z.infer<(typeof questionPayloadSchemas)[F]>;

const openQuestion = {
  /** Echoed when flagging, so a late flag never lands on the next question. */
  questionId: z.string().uuid(),
  idx: z.number().int().min(0),
  total: z.number().int().min(1),
  seconds: z.number().int().positive(),
  /** Server epoch ms. The countdown is display only; the server closes the question. */
  openedAt: z.number(),
  closesAt: z.number(),
};
export const roomQuestionSchema = z.discriminatedUnion("format", [
  z.object({ ...openQuestion, format: z.literal("pick_one"), view: questionViewSchemas.pick_one }),
  z.object({ ...openQuestion, format: z.literal("pick_all"), view: questionViewSchemas.pick_all }),
  z.object({ ...openQuestion, format: z.literal("order"), view: questionViewSchemas.order }),
  z.object({ ...openQuestion, format: z.literal("match"), view: questionViewSchemas.match }),
  z.object({ ...openQuestion, format: z.literal("picture"), view: questionViewSchemas.picture }),
]);

/** The right answer, sent only once the question has closed. Its shape follows the question's format. */
export const revealAnswerSchema = z.union([
  z.object({ correctIndex: z.number().int() }),
  z.object({ correctIndexes: z.array(z.number().int()) }),
  z.object({ correctOrder: z.array(z.number().int()) }),
  z.object({ pairs: z.array(z.number().int()) }),
]);
export const roomVerdictSchema = z.object({
  userId: z.string().uuid(),
  /** 0..1; partial credit for pick-all, order and match. */
  correctness: z.number().min(0).max(1),
  points: z.number().int(),
  /** null: no answer. */
  answeredMs: z.number().int().nullable(),
  /** What the player submitted ("Your pick"); null when they didn't answer. */
  answer: z.unknown().nullable(),
});
export const roomRevealSchema = z.object({
  idx: z.number().int(),
  questionId: z.string().uuid(),
  voided: z.boolean(),
  answer: revealAnswerSchema,
  explanation: z.string().optional(),
  /** Per-option counts for option formats; null for order and match, and for a voided question. */
  distribution: z.array(z.number().int()).nullable(),
  answered: z.number().int(),
  noAnswer: z.number().int(),
  verdicts: z.array(roomVerdictSchema),
  endsAt: z.number(),
  skippableAt: z.number(),
});

export const standingRowSchema = z.object({
  userId: z.string().uuid(),
  score: z.number().int(),
  timeMs: z.number().int(),
  rank: z.number().int().min(1),
  /** From the server's previous standings; null on the first. The client never infers it. */
  prevRank: z.number().int().min(1).nullable(),
});
export const roomStandingsSchema = z.object({
  rows: z.array(standingRowSchema),
  endsAt: z.number(),
  skippableAt: z.number(),
  chatOpen: z.boolean(),
  lastQuestion: z.boolean(),
});
export const roomFinalSchema = z.object({ rows: z.array(standingRowSchema) });

export const ROOM_PHASES = ["lobby", "generating", "question", "reveal", "standings", "finished", "cancelled"] as const;
export type RoomPhase = (typeof ROOM_PHASES)[number];
/** Sent on join (with the party's status and disclosure) and on lifecycle changes (phase only). */
export const roomPhaseSchema = z.object({
  phase: z.enum(ROOM_PHASES),
  partyStatus: z.enum(PARTY_STATUSES).optional(),
  questions: questionDisclosureSchema.optional(),
});

/** Someone actually connected to the room right now. `plays` is false for a curate host, who watches. */
export const roomMemberSchema = z.object({ id: z.string().uuid(), handle: z.string(), displayName: z.string(), avatarEmoji: z.string(), plays: z.boolean() });
export const roomPresenceSchema = z.object({ partyId: z.string().uuid(), online: z.array(roomMemberSchema) });
/** The room's msgpack encoding turns the row's timestamp into a Date; normalise it to the ISO string HTTP sends. */
export const roomChatMessageSchema = chatMessageSchema.extend({
  createdAt: z.preprocess((v) => (v instanceof Date ? v.toISOString() : v), z.string().datetime()),
  displayName: z.string().nullable().optional(),
});
export const roomVoidedSchema = z.object({ questionId: z.string().uuid(), idx: z.number().int(), replacementAdded: z.boolean(), total: z.number().int() });
/** MSG.questionsStatus: the set's state changed. Same shape as the disclosure on party detail. */
export const roomQuestionsStatusSchema = questionDisclosureSchema;
/** not_open, too_late, chat_closed, flag_closed, validation, … */
export const roomErrorSchema = z.object({ error: z.string() });

export type QuestionView<F extends QuestionFormat = QuestionFormat> = z.infer<(typeof questionViewSchemas)[F]>;
export type RoomQuestion = z.infer<typeof roomQuestionSchema>;
export type RevealAnswer = z.infer<typeof revealAnswerSchema>;
export type RoomVerdict = z.infer<typeof roomVerdictSchema>;
export type RoomReveal = z.infer<typeof roomRevealSchema>;
export type StandingRowView = z.infer<typeof standingRowSchema>;
export type RoomStandings = z.infer<typeof roomStandingsSchema>;
export type RoomFinal = z.infer<typeof roomFinalSchema>;
export type RoomPhaseMessage = z.infer<typeof roomPhaseSchema>;
export type RoomMember = z.infer<typeof roomMemberSchema>;
export type RoomPresence = z.infer<typeof roomPresenceSchema>;
export type RoomChatMessage = z.infer<typeof roomChatMessageSchema>;
export type RoomVoided = z.infer<typeof roomVoidedSchema>;
export type RoomQuestionsStatus = z.infer<typeof roomQuestionsStatusSchema>;
export type RetryQuestionsInput = z.infer<typeof retryQuestionsSchema>;
export type EditDraftInput = z.infer<typeof editDraftSchema>;
export type RoomError = z.infer<typeof roomErrorSchema>;

/** Curate review (host's team only): drafts carry full payloads, so they come after the payload schemas. */
export const PARTY_QUESTION_STATUSES = ["draft", "pending", "played", "voided"] as const;
const draftFields = {
  id: z.string().uuid(),
  idx: z.number().int(),
  /** Reserves stand by for swaps and voids; they aren't in the play order. */
  reserve: z.boolean(),
  /** draft: awaiting approval; pending: approved, ready to play; voided: swapped out. */
  status: z.enum(PARTY_QUESTION_STATUSES),
  explanation: z.string().nullable(),
  hostAuthored: z.boolean(),
  /** The independent fact-check: the sources it checked against. Null for host-authored questions. */
  verification: z.object({ sources: z.array(z.string()), difficulty: z.unknown() }).nullable(),
};
/** One curate draft, answers included (host's team only; looking bars the viewer from playing). */
export const draftQuestionSchema = z.discriminatedUnion("format", [
  z.object({ ...draftFields, format: z.literal("pick_one"), payload: questionPayloadSchemas.pick_one }),
  z.object({ ...draftFields, format: z.literal("pick_all"), payload: questionPayloadSchemas.pick_all }),
  z.object({ ...draftFields, format: z.literal("order"), payload: questionPayloadSchemas.order }),
  z.object({ ...draftFields, format: z.literal("match"), payload: questionPayloadSchemas.match }),
  z.object({ ...draftFields, format: z.literal("picture"), payload: questionPayloadSchemas.picture }),
]);
/** GET /parties/:id/drafts: the engine's one-line "what we understood", and the drafts in play order (reserves last). */
export const draftsResponseSchema = z.object({
  specSummary: z.string().nullable(),
  questions: z.array(draftQuestionSchema),
});

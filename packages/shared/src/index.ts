import { z } from "zod";

/** All money is stored in kobo (integer). ₦200 = 20_000 kobo. */
export const kobo = (naira: number) => Math.round(naira * 100);
export const naira = (k: number) => "₦" + (k / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 });

/** Bonus coins are counted in kobo like cash (1 coin = 100 kobo) but shown without the ₦. */
export const coins = (k: number) => (k / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 });

/** Payout Challenge config. Admin-editable (stored under key "payout" in app_config); this is the default when nothing is stored. */
export const payoutStageTypes = ["pattern", "scramble", "wordhunt", "trivia", "sudden_death"] as const;
export const payoutConfigSchema = z.object({
  entryKobo: z.number().int().positive(),
  decisionSeconds: z.number().int().min(1).max(60),
  stages: z.array(z.object({
    type: z.enum(payoutStageTypes),
    seconds: z.number().int().min(3).max(120),
    prizeKobo: z.number().int().positive(),
  })).min(1).max(20).refine((s) => s.every((x, i) => i === 0 || x.prizeKobo > s[i - 1].prizeKobo), "each stage's prize must be higher than the last"),
});
export type PayoutConfig = z.infer<typeof payoutConfigSchema>;
export const DEFAULT_PAYOUT_CONFIG: PayoutConfig = {
  entryKobo: kobo(100),
  decisionSeconds: 8,
  stages: [
    { type: "pattern", seconds: 15, prizeKobo: kobo(300) },
    { type: "scramble", seconds: 15, prizeKobo: kobo(800) },
    { type: "wordhunt", seconds: 15, prizeKobo: kobo(2000) },
    { type: "trivia", seconds: 12, prizeKobo: kobo(5000) },
    { type: "sudden_death", seconds: 10, prizeKobo: kobo(12000) },
  ],
};

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
  /** Default pot split by rank when the creator doesn't choose one. */
  defaultSplit: z.array(z.number().int().positive()).min(1).max(5).refine((s) => s.reduce((a, b) => a + b, 0) === 100, "split must add up to 100"),
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
  defaultSplit: [100],
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
};

export * from "./safety.js";

/** Why a player flagged a question. */
export const FLAG_REASONS = ["wrong_answer", "multiple_correct", "unclear", "out_of_date", "inappropriate"] as const;
export type FlagReason = (typeof FLAG_REASONS)[number];
/** Flags name their question, so a flag that arrives late never lands on the next one. */
export const flagSchema = z.object({ questionId: z.string().uuid(), reason: z.enum(FLAG_REASONS) });

/** Bonus coins every new user starts with (never withdrawable). */
export const WELCOME_BONUS_KOBO = kobo(500);

/** Host source files: parsed server-side into chunks the questions are generated from. */
export const UPLOAD_CONTENT_TYPES = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
} as const;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const requestUploadSchema = z.object({
  filename: z.string().min(1).max(200),
  contentType: z.enum(Object.keys(UPLOAD_CONTENT_TYPES) as [keyof typeof UPLOAD_CONTENT_TYPES, ...(keyof typeof UPLOAD_CONTENT_TYPES)[]]),
  sizeBytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
});

/** Curate mode: a host edit replaces the question's payload (validated against its format) and explanation. */
export const editDraftSchema = z.object({
  payload: z.record(z.unknown()),
  explanation: z.string().max(500).optional(),
});

export const CATEGORIES = ["Afrobeats", "Football", "Nollywood", "General knowledge", "History", "Science", "Tech", "Fashion", "Food", "Geography", "Brain teasers", "Reality TV", "Maths", "Hip hop"] as const;
export type Category = (typeof CATEGORIES)[number];

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

export const handleSchema = z.string().min(3).max(20).regex(/^[a-z0-9_.]+$/, "lowercase letters, numbers, _ and . only");

export const upsertMeSchema = z.object({
  displayName: z.string().min(1).max(40),
  handle: handleSchema,
  avatarEmoji: z.string().min(1).max(8).default("😎"),
  bio: z.string().max(160).optional(),
  interests: z.array(z.enum(CATEGORIES)).max(10).default([]),
});

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
  entryKobo: z.number().int().min(0).max(kobo(50_000)),
  maxPlayers: z.number().int().min(2).max(100),
  funding: z.enum(["pooled", "host"]),
  hostPoolKobo: z.number().int().min(0).default(0),
  /** Host-funded parties may offer a product or experience instead of cash: a fulfilment record, not a ledger entry. */
  prizeKind: z.enum(["cash", "noncash"]).default("cash"),
  prizeText: z.string().min(3).max(120).optional(),
  /** What a non-cash prize is roughly worth, shown as "worth about ₦X" on the party and the join sheet. Informational: no money moves. */
  prizeValueKobo: z.number().int().positive().max(kobo(10_000_000)).optional(),
  /** Pot split by rank. Omitted → the admin default from party config (winner takes all). */
  split: z.array(z.number().int().positive()).min(1).max(5).refine((s) => s.reduce((a, b) => a + b, 0) === 100, "split must add up to 100").optional(),
  questionCount: z.number().int().min(3).max(30).default(5),
  secondsPerQuestion: z.number().int().min(5).max(60).default(15),
  visibility: z.enum(["public", "private"]).default("public"),
  coverColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#7B5CFF"),
  coverEmoji: z.string().max(8).default("🎉"),
  startsInMinutes: z.number().int().min(1).max(24 * 60).default(10),
  inviteUserIds: z.array(z.string().uuid()).max(20).default([]),
}).refine((p) => p.funding === "pooled" ? p.entryKobo > 0 && p.prizeKind === "cash" : true, { message: "pooled parties need an entry fee and pay cash" })
  .refine((p) => p.funding === "host" && p.prizeKind === "cash" ? p.hostPoolKobo > 0 : true, { message: "host-funded cash parties need a pot" })
  .refine((p) => p.prizeKind === "noncash" ? !!p.prizeText && p.hostPoolKobo === 0 : true, { message: "non-cash parties describe the prize and carry no cash pot" })
  .refine((p) => p.prizeValueKobo === undefined || p.prizeKind === "noncash", { message: "only a non-cash prize carries a value" });

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
export const QUEUES = { notify: "notify", party: "party", questions: "questions" } as const;
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
export type PartyJob = { kind: "start" | "cancel_if_empty" | "settle" | "watchdog" | "cancel_generation_failed"; partyId: string };
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
  /** Extract, chunk and embed an uploaded source file. */
  | { kind: "parse_file"; fileId: string }
  /** A question was voided by flags in a room: take it out of retrieval pending review. */
  | { kind: "question_voided"; partyQuestionId: string; flags: number }
  /** Repeatable: retire flagged and underperforming bank questions. */
  | { kind: "retire_sweep" };

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

/** GET /users/:handle: a profile with counts, play stats, the viewer's follow state and open parties hosted. */
export const userStatsSchema = z.object({
  parties: z.number().int(),
  wins: z.number().int(),
  bestPrizeKobo: z.number().int(),
  /** Best finishing rank in any played party; null until one has been played. */
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
  prizeKind: z.enum(["cash", "noncash"]),
  prizeText: z.string().nullable(),
  /** Non-cash prizes only: roughly what it's worth. */
  prizeValueKobo: z.number().int().nullable(),
  split: z.array(z.number().int()),
  visibility: z.enum(["public", "private"]),
  coverColor: z.string(),
  coverEmoji: z.string(),
  status: z.enum(PARTY_STATUSES),
  startsAt: z.string().datetime(),
});

/** GET /parties: one card in Discover. */
export const partySummarySchema = partyRowSchema.extend({
  host: publicHostSchema,
  playerCount: z.number().int(),
  potKobo: z.number().int(),
});
export const partiesResponseSchema = z.array(partySummarySchema);

/**
 * Where the party's question set is: not_started (a curate party before the host asks for drafts),
 * generating, ready, or failed (the host can retry or edit the brief; the party stays open).
 */
export const QUESTIONS_STATUSES = ["not_started", "generating", "ready", "failed"] as const;
export type QuestionsStatus = (typeof QUESTIONS_STATUSES)[number];

/**
 * Always disclosed in the lobby and the game: AI-generated, sealed or host-reviewed, and the set's
 * state. Never any content: `error` is a plain reason for the host ("make the brief broader"), not
 * anything from the questions.
 */
export const questionDisclosureSchema = z.object({
  aiGenerated: z.boolean(),
  review: z.enum(["sealed", "host_reviewed"]),
  status: z.enum(QUESTIONS_STATUSES),
  error: z.string().nullable(),
});

/** The disclosure for a party row. One builder for the API and the room. */
export const questionDisclosure = (p: { mode: "sealed" | "curate"; questionsStatus: QuestionsStatus; questionsError: string | null }): z.infer<typeof questionDisclosureSchema> => ({
  aiGenerated: true,
  review: p.mode === "curate" ? "host_reviewed" : "sealed",
  status: p.questionsStatus,
  error: p.questionsStatus === "failed" ? p.questionsError : null,
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

/** A persisted party chat line. System lines have no author. */
export const chatMessageSchema = z.object({
  id: z.string().uuid(),
  partyId: z.string().uuid(),
  userId: z.string().uuid().nullable(),
  text: z.string().nullable(),
  sticker: z.string().nullable(),
  system: z.boolean(),
  createdAt: z.string().datetime(),
  handle: z.string().nullable(),
  avatarEmoji: z.string().nullable(),
});

/** GET /parties/:id: the lobby before the room is joined. `joined` is the viewer's seat. */
export const partyDetailSchema = partySummarySchema.extend({
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

export const userProfileSchema = publicUserSchema.extend({
  followers: z.number().int(),
  following: z.number().int(),
  stats: userStatsSchema,
  viewer: z.object({ following: z.boolean(), notify: z.boolean() }),
  hosting: z.array(partyRowSchema),
});

/** POST /parties → 201: the new party, its question set's state, and the host's own seat (sealed) counted. */
export const createPartyResponseSchema = partyRowSchema.extend({
  questions: questionDisclosureSchema,
  playerCount: z.number().int(),
  potKobo: z.number().int(),
});

/** A presigned PUT straight to object storage. Send `headers` exactly as given: they're part of the signature. */
export const presignedUploadSchema = z.object({
  url: z.string().url(),
  method: z.literal("PUT"),
  headers: z.record(z.string()),
  expiresAt: z.string().datetime(),
});
/** POST /parties/:id/files → 201. Then PUT the bytes to `upload`, then POST …/files/:fileId/ingest. */
export const requestUploadResponseSchema = z.object({ fileId: z.string().uuid(), upload: presignedUploadSchema });
/** POST /parties/:id/files/:fileId/ingest → 202: the questions service is reading it. */
export const ingestFileResponseSchema = z.object({ status: z.literal("parsing") });

export const PARTY_FILE_STATUSES = ["uploading", "parsing", "parsed", "failed"] as const;
export type PartyFileStatus = (typeof PARTY_FILE_STATUSES)[number];
/** GET /parties/:id/files (host's team): each source file and how reading it went. `error` is worded for the host. */
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
export type CreatePartyInput = z.infer<typeof createPartySchema>;
export type UpsertMeInput = z.infer<typeof upsertMeSchema>;
export type CreatePartyResponse = z.infer<typeof createPartyResponseSchema>;
export type PresignedUpload = z.infer<typeof presignedUploadSchema>;
export type RequestUploadInput = z.infer<typeof requestUploadSchema>;
export type RequestUploadResponse = z.infer<typeof requestUploadResponseSchema>;
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

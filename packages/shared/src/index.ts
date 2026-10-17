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
  /** sealed: generated at start, the host plays. curate: the host reviews drafts and can't play. */
  mode: z.enum(["sealed", "curate"]).default("sealed"),
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
  answer: "answer",
  lock: "lock",
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
export type NotifyJob = NotifyFollowersJob | NotifyInviteJob;
/** `cancel_generation_failed`: the questions service couldn't build a set; the worker refunds (money only moves in the worker). */
export type PartyJob = { kind: "start" | "cancel_if_empty" | "settle" | "watchdog" | "cancel_generation_failed"; partyId: string };
/**
 * Questions-service jobs. `generate_set` persists the gated set into party_questions and then
 * publishes {partyId, status: "questions_ready"} on PARTY_EVENTS_CHANNEL; `record_play` folds a
 * finished party's answer stats back into the bank. (ADR 0002)
 */
export type QuestionsJob =
  | { kind: "generate_set"; partyId: string }
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
export const userStatsSchema = z.object({ parties: z.number().int(), wins: z.number().int(), bestPrizeKobo: z.number().int() });

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

/** Always disclosed in the lobby and the game: AI-generated, and sealed or host-reviewed. */
export const questionDisclosureSchema = z.object({ aiGenerated: z.boolean(), review: z.enum(["sealed", "host_reviewed"]) });

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

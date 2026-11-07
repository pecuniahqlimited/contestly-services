/**
 * Party templates and host-written questions (ADR 0015). Templates are versioned admin config, like About you:
 * every save is a new immutable version and the newest is current; a party keeps its own copy of the template it
 * was made from. Host-written questions are pick-one questions only the host can answer ("Where did Tolu and Femi
 * first meet?"): never fact-checked, always safety-filtered, never in the shared bank. Any set with one runs in
 * curate mode, is never free, and stays inside the caps here; its cash prizes pass the link and outlier check at
 * settlement (packages/game hostWrittenReview).
 */
import { z } from "zod";
import { DIFFICULTIES, QUESTION_FORMATS } from "./questionKinds.js";
import { checkSafety, parseExclusions, type SafetyResult } from "./safety.js";
import { personSchema } from "./person.js";

const KOBO_PER_NAIRA = 100;
const toKobo = (naira: number) => naira * KOBO_PER_NAIRA;
const BPS = 10_000;
const PERCENT = 100;

/** Host-written questions are pick-one only at launch (ADR 0015, "Not decided here": other formats). */
export const HOST_WRITTEN_FORMATS = ["pick_one"] as const;
/** Three wrong options beside the host's right one. */
export const DISTRACTOR_COUNT = 3;
export const MAX_HOST_QUESTION_CHARS = 200;
export const MAX_HOST_ANSWER_CHARS = 80;
export const MAX_HOST_EXPLANATION_CHARS = 300;
/** The most host-written questions one party can carry (the share cap usually bites first). */
export const MAX_HOST_QUESTIONS = 15;

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * One host-written question as the host gives it: the question, the right answer and three wrong ones (suggested
 * by POST /parties/host-questions/distractors, editable). The server shuffles where the right answer lands.
 */
export const hostQuestionSchema = z.object({
  question: z.string().trim().min(3).max(MAX_HOST_QUESTION_CHARS),
  answer: z.string().trim().min(1).max(MAX_HOST_ANSWER_CHARS),
  distractors: z.array(z.string().trim().min(1).max(MAX_HOST_ANSWER_CHARS)).length(DISTRACTOR_COUNT),
  explanation: z.string().trim().max(MAX_HOST_EXPLANATION_CHARS).optional(),
}).refine((q) => {
  const options = [q.answer, ...q.distractors];
  return options.every((o, i) => options.findIndex((x) => sameText(x, o)) === i);
}, { message: "the answer and the three wrong options must all be different", path: ["distractors"] });
export type HostQuestion = z.infer<typeof hostQuestionSchema>;

/** The stored pick-one payload: the options in display order with the right one at `correctIndex`. */
export function hostQuestionPayload(q: HostQuestion, correctIndex: number) {
  if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex > DISTRACTOR_COUNT) throw new Error(`correctIndex ${correctIndex} is out of range`);
  const options = [...q.distractors];
  options.splice(correctIndex, 0, q.answer);
  return { question: q.question, options, correctIndex };
}

/** A stored pick-one payload back in the host's shape (for editing). */
export function hostQuestionFromPayload(p: { question: string; options: string[]; correctIndex: number }): Omit<HostQuestion, "explanation"> {
  return { question: p.question, answer: p.options[p.correctIndex], distractors: p.options.filter((_, i) => i !== p.correctIndex) };
}

/**
 * The safety filter on the host's own words, failing closed: anything it can't read, or that throws, is refused.
 * The party's brief supplies the exclusions ("nothing about politics") and whether politics was asked for.
 */
export function checkHostText(text: { question: string; answer?: string; distractors?: string[]; explanation?: string }, brief: string): SafetyResult {
  try {
    const payload = { question: text.question, options: [text.answer ?? "", ...(text.distractors ?? [])].filter(Boolean) };
    return checkSafety({ topic: brief, exclusions: parseExclusions(brief) }, payload, text.explanation);
  } catch {
    return { passed: false, reasons: ["unreadable"] };
  }
}

/** POST /parties/host-questions/distractors: three believable wrong answers for the host's question and answer. */
export const distractorRequestSchema = z.object({
  question: z.string().trim().min(3).max(MAX_HOST_QUESTION_CHARS),
  answer: z.string().trim().min(1).max(MAX_HOST_ANSWER_CHARS),
  /** The party's brief (or the template's), for tone and exclusions. */
  brief: z.string().trim().max(2000).default(""),
});
export type DistractorRequest = z.infer<typeof distractorRequestSchema>;
export const distractorResponseSchema = z.object({ distractors: z.array(z.string()).length(DISTRACTOR_COUNT) });
export type DistractorResponse = z.infer<typeof distractorResponseSchema>;

/** POST /parties/:id/host-questions → 201. */
export const hostQuestionCreatedSchema = z.object({ id: z.string().uuid(), idx: z.number().int() });

// ---- templates ----------------------------------------------------------------------------------

const idSchema = z.string().trim().regex(/^[a-z0-9_-]{1,40}$/, "lowercase letters, digits, _ or -");

/**
 * A host prompt: a question with blanks for the host to fill ("Where did [name] and [name] first meet?"). The
 * builder shows it with an answer box; nothing about it is a question until the host gives the answer.
 */
export const hostPromptSchema = z.object({
  prompt: z.string().trim().min(3).max(MAX_HOST_QUESTION_CHARS),
  /** A nudge under the answer box ("Their first date spot, the church, the office…"). */
  hint: z.string().trim().max(80).default(""),
});
export type HostPrompt = z.infer<typeof hostPromptSchema>;

/** What the engine adds to the brief for a template's themed questions: who it's for, the tone, what to stay away from. */
export const themedSpecSchema = z.object({
  audience: z.string().trim().max(80).default(""),
  tone: z.string().trim().max(80).default(""),
  /** Kept out of the themed questions whatever the host's brief says ("politics", "exes"). */
  exclusions: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
});
export type ThemedSpec = z.infer<typeof themedSpecSchema>;

export const templateDialsSchema = z.object({
  difficulty: z.enum(DIFFICULTIES),
  secondsPerQuestion: z.number().int().min(5).max(60),
  questionCount: z.number().int().min(3).max(30),
  formats: z.array(z.enum(QUESTION_FORMATS)).min(1).max(QUESTION_FORMATS.length),
});

export const partyTemplateSchema = z.object({
  id: idSchema,
  /** The picker's name ("Birthday") and one-line pitch. */
  name: z.string().trim().min(2).max(40),
  pitch: z.string().trim().min(3).max(120),
  /** What it's for, as data (birthday, wedding, …): recommendations and discovery read it. */
  occasion: idSchema,
  /** Hidden templates stay in the config (and in parties made from them) but aren't offered. */
  hidden: z.boolean().default(false),
  /** Prefills: the party's title and brief, cover and dials. */
  title: z.string().trim().min(3).max(60),
  brief: z.string().trim().min(3).max(2000),
  cover: z.object({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/), emoji: z.string().min(1).max(8) }),
  dials: templateDialsSchema,
  hostPrompts: z.array(hostPromptSchema).max(MAX_HOST_QUESTIONS),
  themed: themedSpecSchema,
});
export type PartyTemplate = z.infer<typeof partyTemplateSchema>;

/**
 * The rules for any party with host-written questions (template or not), with money at stake: caps on the entry and
 * the host's cash prize, the most of the set the host may write, and how far above the room a linked winner's
 * score on the host's questions may be before their prize is held.
 */
export const hostWrittenRulesSchema = z.object({
  maxEntryKobo: z.number().int().positive(),
  maxHostPrizeKobo: z.number().int().positive(),
  /** The most a party can put up: every seat's entry plus the host's cash prize (potCapKobo). */
  maxPotKobo: z.number().int().positive().default(toKobo(50_000)),
  /** Host-written questions as a share of the play order, in basis points (5000 = half). */
  maxHostShareBps: z.number().int().min(0).max(BPS),
  /**
   * A linked winner whose accuracy is at least this many points above the room's, on the host-written questions or
   * on the whole set (a curate host sees every answer), is held.
   */
  outlierMarginPct: z.number().int().min(1).max(PERCENT),
  /** A block between host and winner made this many days or fewer before the party counts as a link (a block is no alibi). */
  recentBlockDays: z.number().int().min(0).max(90).default(7),
  /**
   * Repeats: a winner who has already won this many of the same host's host-written parties within
   * `repeatWindowDays` has the next prize held whatever they scored, linked or not.
   */
  repeatWinsMax: z.number().int().min(1).max(50).default(2),
  /** invited_new: a winner who came in through the host's invite or referral counts as linked while their account is this young. */
  newAccountDays: z.number().int().min(0).max(365).default(14),
  repeatWindowDays: z.number().int().min(1).max(365).default(30),
});
export type HostWrittenRules = z.infer<typeof hostWrittenRulesSchema>;
export const DEFAULT_HOST_WRITTEN_RULES: HostWrittenRules = {
  maxEntryKobo: toKobo(1_000),
  maxHostPrizeKobo: toKobo(50_000),
  maxPotKobo: toKobo(50_000),
  maxHostShareBps: 5_000,
  outlierMarginPct: 30,
  recentBlockDays: 7,
  repeatWinsMax: 2,
  repeatWindowDays: 30,
  newAccountDays: 14,
};

export const partyTemplatesConfigSchema = z.object({
  /** In picker order: reordering is reordering this list, removing is leaving one out. */
  templates: z.array(partyTemplateSchema).max(30),
  rules: hostWrittenRulesSchema,
}).superRefine((c, ctx) => {
  const ids = new Set<string>();
  c.templates.forEach((t, i) => {
    if (ids.has(t.id)) ctx.addIssue({ code: "custom", path: ["templates", i, "id"], message: `template id "${t.id}" is used twice` });
    ids.add(t.id);
  });
});
export type PartyTemplatesConfig = z.infer<typeof partyTemplatesConfigSchema>;

/** A party's copy of the template it was made from (parties.template): editing or removing the template never changes it. */
export const partyTemplateCopySchema = z.object({
  id: z.string(), version: z.number().int(), name: z.string(), occasion: z.string(), themed: themedSpecSchema,
});
export type PartyTemplateCopy = z.infer<typeof partyTemplateCopySchema>;
export const templateCopy = (t: PartyTemplate, version: number): PartyTemplateCopy => ({ id: t.id, version, name: t.name, occasion: t.occasion, themed: t.themed });

/** POST /parties `template`: which template, and the version the builder showed (it must still exist in that version). */
export const templateRefSchema = z.object({ id: idSchema, version: z.number().int().positive() });
export type TemplateRef = z.infer<typeof templateRefSchema>;

/**
 * The create-party fields a template fills in. The API lays the host's own fields over these, so anything the
 * host sent wins and anything left out is the template's.
 */
export function templatePrefill(t: PartyTemplate) {
  return {
    title: t.title, brief: t.brief, difficulty: t.dials.difficulty, formats: t.dials.formats, questionCount: t.dials.questionCount,
    secondsPerQuestion: t.dials.secondsPerQuestion, coverColor: t.cover.color, coverEmoji: t.cover.emoji,
  };
}

/** The most host-written questions a play order of `total` may hold under `maxHostShareBps`. */
export const maxHostQuestions = (total: number, rules: Pick<HostWrittenRules, "maxHostShareBps">) =>
  Math.min(MAX_HOST_QUESTIONS, Math.floor((total * rules.maxHostShareBps) / BPS));

/**
 * Where host-written questions sit in a play order of `total`: spread through it (never all at the start or the end),
 * so the themed questions frame them. Returns sorted 0-based positions.
 */
export function hostSlots(total: number, hostCount: number): number[] {
  if (hostCount <= 0) return [];
  if (hostCount >= total) return Array.from({ length: total }, (_, i) => i);
  const slots = Array.from({ length: hostCount }, (_, i) => Math.floor(((i + 1) * total) / (hostCount + 1)));
  // Two can land together only when hostCount is close to total: nudge each onto the next free place.
  for (let i = 1; i < slots.length; i++) if (slots[i] <= slots[i - 1]) slots[i] = slots[i - 1] + 1;
  return slots;
}

/** Why a party's stakes are refused when it's made from a template or carries host-written questions. */
export const TEMPLATE_PARTY_FREE = "template_party_cannot_be_free";
export const HOST_WRITTEN_FREE = "host_written_party_cannot_be_free";
export const HOST_WRITTEN_STAKES_ERRORS = [
  TEMPLATE_PARTY_FREE,
  HOST_WRITTEN_FREE,
  "host_written_entry_above_cap",
  "host_written_prize_above_cap",
  "host_written_pot_above_cap",
  "host_written_share_above_cap",
] as const;
export type HostWrittenStakesError = (typeof HOST_WRITTEN_STAKES_ERRORS)[number];

export type HostWrittenStakesInput = {
  funding: "pooled" | "host";
  entryKobo: number;
  hostPoolKobo: number;
  prizeKind: "cash" | "product" | "experience";
  maxPlayers: number;
  questionCount: number;
  hostQuestionCount: number;
  fromTemplate: boolean;
};

/** The most a party's pot can reach: every seat's entry (a full party) plus the host's cash prize. */
export const potCapKobo = (s: Pick<HostWrittenStakesInput, "funding" | "entryKobo" | "maxPlayers" | "hostPoolKobo" | "prizeKind">) =>
  (s.funding === "pooled" ? s.entryKobo * s.maxPlayers : 0) + (s.funding === "host" && s.prizeKind === "cash" ? s.hostPoolKobo : 0);

/** Free: a pooled party with no entry. A host-funded party always has a prize (cash, or a verified brand's goods). */
export const isFreeParty = (s: Pick<HostWrittenStakesInput, "funding" | "entryKobo">) => s.funding === "pooled" && s.entryKobo === 0;

/**
 * The template and host-written rules on top of checkStakes (ADR 0015): a template party or one with host-written
 * questions is never free; with host-written questions the entry, the host's cash prize and the most the pot can
 * reach (every seat's entry plus that prize) stay under the caps, and the host writes at most the allowed share. Errors in HOST_WRITTEN_STAKES_ERRORS order; none means it holds.
 */
export function checkHostWrittenStakes(s: HostWrittenStakesInput, rules: HostWrittenRules): HostWrittenStakesError[] {
  const errors = new Set<HostWrittenStakesError>();
  const hostWritten = s.hostQuestionCount > 0;
  if (isFreeParty(s) && s.fromTemplate) errors.add(TEMPLATE_PARTY_FREE);
  if (isFreeParty(s) && hostWritten) errors.add(HOST_WRITTEN_FREE);
  if (hostWritten && s.funding === "pooled" && s.entryKobo > rules.maxEntryKobo) errors.add("host_written_entry_above_cap");
  if (hostWritten && s.funding === "host" && s.prizeKind === "cash" && s.hostPoolKobo > rules.maxHostPrizeKobo) errors.add("host_written_prize_above_cap");
  if (hostWritten && potCapKobo(s) > rules.maxPotKobo) errors.add("host_written_pot_above_cap");
  if (s.hostQuestionCount > maxHostQuestions(s.questionCount, rules)) errors.add("host_written_share_above_cap");
  return HOST_WRITTEN_STAKES_ERRORS.filter((e) => errors.has(e));
}

/** GET /party-templates: the templates offered now (hidden ones left out), in order, and the caps the builder shows. */
export const partyTemplatesResponseSchema = z.object({
  version: z.number().int(),
  templates: z.array(partyTemplateSchema.omit({ hidden: true })),
  rules: hostWrittenRulesSchema.pick({ maxEntryKobo: true, maxHostPrizeKobo: true, maxPotKobo: true, maxHostShareBps: true }),
});
export type PartyTemplatesResponse = z.infer<typeof partyTemplatesResponseSchema>;

/** GET/PUT /admin/party-templates: one version of the whole config. */
export const partyTemplatesVersionSchema = z.object({ version: z.number().int(), config: partyTemplatesConfigSchema, createdAt: z.string() });
export type PartyTemplatesVersion = z.infer<typeof partyTemplatesVersionSchema>;
export const adminPartyTemplatesBodySchema = z.object({ config: z.unknown(), reason: z.string().trim().min(3).max(500) });

/** POST /admin/party-templates/preview: what a party made from one template would start as, against the current config or a draft. */
export const adminPartyTemplatePreviewSchema = z.object({ templateId: idSchema, config: z.unknown().optional() });
export const adminPartyTemplatePreviewResponseSchema = z.object({
  template: partyTemplateSchema,
  /** The create-party fields it prefills. */
  prefill: z.object({
    title: z.string(), brief: z.string(), difficulty: z.enum(DIFFICULTIES), formats: z.array(z.enum(QUESTION_FORMATS)),
    questionCount: z.number().int(), secondsPerQuestion: z.number().int(), coverColor: z.string(), coverEmoji: z.string(),
  }),
  /** How many of its prompts fit at its own question count under the share cap. */
  hostQuestionsAllowed: z.number().int(),
  /** Plain warnings for the admin (none means a host can use every prompt as it is). */
  problems: z.array(z.string()),
});

/** What the admin preview warns about. Pure, so the console can show it while editing too. */
export function templateProblems(t: PartyTemplate, rules: HostWrittenRules): string[] {
  const out: string[] = [];
  const allowed = maxHostQuestions(t.dials.questionCount, rules);
  if (t.hostPrompts.length > allowed) out.push(`${t.hostPrompts.length} host prompts, but at ${t.dials.questionCount} questions a host may write at most ${allowed}`);
  if (!t.dials.formats.length) out.push("no formats for the themed questions");
  return out;
}

// ---- held prizes (anti-collusion) --------------------------------------------------------------

/**
 * How a winner is linked to the host, from the raw relationships (never yourPeople(), which drops blocked pairs):
 * crew mates, contacts either way, played together within yourPeopleDays, a block between them made shortly
 * before the party, a new account that came in through the host's invite or referral, or the same install id or IP.
 */
export const PRIZE_LINK_KINDS = ["crew", "contact", "played_with", "recent_block", "invited_new", "install", "ip"] as const;
export type PrizeLinkKind = (typeof PRIZE_LINK_KINDS)[number];
export const HELD_PRIZE_STATUSES = ["held", "cleared", "rejected"] as const;
export type HeldPrizeStatus = (typeof HELD_PRIZE_STATUSES)[number];
/** Withdrawals wait while a prize is held (withdraw_not_allowed, reason prize_under_review). */
export const PRIZE_UNDER_REVIEW = "prize_under_review";

/**
 * Why a prize is held: the winner beat the room on the host-written questions, or on the whole set (both need a
 * link), or has won the same host's host-written parties too often lately (repeat; no link needed).
 */
export const HOLD_REASONS = ["host_written", "all", "repeat"] as const;

/** The evidence an admin reviews: how they're linked, and their accuracy against the room's, on the host's questions and on the whole set. */
export const heldPrizeEvidenceSchema = z.object({
  links: z.array(z.enum(PRIZE_LINK_KINDS)),
  hostQuestionsPlayed: z.number().int(),
  winnerAccuracyPct: z.number(),
  roomAccuracyPct: z.number(),
  marginPct: z.number(),
  questionsPlayed: z.number().int(),
  winnerAllAccuracyPct: z.number(),
  roomAllAccuracyPct: z.number(),
  allMarginPct: z.number(),
  thresholdPct: z.number().int(),
  /** The same host's host-written parties they'd already won in the repeat window, and the most allowed. */
  priorWins: z.number().int(),
  repeatWinsMax: z.number().int(),
  flaggedOn: z.array(z.enum(HOLD_REASONS)),
});
export type HeldPrizeEvidence = z.infer<typeof heldPrizeEvidenceSchema>;

/** What a reject did with the money: passed to the next placed player, back to the host, or refunded to the other seats. */
export const heldPrizeOutcomeSchema = z.object({
  kind: z.enum(["passed_on", "returned_to_host", "refunded", "forfeited"]),
  to: z.array(z.object({ userId: z.string().uuid(), amountKobo: z.number().int() })),
});
export type HeldPrizeOutcome = z.infer<typeof heldPrizeOutcomeSchema>;

export const adminHeldPrizeSchema = z.object({
  id: z.string().uuid(),
  party: z.object({ id: z.string().uuid(), title: z.string(), funding: z.enum(["pooled", "host"]), endedAt: z.string().nullable() }),
  winner: personSchema,
  host: personSchema,
  place: z.number().int(),
  amountKobo: z.number().int(),
  status: z.enum(HELD_PRIZE_STATUSES),
  evidence: heldPrizeEvidenceSchema,
  /** At or above the second-admin threshold (ADR 0013), the first admin's request to clear, waiting for a second. */
  clearRequest: z.object({ by: personSchema, reason: z.string(), at: z.string() }).nullable(),
  decidedBy: personSchema.nullable(),
  reason: z.string().nullable(),
  decidedAt: z.string().nullable(),
  outcome: heldPrizeOutcomeSchema.nullable(),
  createdAt: z.string(),
});
export type AdminHeldPrize = z.infer<typeof adminHeldPrizeSchema>;
export const adminHeldPrizesQuerySchema = z.object({ status: z.enum(HELD_PRIZE_STATUSES).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
export const adminHeldPrizesResponseSchema = z.object({ prizes: z.array(adminHeldPrizeSchema) });
export const heldPrizeDecisionSchema = z.object({ reason: z.string().trim().min(3).max(500) });
/**
 * POST …/clear or …/reject → the prize as it now stands; `replayed` when it had already been decided that way (or
 * the same admin asked again). `awaitingSecondAdmin`: a clear at or above the second-admin threshold that a
 * different admin must confirm with their own POST …/clear.
 */
export const heldPrizeDecisionResponseSchema = z.object({ prize: adminHeldPrizeSchema, replayed: z.boolean(), awaitingSecondAdmin: z.boolean() });

// ---- the starting set (seed data, not code: version 1 is written by migration 0046 and db:seed) ------

export const DEFAULT_PARTY_TEMPLATES: PartyTemplatesConfig = {
  rules: DEFAULT_HOST_WRITTEN_RULES,
  templates: [
    {
      id: "birthday", name: "Birthday", occasion: "birthday", hidden: false,
      pitch: "How well does everyone know the birthday star?",
      title: "Birthday quiz", brief: "A birthday party quiz: birthday traditions, cakes, famous birthdays and party songs, light and fun.",
      cover: { color: "#FF6B9A", emoji: "🎂" },
      dials: { difficulty: "easy", secondsPerQuestion: 20, questionCount: 10, formats: ["pick_one", "pick_all", "order"] },
      hostPrompts: [
        { prompt: "What is [name]'s go-to order at a restaurant?", hint: "The dish they always pick" },
        { prompt: "Which city was [name] born in?", hint: "" },
        { prompt: "What did [name] want to be when they grew up?", hint: "Their childhood dream job" },
        { prompt: "What is [name]'s favourite song right now?", hint: "The one on repeat" },
        { prompt: "Who is [name]'s celebrity crush?", hint: "" },
      ],
      themed: { audience: "friends and family at a birthday", tone: "warm and playful", exclusions: ["politics", "age jokes"] },
    },
    {
      id: "bridal-shower", name: "Bridal shower", occasion: "wedding", hidden: false,
      pitch: "Test the squad on the bride, the groom and the big day.",
      title: "Bridal shower quiz", brief: "A bridal shower quiz: wedding traditions, love songs, famous couples and Nigerian wedding customs, sweet and fun.",
      cover: { color: "#F2B8C6", emoji: "💍" },
      dials: { difficulty: "easy", secondsPerQuestion: 20, questionCount: 12, formats: ["pick_one", "pick_all"] },
      hostPrompts: [
        { prompt: "Where did [name] and [name] first meet?", hint: "Their first meeting spot" },
        { prompt: "Who said \"I love you\" first, [name] or [name]?", hint: "" },
        { prompt: "What was [name] and [name]'s first date?", hint: "Where they went or what they did" },
        { prompt: "What is [name]'s pet name for [name]?", hint: "" },
        { prompt: "Which country are [name] and [name] dreaming of for the honeymoon?", hint: "" },
        { prompt: "How long have [name] and [name] been together?", hint: "In years" },
      ],
      themed: { audience: "the bride's friends and family", tone: "sweet and celebratory", exclusions: ["politics", "exes"] },
    },
    {
      id: "couples", name: "Couples' hangout", occasion: "couples", hidden: false,
      pitch: "Which couple really knows each other best?",
      title: "Couples' quiz night", brief: "A couples' hangout quiz: famous couples, love songs, romance films and date-night trivia, playful.",
      cover: { color: "#E5484D", emoji: "💞" },
      dials: { difficulty: "mixed", secondsPerQuestion: 15, questionCount: 10, formats: ["pick_one", "pick_all", "match"] },
      hostPrompts: [
        { prompt: "Which couple here has been together the longest?", hint: "Name the couple" },
        { prompt: "Where did [name] propose to [name]?", hint: "" },
        { prompt: "What is [name] and [name]'s couple song?", hint: "" },
        { prompt: "Which of us cooks the best jollof?", hint: "" },
      ],
      themed: { audience: "couples among friends", tone: "playful and light", exclusions: ["politics", "exes"] },
    },
    {
      id: "game-night", name: "Game night", occasion: "game-night", hidden: false,
      pitch: "Board games, bragging rights and a few questions only your crew can answer.",
      title: "Game night showdown", brief: "A game night quiz: board games, card games, video games and general knowledge, competitive and quick.",
      cover: { color: "#7B5CFF", emoji: "🎲" },
      dials: { difficulty: "mixed", secondsPerQuestion: 15, questionCount: 12, formats: ["pick_one", "pick_all", "order", "match"] },
      hostPrompts: [
        { prompt: "Who won the last game night?", hint: "" },
        { prompt: "Which game does [name] always insist on playing?", hint: "" },
        { prompt: "Who is the sorest loser in this group?", hint: "No hard feelings" },
        { prompt: "What snack never runs out at our game nights?", hint: "" },
      ],
      themed: { audience: "a group of friends who play games together", tone: "competitive and quick", exclusions: ["politics"] },
    },
    {
      id: "office-party", name: "Office party", occasion: "office", hidden: false,
      pitch: "Team trivia with a few questions about the people you sit with.",
      title: "Office party quiz", brief: "An office party quiz: work culture, famous companies and brands, Nigerian business and general knowledge, friendly.",
      cover: { color: "#3B82F6", emoji: "💼" },
      dials: { difficulty: "mixed", secondsPerQuestion: 15, questionCount: 12, formats: ["pick_one", "pick_all", "order"] },
      hostPrompts: [
        { prompt: "What year did our company start?", hint: "" },
        { prompt: "Who has been on the team the longest?", hint: "" },
        { prompt: "Which department wins the office party every year?", hint: "" },
        { prompt: "What is the most-ordered lunch in the office?", hint: "" },
        { prompt: "Who is always first in the office in the morning?", hint: "" },
      ],
      themed: { audience: "colleagues at a work party", tone: "friendly and inclusive", exclusions: ["politics", "religion", "salaries"] },
    },
    {
      id: "reunion", name: "Reunion", occasion: "reunion", hidden: false,
      pitch: "Old classmates, old jokes: who remembers the most?",
      title: "Reunion quiz", brief: "A school reunion quiz: throwback music, films and trends from our school days, nostalgic and fun.",
      cover: { color: "#F59E0B", emoji: "🎓" },
      dials: { difficulty: "mixed", secondsPerQuestion: 20, questionCount: 10, formats: ["pick_one", "pick_all", "order"] },
      hostPrompts: [
        { prompt: "What year did we graduate?", hint: "" },
        { prompt: "What was the name of our school's principal?", hint: "" },
        { prompt: "Which teacher did everyone fear the most?", hint: "" },
        { prompt: "What did we call the school canteen?", hint: "Our nickname for it" },
        { prompt: "Who was the class clown?", hint: "" },
      ],
      themed: { audience: "old classmates at a reunion", tone: "nostalgic and warm", exclusions: ["politics"] },
    },
  ],
};

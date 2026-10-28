/**
 * About you (roadmap 5c, ADR 0009): the onboarding questions, as admin config. One set per audience
 * (person, brand), versioned: every save is a new immutable version and the newest is current. Each
 * option can add lanes and archetype weights; the API derives a person's lanes and archetype from
 * their picks with the functions here, and the admin preview runs the same ones.
 */
import { z } from "zod";
import { CATEGORIES, type Category } from "./categories.js";

/** What Home leads with. The list and its order live in code: the order breaks ties, and each one changes Home. */
export const ARCHETYPES = ["competitor", "host", "grinder", "fan"] as const;
export type Archetype = (typeof ARCHETYPES)[number];
/** No weights picked: Home's default. */
export const DEFAULT_ARCHETYPE: Archetype = "competitor";
/** Brands always host; their set carries no weights. */
export const BRAND_ARCHETYPE: Archetype = "host";

export const ABOUT_AUDIENCES = ["person", "brand"] as const;
export type AboutAudience = (typeof ABOUT_AUDIENCES)[number];
export const aboutAudienceSchema = z.enum(ABOUT_AUDIENCES);

const byLowercase = new Map<string, Category>(CATEGORIES.map((c) => [c.toLowerCase(), c]));
/** A lane is one of the category tags, matched however it's cased or spaced ("hip  HOP" → "Hip hop"). */
export const laneSchema = z.preprocess(
  (v) => (typeof v === "string" ? byLowercase.get(v.trim().replace(/\s+/g, " ").toLowerCase()) ?? v : v),
  z.enum(CATEGORIES),
);

const idSchema = z.string().trim().regex(/^[a-z0-9_-]{1,40}$/, "lowercase letters, digits, _ or -");
const MAX_WEIGHT = 10;

export const aboutOptionSchema = z.object({
  id: idSchema,
  emoji: z.string().trim().min(1).max(16),
  label: z.string().trim().min(1).max(60),
  lanes: z.array(laneSchema).max(6).optional(),
  /** Archetype → a small integer. Only known archetypes; summed across a person's picks. */
  weights: z.record(z.string(), z.number().int().min(0).max(MAX_WEIGHT)).optional(),
});
export type AboutOption = z.infer<typeof aboutOptionSchema>;

export const aboutQuestionSchema = z.object({
  id: idSchema,
  prompt: z.string().trim().min(1).max(120),
  hint: z.string().trim().max(80).default(""),
  kind: z.enum(["single", "multi"]),
  /** Multi only: the fewest picks to go on (default 1). */
  min: z.number().int().min(1).optional(),
  /** Multi only: the most picks allowed (default: all of them). */
  max: z.number().int().min(1).optional(),
  options: z.array(aboutOptionSchema).min(2).max(12),
});
export type AboutQuestion = z.infer<typeof aboutQuestionSchema>;

const baseConfigSchema = z.object({ questions: z.array(aboutQuestionSchema).min(1).max(8) });

/** The rules every set follows; the brand set also has no weights. */
function checkConfig(audience: AboutAudience) {
  return (c: z.infer<typeof baseConfigSchema>, ctx: z.RefinementCtx) => {
    const qIds = new Set<string>();
    c.questions.forEach((q, qi) => {
      const at = (...path: (string | number)[]) => ["questions", qi, ...path];
      if (qIds.has(q.id)) ctx.addIssue({ code: "custom", path: at("id"), message: `question id "${q.id}" is used twice` });
      qIds.add(q.id);
      const oIds = new Set<string>();
      q.options.forEach((o, oi) => {
        if (oIds.has(o.id)) ctx.addIssue({ code: "custom", path: at("options", oi, "id"), message: `option id "${o.id}" is used twice` });
        oIds.add(o.id);
        for (const a of Object.keys(o.weights ?? {})) {
          if (!(ARCHETYPES as readonly string[]).includes(a)) ctx.addIssue({ code: "custom", path: at("options", oi, "weights", a), message: `"${a}" is not an archetype` });
        }
        if (audience === "brand" && Object.keys(o.weights ?? {}).length) {
          ctx.addIssue({ code: "custom", path: at("options", oi, "weights"), message: "brand options carry no weights (brands always host)" });
        }
      });
      if (q.kind === "single" && (q.min !== undefined || q.max !== undefined)) ctx.addIssue({ code: "custom", path: at("kind"), message: "min and max are for multi questions" });
      const { min, max } = pickRange(q);
      if (min > q.options.length) ctx.addIssue({ code: "custom", path: at("min"), message: "min is more than the number of options" });
      if (max < min) ctx.addIssue({ code: "custom", path: at("max"), message: "max is less than min" });
    });
  };
}

export const aboutConfigSchemas = {
  person: baseConfigSchema.superRefine(checkConfig("person")),
  brand: baseConfigSchema.superRefine(checkConfig("brand")),
} as const;
export type AboutConfig = z.infer<typeof baseConfigSchema>;
export const aboutConfigSchemaFor = (audience: AboutAudience) => aboutConfigSchemas[audience];

/** How many picks a question takes: a single is exactly one. */
export function pickRange(q: Pick<AboutQuestion, "kind" | "min" | "max" | "options">): { min: number; max: number } {
  if (q.kind === "single") return { min: 1, max: 1 };
  return { min: q.min ?? 1, max: Math.min(q.max ?? q.options.length, q.options.length) };
}

/** { questionId: optionId[] }: a person's picks against one version. */
export const aboutAnswersSchema = z.record(idSchema, z.array(idSchema).max(12));
export type AboutAnswers = z.infer<typeof aboutAnswersSchema>;

export interface AnswerProblem { questionId: string; problem: "unknown_question" | "unknown_option" | "duplicate_option" | "too_few" | "too_many" }

/** Answers fit a version when every question is answered within its range, with its own options, and nothing else. */
export function answerProblems(config: AboutConfig, answers: AboutAnswers): AnswerProblem[] {
  const problems: AnswerProblem[] = [];
  const known = new Set(config.questions.map((q) => q.id));
  for (const id of Object.keys(answers)) if (!known.has(id)) problems.push({ questionId: id, problem: "unknown_question" });
  for (const q of config.questions) {
    const picks = answers[q.id] ?? [];
    const options = new Set(q.options.map((o) => o.id));
    const { min, max } = pickRange(q);
    if (picks.some((p) => !options.has(p))) problems.push({ questionId: q.id, problem: "unknown_option" });
    else if (new Set(picks).size !== picks.length) problems.push({ questionId: q.id, problem: "duplicate_option" });
    else if (picks.length < min) problems.push({ questionId: q.id, problem: "too_few" });
    else if (picks.length > max) problems.push({ questionId: q.id, problem: "too_many" });
  }
  return problems;
}

/** The options picked, question by question, in config order. Unknown ids are skipped (check answerProblems first). */
function pickedOptions(config: AboutConfig, answers: AboutAnswers): AboutOption[] {
  return config.questions.flatMap((q) => {
    const picks = new Set(answers[q.id] ?? []);
    return q.options.filter((o) => picks.has(o.id));
  });
}

export type ArchetypeTotals = Record<Archetype, number>;

/**
 * The archetype a set of picks gives: the highest summed weight; a tie goes to the earlier one in
 * ARCHETYPES; no weight at all is DEFAULT_ARCHETYPE.
 */
export function scoreArchetype(config: AboutConfig, answers: AboutAnswers): { archetype: Archetype; totals: ArchetypeTotals } {
  const totals = Object.fromEntries(ARCHETYPES.map((a) => [a, 0])) as ArchetypeTotals;
  for (const o of pickedOptions(config, answers)) {
    for (const [a, w] of Object.entries(o.weights ?? {})) if (a in totals) totals[a as Archetype] += w;
  }
  const archetype = ARCHETYPES.reduce<Archetype>((best, a) => (totals[a] > totals[best] ? a : best), DEFAULT_ARCHETYPE);
  return { archetype, totals };
}

/** The lanes the picks add, each once, in the order first picked. */
export const lanesFrom = (config: AboutConfig, answers: AboutAnswers): Category[] =>
  [...new Set(pickedOptions(config, answers).flatMap((o) => o.lanes ?? []))];

/** What the API stores and the admin preview shows. A brand's archetype is always host. */
export function deriveAbout(audience: AboutAudience, config: AboutConfig, answers: AboutAnswers) {
  const { archetype, totals } = scoreArchetype(config, answers);
  return { lanes: lanesFrom(config, answers), archetype: audience === "brand" ? BRAND_ARCHETYPE : archetype, totals };
}

/**
 * Editing from Me answers the current version: earlier picks carry over wherever the question and
 * the option ids still exist there. What's left is for the person to fill in.
 */
export function prefillAnswers(config: AboutConfig, earlier: AboutAnswers | null): AboutAnswers {
  if (!earlier) return {};
  const out: AboutAnswers = {};
  for (const q of config.questions) {
    const options = new Set(q.options.map((o) => o.id));
    const kept = (earlier[q.id] ?? []).filter((id) => options.has(id)).slice(0, pickRange(q).max);
    if (kept.length) out[q.id] = kept;
  }
  return out;
}

// ---------------------------------------------------------------- API shapes

/** GET /onboarding/about?audience=: the current set. */
export const aboutQuerySchema = z.object({ audience: aboutAudienceSchema.default("person") });
export const aboutVersionSchema = z.object({
  audience: aboutAudienceSchema,
  version: z.number().int().positive(),
  config: baseConfigSchema,
  createdAt: z.string().datetime(),
});
export type AboutVersion = z.infer<typeof aboutVersionSchema>;

/** PATCH /me/onboarding: who's playing, and/or About you answers against a version. */
export const onboardingPatchSchema = z.object({
  who: z.enum(["person", "brand"]).optional(),
  about: z.object({ version: z.number().int().positive(), answers: aboutAnswersSchema }).optional(),
}).refine((p) => p.who !== undefined || p.about !== undefined, "nothing to save");
export type OnboardingPatch = z.infer<typeof onboardingPatchSchema>;

/** GET /me/onboarding: what this person answered, against which version, and what it gave. */
export const meAboutSchema = z.object({
  audience: aboutAudienceSchema,
  /** Null until About you is answered. */
  answered: z.object({
    version: z.number().int(),
    answers: aboutAnswersSchema,
    answeredAt: z.string().datetime(),
  }).nullable(),
  lanes: z.array(z.string()),
  archetype: z.enum(ARCHETYPES).nullable(),
  /** The set to edit against (the current version), and the earlier picks that still fit it. */
  current: aboutVersionSchema,
  prefill: aboutAnswersSchema,
  /** The current version has questions or options their answers don't cover; offered from Me, never forced. */
  hasNewQuestions: z.boolean(),
});
export type MeAbout = z.infer<typeof meAboutSchema>;

/** PUT /admin/onboarding/about/:audience: a new version. Every save is logged with a reason. */
export const adminAboutBodySchema = z.object({ config: z.unknown(), reason: z.string().trim().min(3).max(500) });
/** POST /admin/onboarding/about/:audience/preview: try picks against the current set, or a draft before saving it. */
export const adminAboutPreviewSchema = z.object({ answers: aboutAnswersSchema, config: z.unknown().optional() });
export const adminAboutPreviewResponseSchema = z.object({
  lanes: z.array(z.string()),
  archetype: z.enum(ARCHETYPES),
  totals: z.record(z.enum(ARCHETYPES), z.number().int()),
  /** Empty when the picks are a complete, valid set of answers. */
  problems: z.array(z.object({ questionId: z.string(), problem: z.string() })),
});
export type AdminAboutPreview = z.infer<typeof adminAboutPreviewResponseSchema>;

// ---------------------------------------------------------------- version 1 (the seed)

/** The prototype's questions, version 1 of each set. Admins change them in the console from then on. */
export const DEFAULT_ABOUT: Record<AboutAudience, AboutConfig> = {
  person: {
    questions: [
      { id: "saturday", prompt: "Saturday night. Where are you?", hint: "Pick all that fit", kind: "multi", min: 1, options: [
        { id: "match", emoji: "⚽", label: "At the match", lanes: ["Football"], weights: { competitor: 1 } },
        { id: "afrobeats", emoji: "🎶", label: "Front row, Afrobeats", lanes: ["Afrobeats", "Hip hop"], weights: { fan: 1 } },
        { id: "nollywood", emoji: "🎬", label: "Nollywood marathon", lanes: ["Nollywood", "Reality TV"], weights: { fan: 1 } },
        { id: "quiz", emoji: "🧩", label: "Quiz night", lanes: ["Brain teasers", "General knowledge"], weights: { grinder: 1 } },
        { id: "cooking", emoji: "🍛", label: "Cooking for everyone", lanes: ["Food"], weights: { host: 1 } },
        { id: "building", emoji: "💻", label: "Building something", lanes: ["Tech", "Science"], weights: { grinder: 1 } },
      ] },
      { id: "rather", prompt: "You'd rather…", hint: "Pick one", kind: "single", options: [
        { id: "beat", emoji: "🏆", label: "Beat my friends", weights: { competitor: 3 } },
        { id: "host", emoji: "🎉", label: "Host the game night", weights: { host: 3 } },
        { id: "climb", emoji: "🧗🏾", label: "Climb the leaderboard", weights: { grinder: 3 } },
        { id: "vibe", emoji: "🫶🏾", label: "Just vibe with people", weights: { fan: 3 } },
      ] },
    ],
  },
  brand: {
    questions: [
      { id: "does", prompt: "What does your brand do?", hint: "Pick all that fit", kind: "multi", min: 1, options: [
        { id: "fashion", emoji: "👗", label: "Fashion", lanes: ["Fashion"] },
        { id: "food", emoji: "🍛", label: "Food & drink", lanes: ["Food"] },
        { id: "music", emoji: "🎶", label: "Music & events", lanes: ["Afrobeats", "Hip hop"] },
        { id: "tech", emoji: "💻", label: "Tech", lanes: ["Tech"] },
        { id: "beauty", emoji: "💄", label: "Beauty", lanes: ["Fashion"] },
        { id: "film", emoji: "🎬", label: "Film & TV", lanes: ["Nollywood", "Reality TV"] },
      ] },
      { id: "goal", prompt: "Why host parties?", hint: "Pick one", kind: "single", options: [
        { id: "launch", emoji: "🚀", label: "Launch something" },
        { id: "reach", emoji: "📣", label: "Reach new fans" },
        { id: "reward", emoji: "🎁", label: "Reward customers" },
        { id: "culture", emoji: "🫶🏾", label: "For the culture" },
      ] },
    ],
  },
};

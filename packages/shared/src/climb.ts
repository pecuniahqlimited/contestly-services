/**
 * The Climb: the contract between the app and the services. Game-type ids with what a client may see
 * and send per type, the ladder config the admin edits, the Lagos calendar every score is counted in,
 * and the response shapes. Generators and graders live in @contestly/game; nothing here knows an answer.
 */
import { z } from "zod";
import { personSchema } from "./person.js";
import {
  CLIMB_DIRECTIONS, checkSettings, climbStageSettingsInputSchema, fillSettings, maxRoundSeconds, settingsAtRound,
  type ClimbGameSettings, type ClimbStageSettings,
} from "./climbSettings.js";
import { CLIMB_WORD_GAMES } from "./climbWords.js";

// ---------------------------------------------------------------- game types

/** Every Climb game type. A new type adds its id here, its view/answer/reveal shapes below, and one registry entry in @contestly/game. */
export const CLIMB_GAME_TYPES = ["pattern", "scramble", "word_hunt", "quick_maths", "memory", "pattern_recall", "word_search"] as const;
export type ClimbGameType = (typeof CLIMB_GAME_TYPES)[number];

/** What the admin console and the app call each type. */
export const CLIMB_GAME_LABELS: Record<ClimbGameType, { label: string; description: string }> = {
  pattern: { label: "Pattern", description: "what comes next in a sequence" },
  scramble: { label: "Scramble", description: "unscramble the word" },
  word_hunt: { label: "Word hunt", description: "find words in a letter grid" },
  quick_maths: { label: "Quick maths", description: "solve against the clock" },
  memory: { label: "Memory", description: "repeat a growing sequence" },
  pattern_recall: { label: "Pattern recall", description: "watch tiles light up, then tap them in order" },
  word_search: { label: "Word search", description: "find every listed word in the grid" },
};

const MAX_SEQUENCE = 12;
const MAX_WORD = 12;
/** Pattern recall's largest grid is 5×5. */
const MAX_TILES = 25;
const MAX_SEARCH_GRID = 12;
const MAX_SEARCH_WORDS = 10;
/** Most Shuffle arrangements a scramble carries. */
export const SCRAMBLE_ARRANGEMENTS = 5;

/** A grid cell, [row, column], 0-based from the top left. */
const cellSchema = z.tuple([z.number().int().min(0).max(MAX_SEARCH_GRID - 1), z.number().int().min(0).max(MAX_SEARCH_GRID - 1)]);
const placementSchema = z.object({ word: z.string(), cells: z.array(cellSchema) });

/** What a client sees while a round is open: never the answer (memory shows its sequence for `showMs`, which is the game). */
export const climbViewSchemas = {
  pattern: z.object({ sequence: z.array(z.number().int()).min(3).max(MAX_SEQUENCE), options: z.array(z.number().int()).length(4) }),
  /** `letters` is the first arrangement; Shuffle cycles through `arrangements` (none spells the answer or another listed word) and clears the tray. */
  scramble: z.object({ letters: z.array(z.string().length(1)).min(3).max(MAX_WORD), arrangements: z.array(z.array(z.string().length(1))).min(1).max(SCRAMBLE_ARRANGEMENTS) }),
  /** Rows of the grid, one string each. Any word from the game's word list, at least `minLength` long, in a straight line in any of the 8 directions counts. */
  word_hunt: z.object({ grid: z.array(z.string()).min(4).max(10), find: z.number().int().min(1), minLength: z.number().int().min(2) }),
  quick_maths: z.object({ expression: z.string() }),
  /** Show `sequence` (symbols 0..symbols-1) for `showMs` from the round opening, then hide it; the clock covers both. */
  memory: z.object({ symbols: z.number().int().min(2).max(9), sequence: z.array(z.number().int().min(0)).min(2).max(MAX_SEQUENCE), showMs: z.number().int().positive() }),
  /**
   * Tiles numbered row by row from 0 on a gridSize × gridSize board. Light `sequence` one tile at a time for `msPerTile` each, once
   * (resume after a hide, never replay); then the player repeats it. The clock covers both.
   */
  pattern_recall: z.object({ gridSize: z.number().int().min(3).max(5), sequence: z.array(z.number().int().min(0).max(MAX_TILES - 1)).min(1).max(MAX_TILES), msPerTile: z.number().int().positive() }),
  /** Rows of the grid, one string each, and the words hidden in it (alphabetical). Words run the ways `directions` allows. */
  word_search: z.object({ grid: z.array(z.string()).min(6).max(MAX_SEARCH_GRID), words: z.array(z.string()).min(1).max(MAX_SEARCH_WORDS), directions: z.enum(CLIMB_DIRECTIONS) }),
} satisfies Record<ClimbGameType, z.ZodTypeAny>;

/** What a player sends. One answer per round; the server grades the first one it receives. */
export const climbAnswerSchemas = {
  pattern: z.object({ index: z.number().int().min(0).max(3) }),
  /** The letters placed so far; a partial guess is allowed (and wrong). */
  scramble: z.object({ word: z.string().max(MAX_WORD) }),
  word_hunt: z.object({ words: z.array(z.string().max(MAX_WORD)).max(20) }),
  quick_maths: z.object({ value: z.number().int() }),
  memory: z.object({ sequence: z.array(z.number().int().min(0)).max(MAX_SEQUENCE) }),
  /** The tiles tapped, in order; sent early on a wrong tap. Right only on an exact match. */
  pattern_recall: z.object({ sequence: z.array(z.number().int().min(0)).max(MAX_TILES) }),
  /** Each word found with the cells selected for it, either way along its line. Right only if every word is found. */
  word_search: z.object({ found: z.array(z.object({ word: z.string().max(MAX_WORD), cells: z.array(cellSchema).max(MAX_SEARCH_GRID) })).max(MAX_SEARCH_WORDS) }),
} satisfies Record<ClimbGameType, z.ZodTypeAny>;

/** The answer, sent only once the round is closed (answered or timed out). */
export const climbRevealSchemas = {
  pattern: z.object({ correctIndex: z.number().int() }),
  scramble: z.object({ word: z.string() }),
  /** The words the grid was built around; other listed words found in it counted too. */
  word_hunt: z.object({ words: z.array(z.string()) }),
  quick_maths: z.object({ value: z.number().int() }),
  memory: z.object({ sequence: z.array(z.number().int()) }),
  pattern_recall: z.object({ sequence: z.array(z.number().int()) }),
  /** Where every word was, so the app can outline the missed ones. */
  word_search: z.object({ placements: z.array(placementSchema) }),
} satisfies Record<ClimbGameType, z.ZodTypeAny>;

export type ClimbView<T extends ClimbGameType = ClimbGameType> = z.infer<(typeof climbViewSchemas)[T]>;
export type ClimbAnswer<T extends ClimbGameType = ClimbGameType> = z.infer<(typeof climbAnswerSchemas)[T]>;
export type ClimbReveal<T extends ClimbGameType = ClimbGameType> = z.infer<(typeof climbRevealSchemas)[T]>;

type ByType<S extends Record<ClimbGameType, z.ZodTypeAny>, F extends string> = { [K in ClimbGameType]: { type: K } & { [P in F]: z.infer<S[K]> } }[ClimbGameType];
/** One object per game type, discriminated on `type`, carrying that type's shape under `field`. */
const byType = <S extends Record<ClimbGameType, z.ZodTypeAny>, F extends string>(schemas: S, field: F) =>
  z.discriminatedUnion("type", CLIMB_GAME_TYPES.map((t) => z.object({ type: z.literal(t), [field]: schemas[t] })) as any) as unknown as z.ZodType<ByType<S, F>>;

// ---------------------------------------------------------------- ladder config

const stageInputSchema = z.object({
  /** A round picks one of these (only those switched on in `enabledTypes`). */
  types: z.array(z.enum(CLIMB_GAME_TYPES)).min(1),
  rounds: z.number().int().min(1).max(10),
  /** Rounds right needed to clear the stage. */
  toClear: z.number().int().min(1).max(10),
  /** The clock for a type whose settings don't set their own time. */
  seconds: z.number().int().min(3).max(120),
  /** Banked when the stage is cleared. A run's points are the sum over the stages it cleared. */
  points: z.number().int().min(0).max(10_000),
  /** A block per type in `types` (ADR 0011); a missing block or setting takes the type's defaults for this stage. */
  settings: climbStageSettingsInputSchema.default({}),
}).refine((s) => s.toClear <= s.rounds, { message: "to clear can't be more than the rounds", path: ["toClear"] })
  .refine((s) => new Set(s.types).size === s.types.length, { message: "a game type is listed twice", path: ["types"] });

/** 0 at the first stage, 1 at the last: what each type's default settings scale by. */
export const stageLevel = (stageIdx: number, stageCount: number) => (stageCount <= 1 ? 0 : stageIdx / (stageCount - 1));

/**
 * The ladder every run climbs. Each save is a new version; a run keeps the version it started on, settings included.
 * Parsing fills every stage's settings for the types it lists (defaults for anything not set) and drops blocks
 * for types it doesn't list, so a parsed ladder always says exactly how each round will play.
 */
export const climbLadderSchema = z.object({
  stages: z.array(stageInputSchema).min(1).max(20),
  /** Game types switched on. Switching one off takes it out of every stage from the next run. */
  enabledTypes: z.array(z.enum(CLIMB_GAME_TYPES)).min(1),
}).superRefine((l, ctx) => {
  l.stages.forEach((s, i) => {
    if (!s.types.some((t) => l.enabledTypes.includes(t))) ctx.addIssue({ code: "custom", message: `stage ${i + 1} has no game type switched on`, path: ["stages", i, "types"] });
    for (const type of s.types) {
      for (const p of checkSettings(type, s.settings[type] as never, stageLevel(i, l.stages.length))) {
        ctx.addIssue({ code: "custom", message: `stage ${i + 1}, ${CLIMB_GAME_LABELS[type].label}: ${p.message}`, path: ["stages", i, "settings", type, p.path] });
      }
    }
  });
}).transform((l) => ({
  enabledTypes: l.enabledTypes,
  stages: l.stages.map((s, i) => ({
    ...s,
    settings: Object.fromEntries(s.types.map((t) => [t, fillSettings(t, s.settings[t] as never, stageLevel(i, l.stages.length))])) as ClimbStageSettings,
  })),
}));
export type ClimbLadder = z.output<typeof climbLadderSchema>;
export type ClimbLadderInput = z.input<typeof climbLadderSchema>;
export type ClimbStage = ClimbLadder["stages"][number];
/** Kept for callers that validate one stage on its own (no settings filled: that needs the stage's place in the ladder). */
export const climbStageSchema = stageInputSchema;

/** The ladder before an admin saves one. */
export const DEFAULT_CLIMB_LADDER: ClimbLadder = climbLadderSchema.parse({
  stages: [
    { types: ["pattern"], rounds: 3, toClear: 2, seconds: 15, points: 10 },
    { types: ["scramble", "pattern"], rounds: 3, toClear: 2, seconds: 15, points: 20 },
    { types: ["word_hunt"], rounds: 3, toClear: 2, seconds: 20, points: 30 },
    { types: ["quick_maths"], rounds: 3, toClear: 2, seconds: 12, points: 40 },
    { types: ["memory", "quick_maths"], rounds: 3, toClear: 3, seconds: 10, points: 50 },
  ],
  enabledTypes: [...CLIMB_GAME_TYPES],
});

/** The types a stage's rounds can actually pick from. */
export const stageTypes = (ladder: ClimbLadder, stage: ClimbStage) => stage.types.filter((t) => ladder.enabledTypes.includes(t));

/** A type's settings in a stage. Every type a parsed stage lists has a block. */
export function stageSettings<T extends ClimbGameType>(stage: ClimbStage, type: T): ClimbGameSettings<T> {
  const s = stage.settings[type];
  if (!s) throw new Error(`stage has no settings for ${type}`); // a parsed ladder always has them
  return s as ClimbGameSettings<T>;
}

/** The longest a stage's round can run (0-based round), over the types it can pick. */
export const stageRoundMaxSeconds = (ladder: ClimbLadder, stage: ClimbStage, roundIdx: number) =>
  Math.max(...stageTypes(ladder, stage).map((t) => maxRoundSeconds(t, settingsAtRound(stageSettings(stage, t), roundIdx, stage.rounds), stage.seconds)));

/** The longest any round of a stage can run. */
export const stageMaxSeconds = (ladder: ClimbLadder, stage: ClimbStage) =>
  Math.max(...Array.from({ length: stage.rounds }, (_, r) => stageRoundMaxSeconds(ladder, stage, r)));

/** "What players see" in the admin console: a full run's rounds, its longest possible play time (from each round's computed time), and its most points. */
export function ladderSummary(ladder: ClimbLadder) {
  return {
    rounds: ladder.stages.reduce((n, s) => n + s.rounds, 0),
    maxSeconds: ladder.stages.reduce((n, s) => n + Array.from({ length: s.rounds }, (_, r) => stageRoundMaxSeconds(ladder, s, r)).reduce((a, b) => a + b, 0), 0),
    maxPoints: ladder.stages.reduce((n, s) => n + s.points, 0),
  };
}

/**
 * Weekly prizes on the Everyone board: how many places win, and the cash for each, best first. Versioned
 * like the ladder: each admin save is a new version, and a week closes with the version current when it began.
 */
export const MAX_WEEKLY_WINNERS = 100;
export const climbPrizesSchema = z.object({
  winners: z.number().int().min(0).max(MAX_WEEKLY_WINNERS),
  /** Kobo per place, 1st first; exactly one per winner. */
  prizeKobo: z.array(z.number().int().positive()).max(MAX_WEEKLY_WINNERS),
}).refine((p) => p.prizeKobo.length === p.winners, { message: "one prize per weekly winner", path: ["prizeKobo"] });
export type ClimbPrizes = z.infer<typeof climbPrizesSchema>;
/** Before an admin has set any: nobody wins. */
export const NO_CLIMB_PRIZES: ClimbPrizes = { winners: 0, prizeKobo: [] };
export const weeklyPrizeTotalKobo = (p: ClimbPrizes) => p.prizeKobo.reduce((n, k) => n + k, 0);

/** Climb settings that aren't the ladder or the prizes (app_config "climb"). They apply to runs as they're played. */
export const climbSettingsSchema = z.object({
  /** Pause between a round's verdict and the next round opening. */
  revealSeconds: z.number().int().min(0).max(10),
  /** Pause after a stage is cleared, before the next stage's first round. */
  stageBreakSeconds: z.number().int().min(0).max(15),
  /** An answer received this long after the clock ends still counts (network time). */
  latencyAllowanceMs: z.number().int().min(0).max(5000),
  /** New Today's challenges get these; one already written keeps its own. */
  challengeSeconds: z.number().int().min(3).max(60),
  challengeMaxPoints: z.number().int().min(1).max(1000),
  /** Rows on the Everyone board. */
  boardLimit: z.number().int().min(5).max(200),
});
export type ClimbSettings = z.infer<typeof climbSettingsSchema>;

export const DEFAULT_CLIMB_SETTINGS: ClimbSettings = {
  revealSeconds: 2,
  stageBreakSeconds: 4,
  latencyAllowanceMs: 1500,
  challengeSeconds: 8,
  challengeMaxPoints: 100,
  boardLimit: 50,
};

// ---------------------------------------------------------------- calendar

/** Africa/Lagos is UTC+1 all year (no daylight saving), so Climb days and weeks are plain arithmetic. */
export const CLIMB_TIME_ZONE = "Africa/Lagos";
const LAGOS_OFFSET_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS_PER_WEEK = 7;
/** A Climb day: YYYY-MM-DD in Lagos. */
export type ClimbDay = string;

/** The Lagos calendar day an instant falls on. */
export const lagosDay = (at: Date = new Date()): ClimbDay => new Date(at.getTime() + LAGOS_OFFSET_MS).toISOString().slice(0, 10);
/** The instant a Lagos day starts (00:00 Lagos). */
export const dayStartsAt = (day: ClimbDay) => new Date(Date.parse(`${day}T00:00:00Z`) - LAGOS_OFFSET_MS);
export const addDays = (day: ClimbDay, n: number): ClimbDay => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
/** The Monday that starts the Climb week a day is in. Weeks run Monday–Sunday. */
export function weekOf(day: ClimbDay): ClimbDay {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(day, -((weekday + DAYS_PER_WEEK - 1) % DAYS_PER_WEEK));
}
/** The seven days of a week, Monday first. */
export const weekDays = (week: ClimbDay) => Array.from({ length: DAYS_PER_WEEK }, (_, i) => addDays(week, i));
/** When a week ends (Monday 00:00 Lagos after it). */
export const weekEndsAt = (week: ClimbDay) => dayStartsAt(addDays(week, DAYS_PER_WEEK));

/** The streak after playing on `today`: unchanged if already played today, +1 after yesterday, else a fresh 1. */
export function nextStreak(lastPlayedOn: ClimbDay | null, streakDays: number, today: ClimbDay): number {
  if (lastPlayedOn === today) return streakDays;
  return lastPlayedOn === addDays(today, -1) ? streakDays + 1 : 1;
}
/** The streak as of `today`: it survives until a whole day passes without a run. */
export const currentStreak = (lastPlayedOn: ClimbDay | null, streakDays: number, today: ClimbDay) =>
  lastPlayedOn === today || lastPlayedOn === addDays(today, -1) ? streakDays : 0;

/** Leaderboard sorted sets in Valkey, per week and scope ("everyone" now; crews later). Postgres is the record. */
export const climbBoardKey = (week: ClimbDay, scope: ClimbBoardScope = "everyone", scopeId = "") => `climb:board:${week}:${scope}:${scopeId}`;
/** A week's board (and its snapshot) outlives the week by this long, for late reads; Postgres keeps it for good. */
export const CLIMB_BOARD_TTL_SECONDS = 21 * 24 * 60 * 60;
/** The same board as it stood when today began, for ▲/▼ since yesterday. */
export const climbBoardStartOfDayKey = (week: ClimbDay, scope: ClimbBoardScope = "everyone", scopeId = "") => `${climbBoardKey(week, scope, scopeId)}:sod`;

/** Stored scopes. Friends is a view over Everyone (the people you follow), so it's never stored. Row 6 adds "crew". */
export const CLIMB_BOARD_SCOPES = ["everyone"] as const;
export type ClimbBoardScope = (typeof CLIMB_BOARD_SCOPES)[number];
/** Boards a player can open. */
export const CLIMB_BOARD_VIEWS = ["everyone", "friends"] as const;

// ---------------------------------------------------------------- runs

export const CLIMB_RUN_STATUSES = ["active", "cleared", "missed", "abandoned"] as const;
export type ClimbRunStatus = (typeof CLIMB_RUN_STATUSES)[number];

export const climbRoundSchema = byType(climbViewSchemas, "view").and(z.object({
  id: z.string().uuid(),
  /** 1-based. */
  stage: z.number().int(),
  round: z.number().int(),
  rounds: z.number().int(),
  toClear: z.number().int(),
  seconds: z.number().int(),
  opensAt: z.string().datetime(),
  closesAt: z.string().datetime(),
}));

export const climbRunSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(CLIMB_RUN_STATUSES),
  ladderVersion: z.number().int(),
  /** The stage being played (1-based), or the last one reached once the run is over. */
  stage: z.number().int(),
  stageCount: z.number().int(),
  stagesCleared: z.number().int(),
  points: z.number().int(),
  /** Rounds right and played so far in the current stage. */
  stageRight: z.number().int(),
  stagePlayed: z.number().int(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
});

/** The server's clock when it built the response, so the app can time `opensAt`/`closesAt`/`nextOpensAt` against it rather than the phone's clock. */
const serverNow = z.string().datetime();

/** POST /climb/runs → 201, GET /climb/runs/:id. `round` is the open round; between rounds it's null and `nextOpensAt` says when to fetch again. */
export const climbRunStateSchema = z.object({
  run: climbRunSchema,
  round: climbRoundSchema.nullable(),
  nextOpensAt: z.string().datetime().nullable(),
  serverNow,
});

/** POST /climb/runs/:id/answer */
export const climbAnswerBodySchema = z.object({ roundId: z.string().uuid(), answer: z.unknown() });

export const CLIMB_STAGE_OUTCOMES = ["continue", "cleared", "missed"] as const;
export const climbAnswerResponseSchema = z.object({
  correct: z.boolean(),
  reveal: byType(climbRevealSchemas, "answer"),
  /** What this round decided for its stage: keep going, cleared (points banked), or missed (the run ends). */
  stageOutcome: z.enum(CLIMB_STAGE_OUTCOMES),
  run: climbRunSchema,
  /** When to GET the run for the next round; null once the run is over. */
  nextOpensAt: z.string().datetime().nullable(),
  serverNow,
});

// ---------------------------------------------------------------- Today's challenge

const challengeQuestionSchema = z.object({
  prompt: z.string().trim().min(1).max(200),
  options: z.array(z.string().trim().min(1).max(80)).min(2).max(4),
  correctIndex: z.number().int().min(0),
}).refine((q) => q.correctIndex < q.options.length, { message: "the correct option must be one of the options", path: ["correctIndex"] })
  .refine((q) => new Set(q.options.map((o) => o.toLowerCase())).size === q.options.length, { message: "options must differ", path: ["options"] });
export type ChallengeQuestion = z.infer<typeof challengeQuestionSchema>;

/** PUT /admin/climb/challenges/:day: write or rewrite the challenge for a day (refused once anyone has played it). */
export const upsertChallengeSchema = z.object({
  title: z.string().trim().min(1).max(80),
  questions: z.array(challengeQuestionSchema).min(1).max(10),
});

/** The admin view, answers included. */
export const adminChallengeSchema = upsertChallengeSchema.extend({
  id: z.string().uuid(),
  day: z.string(),
  seconds: z.number().int(),
  maxPoints: z.number().int(),
  attempts: z.number().int(),
});
export const adminChallengesResponseSchema = z.array(adminChallengeSchema);

export const CHALLENGE_ATTEMPT_STATES = ["not_started", "in_progress", "finished"] as const;
/** Today's challenge as a player sees it before and after playing: never its questions. */
export const todayChallengeSchema = z.object({
  id: z.string().uuid(),
  day: z.string(),
  title: z.string(),
  questionCount: z.number().int(),
  seconds: z.number().int(),
  maxPoints: z.number().int(),
  attempt: z.object({ state: z.enum(CHALLENGE_ATTEMPT_STATES), correct: z.number().int(), points: z.number().int() }),
});

/** One open challenge question, its options in this player's order. */
export const challengeQuestionViewSchema = z.object({
  idx: z.number().int(),
  total: z.number().int(),
  prompt: z.string(),
  options: z.array(z.string()),
  opensAt: z.string().datetime(),
  closesAt: z.string().datetime(),
});

/** POST /climb/challenge/start and GET /climb/challenge/play: the attempt and the open question (null between questions or once done). */
export const challengePlayStateSchema = z.object({
  challenge: todayChallengeSchema,
  question: challengeQuestionViewSchema.nullable(),
  nextOpensAt: z.string().datetime().nullable(),
  serverNow,
});

/** POST /climb/challenge/answer. `index` is in this player's option order; null is "no answer" and is graded wrong. An index past the options is refused. */
export const challengeAnswerBodySchema = z.object({ idx: z.number().int().min(0), index: z.number().int().min(0).nullable() });
export const challengeAnswerResponseSchema = z.object({
  correct: z.boolean(),
  /** In this player's option order. */
  correctIndex: z.number().int(),
  challenge: todayChallengeSchema,
  nextOpensAt: z.string().datetime().nullable(),
  serverNow,
});

// ---------------------------------------------------------------- home and boards

const boardRowSchema = z.object({
  rank: z.number().int(),
  /** Rank when today began; null if they weren't on the board yet. */
  prevRank: z.number().int().nullable(),
  person: personSchema,
  points: z.number().int(),
  /** Best run this week, in stages cleared; clearedAll when that run cleared its whole ladder. */
  bestStagesCleared: z.number().int(),
  clearedAll: z.boolean(),
  isMe: z.boolean(),
});
export type ClimbBoardRow = z.infer<typeof boardRowSchema>;

/** GET /climb/leaderboard?board=everyone|friends */
export const climbBoardSchema = z.object({
  board: z.enum(CLIMB_BOARD_VIEWS),
  week: z.string(),
  endsAt: z.string().datetime(),
  /** Places paid on Everyone this week, and the points at the last paid place right now (null while fewer have scored). */
  prizeLine: z.object({ places: z.number().int(), points: z.number().int().nullable() }),
  rows: z.array(boardRowSchema),
  /** The viewer's row, also when it isn't in `rows` (pinned below). Null if they haven't scored this week. */
  me: boardRowSchema.nullable(),
  /** The row just above the viewer and the gap to it. */
  ahead: z.object({ person: personSchema, gap: z.number().int() }).nullable(),
});

/** GET /climb: everything the Climb home shows. */
export const climbHomeSchema = z.object({
  ladder: z.object({
    version: z.number().int(),
    /** `seconds`: the longest round in the stage, from its settings. */
    stages: z.array(z.object({ stage: z.number().int(), types: z.array(z.enum(CLIMB_GAME_TYPES)), rounds: z.number().int(), toClear: z.number().int(), seconds: z.number().int(), points: z.number().int() })),
  }),
  today: z.object({ day: z.string(), bestPoints: z.number().int(), bestStagesCleared: z.number().int(), runs: z.number().int() }),
  activeRunId: z.string().uuid().nullable(),
  challenge: todayChallengeSchema.nullable(),
  week: z.object({
    week: z.string(),
    endsAt: z.string().datetime(),
    daysPlayed: z.number().int(),
    stagesCleared: z.number().int(),
    points: z.number().int(),
    /** Monday first. */
    days: z.array(z.object({ day: z.string(), runPoints: z.number().int(), challengePoints: z.number().int() })),
    everyone: z.object({ rank: z.number().int().nullable(), prizeLine: z.object({ places: z.number().int(), points: z.number().int().nullable() }) }),
    friends: z.object({ rank: z.number().int().nullable(), of: z.number().int(), leader: z.object({ person: personSchema, gap: z.number().int() }).nullable() }),
  }),
  records: z.object({ bestRunPoints: z.number().int(), fastestStageOneMs: z.number().int().nullable(), streakDays: z.number().int() }),
});

// ---------------------------------------------------------------- admin

/** GET and PUT /admin/climb/ladder. PUT takes { ladder } and saves it as a new version. */
export const adminLadderBodySchema = z.object({ ladder: climbLadderSchema });
/**
 * A stage whose settings need more words than the active list has for that game (e.g. word search with 8 words
 * of 7+ letters). Saving is allowed; at play the round makes do with fewer (word search places fewer words).
 */
export const climbWordWarningSchema = z.object({
  stage: z.number().int(),
  type: z.enum(CLIMB_WORD_GAMES),
  /** 1-based round with the biggest shortfall. */
  round: z.number().int(),
  minLength: z.number().int(),
  maxLength: z.number().int(),
  needed: z.number().int(),
  available: z.number().int(),
  /**
   * Words of any length that still work for the round (e.g. fit the grid). Runs widen to these when the stage's lengths
   * run short; if even these fall short the stage can't be supplied and the ladder can't be saved (`blocking`).
   */
  availableWidened: z.number().int(),
  blocking: z.boolean(),
  message: z.string(),
});
export type ClimbWordWarning = z.infer<typeof climbWordWarningSchema>;

export const adminLadderResponseSchema = z.object({
  version: z.number().int(),
  ladder: climbLadderSchema,
  summary: z.object({ rounds: z.number().int(), maxSeconds: z.number().int(), maxPoints: z.number().int() }),
  gameTypes: z.array(z.object({ type: z.enum(CLIMB_GAME_TYPES), label: z.string(), description: z.string() })),
  warnings: z.array(climbWordWarningSchema),
});

const sampleRoundSchema = z.object({
  stage: z.number().int(),
  /** 1-based round within the stage. */
  round: z.number().int(),
  type: z.enum(CLIMB_GAME_TYPES),
  /** The round's computed clock. */
  seconds: z.number().int(),
  view: z.record(z.unknown()),
  answer: z.record(z.unknown()),
});
/**
 * POST /admin/climb/ladder/preview { ladder, sample? }: a draft ladder's summary and word warnings, one sample round per
 * stage, and with `sample` one round of that stage, type and round number generated with the draft's settings. Answers included (admins only).
 */
export const adminLadderPreviewBodySchema = z.object({
  ladder: climbLadderSchema,
  sample: z.object({ stage: z.number().int().min(1), type: z.enum(CLIMB_GAME_TYPES), round: z.number().int().min(1) }).optional(),
});
export const adminLadderPreviewSchema = z.object({
  summary: adminLadderResponseSchema.shape.summary,
  warnings: z.array(climbWordWarningSchema),
  stages: z.array(sampleRoundSchema),
  sample: sampleRoundSchema.nullable(),
});

/** GET and PUT /admin/climb/settings */
export const adminClimbSettingsSchema = z.object({ settings: climbSettingsSchema });

/** PUT /admin/climb/prizes: saves a new version, used from the next week that begins. */
export const adminPrizesBodySchema = z.object({ prizes: climbPrizesSchema });
/**
 * GET and PUT /admin/climb/prizes. `current`: the newest version (null before any save), which the next week
 * to begin will use. `thisWeek`: what the week being played closes with.
 */
const prizeVersionSchema = z.object({ version: z.number().int(), prizes: climbPrizesSchema, totalKobo: z.number().int(), createdAt: z.string().datetime() });
export const adminPrizesResponseSchema = z.object({
  current: prizeVersionSchema.nullable(),
  thisWeek: z.object({ week: z.string(), version: z.number().int().nullable(), prizes: climbPrizesSchema, totalKobo: z.number().int() }),
});
export type AdminPrizesResponse = z.infer<typeof adminPrizesResponseSchema>;

/** A weekly prize: pending until an admin decides; approved means paid, or waiting for the winner to sign in; void when the winner deleted their account before it was paid. */
export const CLIMB_AWARD_STATUSES = ["pending", "approved", "paid", "rejected", "void"] as const;
export const climbAwardSchema = z.object({
  id: z.string().uuid(),
  week: z.string(),
  place: z.number().int(),
  points: z.number().int(),
  amountKobo: z.number().int(),
  status: z.enum(CLIMB_AWARD_STATUSES),
  person: personSchema,
  /** False until the winner has a signed-in account; an approved award waits for it. */
  canBePaid: z.boolean(),
  decidedAt: z.string().datetime().nullable(),
  paidAt: z.string().datetime().nullable(),
});
export const adminAwardsResponseSchema = z.array(climbAwardSchema);

export type ClimbRound = z.infer<typeof climbRoundSchema>;
export type ClimbRun = z.infer<typeof climbRunSchema>;
export type ClimbRunState = z.infer<typeof climbRunStateSchema>;
export type ClimbAnswerResponse = z.infer<typeof climbAnswerResponseSchema>;
export type TodayChallenge = z.infer<typeof todayChallengeSchema>;
export type ChallengePlayState = z.infer<typeof challengePlayStateSchema>;
export type ChallengeAnswerResponse = z.infer<typeof challengeAnswerResponseSchema>;
export type ClimbBoard = z.infer<typeof climbBoardSchema>;
export type ClimbHome = z.infer<typeof climbHomeSchema>;
export type AdminLadderResponse = z.infer<typeof adminLadderResponseSchema>;
export type ClimbAward = z.infer<typeof climbAwardSchema>;

/**
 * Per-stage settings for each Climb game type (ADR 0011). A stage holds one settings block per type it
 * allows; any numeric setting is one number for the whole stage or a ramp { first, last } across the
 * stage's rounds. Difficulty depends only on the stage and the round, never on the player. Each type's
 * defaults are a function of the stage's level (0 at the first stage, 1 at the last) so a ladder saved
 * before settings existed plays as it did. Time is part of each type's settings; a type that doesn't
 * set its own uses the stage's seconds.
 */
import { z } from "zod";
import type { ClimbGameType } from "./climb.js";

// ---------------------------------------------------------------- ramps

export type Ramp = number | { first: number; last: number };

/** A whole number in [min, max] for the stage, or a ramp between two such numbers from its first round to its last. */
export const ramp = (min: number, max: number) => {
  const n = z.number().int().min(min).max(max);
  return z.union([n, z.object({ first: n, last: n }).strict()]);
};

/** A ramp's value at a round (0-based) of a stage with `rounds` rounds: round 1 is `first`, the last round is `last`. */
export function atRound(r: Ramp, roundIdx: number, rounds: number): number {
  if (typeof r === "number") return r;
  if (rounds <= 1) return r.first;
  const t = Math.min(1, Math.max(0, roundIdx / (rounds - 1)));
  return Math.round(r.first + (r.last - r.first) * t);
}
/** Both ends of a ramp: the easiest and hardest value it takes. */
const ends = (r: Ramp): [number, number] => (typeof r === "number" ? [r, r] : [r.first, r.last]);

/** Settings with every ramp read at one round. */
export type Resolved<S> = { [K in keyof S]: Exclude<S[K], undefined> extends Ramp ? (undefined extends S[K] ? number | undefined : number) : S[K] };

const isRamp = (v: unknown): v is { first: number; last: number } =>
  !!v && typeof v === "object" && !Array.isArray(v) && "first" in v && "last" in v;

/** Every ramp in a settings block read at a round; other values as they are. */
export function resolveAt<S extends Record<string, unknown>>(settings: S, roundIdx: number, rounds: number): Resolved<S> {
  return Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, isRamp(v) ? atRound(v, roundIdx, rounds) : v])) as Resolved<S>;
}

/** Linear step from `from` at level 0 to `to` at level 1, rounded. What the defaults scale by. */
export const scaleLevel = (level: number, from: number, to: number) => Math.round(from + (to - from) * Math.min(1, Math.max(0, level)));

// ---------------------------------------------------------------- shared pieces

/** Seconds for a round of this type; absent means the stage's seconds. */
const seconds = ramp(3, 120).optional();

/** Which ways words may run in a letter grid: right and down; plus the two forward diagonals; or all eight, backwards included. */
export const CLIMB_DIRECTIONS = ["straight", "straight_diagonal", "all"] as const;
export type ClimbDirections = (typeof CLIMB_DIRECTIONS)[number];
const directions = z.enum(CLIMB_DIRECTIONS);

/** Quick maths forms, and the level at which each is on by default. */
export const QUICK_MATHS_FORMS = {
  add: { label: "a + b", level: 0 },
  subtract: { label: "a − b", level: 0 },
  multiply: { label: "a × b (to 12)", level: 0.25 },
  divide: { label: "a ÷ b", level: 0.5 },
  multiply_add: { label: "a × b + c", level: 0.5 },
  bracket: { label: "(a + b) × c", level: 0.75 },
  big_multiply: { label: "a × b (11–25)", level: 0.75 },
} as const;
export type QuickMathsForm = keyof typeof QUICK_MATHS_FORMS;
const QUICK_MATHS_FORM_IDS = Object.keys(QUICK_MATHS_FORMS) as [QuickMathsForm, ...QuickMathsForm[]];

/** Pattern difficulty 1–5: 1 is plain steps; 2 adds doubling and alternating steps; 3 squares and Fibonacci; 4 growing steps. */
export const PATTERN_DIFFICULTY = { min: 1, max: 5 } as const;

const MS_PER_SECOND = 1000;

// ---------------------------------------------------------------- per-type settings

const settingsSchemas = {
  pattern: z.object({ difficulty: ramp(PATTERN_DIFFICULTY.min, PATTERN_DIFFICULTY.max), seconds }).strict(),
  scramble: z.object({ minLength: ramp(3, 12), maxLength: ramp(3, 12), seconds }).strict(),
  word_hunt: z.object({ gridSize: ramp(4, 10), find: ramp(1, 8), minLength: z.number().int().min(2).max(6), directions, seconds }).strict(),
  quick_maths: z.object({ forms: z.array(z.enum(QUICK_MATHS_FORM_IDS)).min(1), seconds }).strict(),
  memory: z.object({ length: ramp(2, 12), symbols: z.number().int().min(2).max(9), msPerSymbol: ramp(200, 1500), seconds }).strict(),
  /** Seconds to repeat, after the pattern has been shown (length × ms per tile). Absent: the stage's seconds. */
  pattern_recall: z.object({ gridSize: ramp(3, 5), length: ramp(2, 25), msPerTile: ramp(200, 1500), secondsToRepeat: seconds }).strict(),
  /** The round lasts seconds per word × the words actually placed. */
  word_search: z.object({ gridSize: ramp(6, 12), words: ramp(3, 10), minLength: ramp(3, 12), maxLength: ramp(3, 12), directions, secondsPerWord: ramp(3, 120) }).strict(),
} satisfies Record<ClimbGameType, z.ZodObject<any>>;

export type ClimbGameSettings<T extends ClimbGameType = ClimbGameType> = z.infer<(typeof settingsSchemas)[T]>;
/** A type's settings with every ramp read at one round: what a generator gets. */
export type ResolvedClimbSettings<T extends ClimbGameType = ClimbGameType> = Resolved<ClimbGameSettings<T>>;

interface SettingsSpec<T extends ClimbGameType> {
  schema: (typeof settingsSchemas)[T];
  /** The defaults for a stage at `level`. Today's five types reproduce their behaviour before settings existed. */
  defaults(level: number): ClimbGameSettings<T>;
  /** Settings that fit their bounds but not each other. */
  check?(s: ClimbGameSettings<T>): { path: string; message: string }[];
  /** A round's clock with these settings. `placed`: units the round actually holds (word search's words), when fewer than asked for. */
  seconds(s: ResolvedClimbSettings<T>, stageSeconds: number, placed?: number): number;
}

const ownSeconds = (s: { seconds?: number }, stageSeconds: number) => s.seconds ?? stageSeconds;

const minNotOverMax = (s: { minLength: Ramp; maxLength: Ramp }) => {
  const [minA, minB] = ends(s.minLength), [maxA, maxB] = ends(s.maxLength);
  return minA > maxA || minB > maxB ? [{ path: "minLength", message: "shortest word can't be longer than the longest" }] : [];
};

export const climbGameSettings: { [T in ClimbGameType]: SettingsSpec<T> } = {
  pattern: {
    schema: settingsSchemas.pattern,
    defaults: (level) => ({ difficulty: scaleLevel(level, PATTERN_DIFFICULTY.min, PATTERN_DIFFICULTY.max) }),
    seconds: ownSeconds,
  },
  scramble: {
    schema: settingsSchemas.scramble,
    defaults: (level) => { const n = scaleLevel(level, 4, 7); return { minLength: n, maxLength: n + 1 }; },
    check: minNotOverMax,
    seconds: ownSeconds,
  },
  word_hunt: {
    schema: settingsSchemas.word_hunt,
    defaults: (level) => ({ gridSize: scaleLevel(level, 6, 8), find: scaleLevel(level, 2, 4), minLength: 3, directions: level >= 0.5 ? "all" : "straight" }),
    seconds: ownSeconds,
  },
  quick_maths: {
    schema: settingsSchemas.quick_maths,
    defaults: (level) => ({ forms: QUICK_MATHS_FORM_IDS.filter((f) => QUICK_MATHS_FORMS[f].level <= level) }),
    seconds: ownSeconds,
  },
  memory: {
    schema: settingsSchemas.memory,
    defaults: (level) => ({ length: scaleLevel(level, 3, 8), symbols: 4, msPerSymbol: 600 }),
    seconds: ownSeconds,
  },
  pattern_recall: {
    schema: settingsSchemas.pattern_recall,
    defaults: (level) => ({ gridSize: scaleLevel(level, 3, 5), length: { first: 3, last: 6 }, msPerTile: 600 }),
    // Never longer than the tiles on the grid, so the show time uses the capped length.
    seconds: (s, stageSeconds) => (Math.min(s.length, s.gridSize ** 2) * s.msPerTile) / MS_PER_SECOND + (s.secondsToRepeat ?? stageSeconds),
  },
  word_search: {
    schema: settingsSchemas.word_search,
    defaults: (level) => ({
      gridSize: scaleLevel(level, 6, 10), words: scaleLevel(level, 4, 8), minLength: 3, maxLength: scaleLevel(level, 6, 9),
      directions: level >= 0.75 ? "all" : level >= 0.5 ? "straight_diagonal" : "straight", secondsPerWord: scaleLevel(level, 30, 15),
    }),
    check: minNotOverMax,
    seconds: (s, _stageSeconds, placed = s.words) => placed * s.secondsPerWord,
  },
};

/** What a stage may hold: a block per type, each setting optional (missing ones come from the defaults). */
export const climbStageSettingsInputSchema = z.object({
  pattern: settingsSchemas.pattern.partial().optional(),
  scramble: settingsSchemas.scramble.partial().optional(),
  word_hunt: settingsSchemas.word_hunt.partial().optional(),
  quick_maths: settingsSchemas.quick_maths.partial().optional(),
  memory: settingsSchemas.memory.partial().optional(),
  pattern_recall: settingsSchemas.pattern_recall.partial().optional(),
  word_search: settingsSchemas.word_search.partial().optional(),
} satisfies Record<ClimbGameType, z.ZodTypeAny>).strict();
export type ClimbStageSettings = { [T in ClimbGameType]?: ClimbGameSettings<T> };

const merged = <T extends ClimbGameType>(type: T, given: Partial<ClimbGameSettings<T>> | undefined, level: number) =>
  ({ ...climbGameSettings[type].defaults(level), ...Object.fromEntries(Object.entries(given ?? {}).filter(([, v]) => v !== undefined)) });

/** A type's full settings for a stage: the defaults at its level, overlaid with what the admin set. */
export const fillSettings = <T extends ClimbGameType>(type: T, given: Partial<ClimbGameSettings<T>> | undefined, level: number): ClimbGameSettings<T> =>
  climbGameSettings[type].schema.parse(merged(type, given, level)) as ClimbGameSettings<T>;

/** Problems between a block's settings, as paths within the block. None if a setting is already out of bounds (that's reported on its own). */
export function checkSettings<T extends ClimbGameType>(type: T, given: Partial<ClimbGameSettings<T>> | undefined, level: number) {
  const filled = climbGameSettings[type].schema.safeParse(merged(type, given, level));
  return filled.success ? climbGameSettings[type].check?.(filled.data as ClimbGameSettings<T>) ?? [] : [];
}

/** A type's settings in a stage, read at one round (0-based). */
export const settingsAtRound = <T extends ClimbGameType>(s: ClimbGameSettings<T>, roundIdx: number, rounds: number): ResolvedClimbSettings<T> =>
  resolveAt(s as Record<string, unknown>, roundIdx, rounds) as ResolvedClimbSettings<T>;

/** The longest a round of this type can run with these settings, in whole seconds (the server's clock rounds up). */
export const maxRoundSeconds = <T extends ClimbGameType>(type: T, s: ResolvedClimbSettings<T>, stageSeconds: number) =>
  Math.ceil(climbGameSettings[type].seconds(s, stageSeconds));

/** A round's clock once generated, given what it actually holds (e.g. the words placed), in whole seconds. */
export const roundSecondsFor = <T extends ClimbGameType>(type: T, s: ResolvedClimbSettings<T>, stageSeconds: number, placed?: number) =>
  Math.ceil(climbGameSettings[type].seconds(s, stageSeconds, placed));

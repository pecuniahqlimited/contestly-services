/**
 * The Climb's word list: one admin-managed list that scramble, word search and word hunt draw from. A word
 * is lowercase letters only, 3–12 long, and passes the same safety filter as questions.
 */
import { z } from "zod";
import { checkSafety } from "./safety.js";

/** The games that take their words from the list. */
export const CLIMB_WORD_GAMES = ["scramble", "word_search", "word_hunt"] as const;
export type ClimbWordGame = (typeof CLIMB_WORD_GAMES)[number];

export const CLIMB_WORD_LENGTH = { min: 3, max: 12 } as const;
const THEME_MAX = 30;
/** Most lines one paste may add. */
export const CLIMB_WORDS_PASTE_MAX = 500;

/** A word as the generators see it. */
export interface ClimbWordEntry { word: string; games: readonly ClimbWordGame[] }

export type WordCheck = { ok: true; word: string } | { ok: false; error: "not_letters" | "too_short" | "too_long" | "not_allowed" };

/** Normalise (trim, lowercase) and check a word for the list. */
export function checkClimbWord(raw: string): WordCheck {
  const word = raw.trim().toLowerCase();
  if (!/^[a-z]+$/.test(word)) return { ok: false, error: "not_letters" };
  if (word.length < CLIMB_WORD_LENGTH.min) return { ok: false, error: "too_short" };
  if (word.length > CLIMB_WORD_LENGTH.max) return { ok: false, error: "too_long" };
  if (!checkSafety({ topic: "", exclusions: [] }, word).passed) return { ok: false, error: "not_allowed" };
  return { ok: true, word };
}

const gamesSchema = z.array(z.enum(CLIMB_WORD_GAMES)).min(1).refine((g) => new Set(g).size === g.length, { message: "a game is listed twice" });
const themeSchema = z.string().trim().toLowerCase().min(1).max(THEME_MAX).nullable();

export const climbWordSchema = z.object({
  id: z.string().uuid(),
  word: z.string(),
  active: z.boolean(),
  games: z.array(z.enum(CLIMB_WORD_GAMES)),
  theme: z.string().nullable(),
  /** Null for the starter list. */
  addedBy: z.object({ id: z.string().uuid(), handle: z.string() }).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ClimbWord = z.infer<typeof climbWordSchema>;

/** GET /admin/climb/words?game=&theme=&length=&active=&q=&offset= */
export const climbWordsQuerySchema = z.object({
  game: z.enum(CLIMB_WORD_GAMES).optional(),
  theme: z.string().trim().toLowerCase().optional(),
  length: z.coerce.number().int().min(CLIMB_WORD_LENGTH.min).max(CLIMB_WORD_LENGTH.max).optional(),
  active: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  /** Words starting with this. */
  q: z.string().trim().toLowerCase().max(CLIMB_WORD_LENGTH.max).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export const climbWordsResponseSchema = z.object({
  words: z.array(climbWordSchema),
  total: z.number().int(),
  /** Active words per game, the supply the ladder editor's warnings count. */
  activeByGame: z.record(z.enum(CLIMB_WORD_GAMES), z.number().int()),
});

/** POST /admin/climb/words: one word, or many pasted one per line. Every word added gets the same games and theme. */
export const addClimbWordsBodySchema = z.object({
  /** One word, or many separated by newlines (commas work too). */
  text: z.string().min(1).max(CLIMB_WORDS_PASTE_MAX * (CLIMB_WORD_LENGTH.max + 2)),
  games: gamesSchema.default([...CLIMB_WORD_GAMES]),
  theme: themeSchema.optional(),
});
export const CLIMB_WORD_ADD_RESULTS = ["added", "exists", "invalid", "duplicate"] as const;
/** One result per non-empty line, in order. `exists`: already on the list (left as it is). `duplicate`: earlier in the same paste. */
export const addClimbWordsResponseSchema = z.object({
  results: z.array(z.object({ line: z.number().int(), input: z.string(), word: z.string().nullable(), result: z.enum(CLIMB_WORD_ADD_RESULTS), error: z.string().nullable() })),
  added: z.number().int(),
});

/** PATCH /admin/climb/words/:id: change games, theme, or switch it off/on. Logged with a reason. */
export const editClimbWordBodySchema = z.object({
  games: gamesSchema.optional(),
  theme: themeSchema.optional(),
  active: z.boolean().optional(),
  reason: z.string().trim().min(1).max(500),
}).refine((b) => b.games !== undefined || b.theme !== undefined || b.active !== undefined, { message: "nothing to change" });

/** Split a paste into its non-empty lines (newlines or commas), keeping each line's 1-based number. */
export function splitWordLines(text: string): { line: number; input: string }[] {
  return text.split(/[\n,]/).map((input, i) => ({ line: i + 1, input: input.trim() })).filter((l) => l.input.length > 0);
}

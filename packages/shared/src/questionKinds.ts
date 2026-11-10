/** Question formats and difficulties — one source of truth for the engine, the game rules and the app. */
export const QUESTION_FORMATS = ["pick_one", "pick_all", "order", "match", "picture"] as const;
export type QuestionFormat = (typeof QUESTION_FORMATS)[number];

export const DIFFICULTIES = ["easy", "mixed", "hard", "brutal"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/**
 * Picture rounds are capped (ADR 0016): at most a quarter of a set's play order, rounded down, so a set under four
 * questions has none. Every question a party holds that isn't voided (the play order and its reserves together)
 * stays within the cap of its play order, so promoting a reserve or swapping one in can never pass it.
 */
export const PICTURE_SHARE = 0.25;
export const pictureCap = (setSize: number) => Math.max(0, Math.floor(setSize * PICTURE_SHARE));

/**
 * The reserve a void promotes into the play order: the first, unless it's a picture and the play order already holds
 * its cap of pictures (voided ones count: they were shown), then the first that isn't. Null when none fits.
 */
export function promotableReserve<T extends { format: string }>(reserves: T[], playOrder: { format: string }[], setSize: number): T | null {
  const full = playOrder.filter((q) => q.format === "picture").length >= pictureCap(setSize);
  return reserves.find((r) => !full || r.format !== "picture") ?? null;
}

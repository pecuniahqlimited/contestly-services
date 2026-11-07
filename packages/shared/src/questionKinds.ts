/** Question formats and difficulties — one source of truth for the engine, the game rules and the app. */
export const QUESTION_FORMATS = ["pick_one", "pick_all", "order", "match", "picture"] as const;
export type QuestionFormat = (typeof QUESTION_FORMATS)[number];

export const DIFFICULTIES = ["easy", "mixed", "hard", "brutal"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

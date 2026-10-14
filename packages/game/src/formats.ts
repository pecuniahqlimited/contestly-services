/**
 * The format catalogue: every question format declares its server payload (answers included),
 * the public view sent to clients (answers stripped), the player answer shape, and a grader
 * returning correctness in [0, 1]. Extending the game with a new format means adding one entry.
 *
 * Correct answers never appear in a public view; `publicView()` is the only shape a client may
 * see before the question closes.
 */
import { z } from "zod";

export const QUESTION_FORMATS = ["pick_one", "pick_all", "order", "match", "picture"] as const;
export type QuestionFormat = (typeof QUESTION_FORMATS)[number];

const options = z.array(z.string().min(1)).min(2).max(6);
const indexes = z.array(z.number().int().min(0)).min(1);

export const payloadSchemas = {
  pick_one: z.object({
    question: z.string().min(1),
    options,
    correctIndex: z.number().int().min(0),
  }),
  pick_all: z.object({
    question: z.string().min(1),
    options,
    correctIndexes: indexes,
  }),
  /** `items` is the display order (pre-shuffled by the author/generator); `correctOrder` lists item indexes in the right sequence. */
  order: z.object({
    question: z.string().min(1),
    items: z.array(z.string().min(1)).min(3).max(6),
    correctOrder: indexes,
  }),
  /** `right` is pre-shuffled; `pairs[i]` is the index into `right` that matches `left[i]`. */
  match: z.object({
    question: z.string().min(1),
    left: z.array(z.string().min(1)).min(2).max(6),
    right: z.array(z.string().min(1)).min(2).max(6),
    pairs: indexes,
  }),
  /** An image with a caption, then pick one. Images come from a licensed/generated pool with alt text. */
  picture: z.object({
    question: z.string().min(1),
    imageUrl: z.string().min(1),
    imageAlt: z.string().min(1),
    options,
    correctIndex: z.number().int().min(0),
  }),
} as const;

export const answerSchemas = {
  pick_one: z.object({ index: z.number().int().min(0).max(5) }),
  pick_all: z.object({ indexes: z.array(z.number().int().min(0).max(5)).max(6) }),
  order: z.object({ order: z.array(z.number().int().min(0).max(5)).max(6) }),
  match: z.object({ pairs: z.array(z.number().int().min(0).max(5)).max(6) }),
  picture: z.object({ index: z.number().int().min(0).max(5) }),
} as const;

export type Payload<F extends QuestionFormat = QuestionFormat> = z.infer<(typeof payloadSchemas)[F]>;
export type Answer<F extends QuestionFormat = QuestionFormat> = z.infer<(typeof answerSchemas)[F]>;

/** What a client is allowed to see while the question is open. */
export function publicView(format: QuestionFormat, payload: unknown): Record<string, unknown> {
  const p = payloadSchemas[format].parse(payload);
  switch (format) {
    case "pick_one":
    case "picture": {
      const { correctIndex: _hidden, ...pub } = p as Payload<"picture"> & Payload<"pick_one">;
      return pub;
    }
    case "pick_all": {
      const { correctIndexes: _hidden, ...pub } = p as Payload<"pick_all">;
      return pub;
    }
    case "order": {
      const { correctOrder: _hidden, ...pub } = p as Payload<"order">;
      return pub;
    }
    case "match": {
      const { pairs: _hidden, ...pub } = p as Payload<"match">;
      return pub;
    }
  }
}

/** The correct answer in a reveal-safe shape, sent only after the question closes. */
export function revealAnswer(format: QuestionFormat, payload: unknown): Record<string, unknown> {
  const p = payloadSchemas[format].parse(payload);
  switch (format) {
    case "pick_one":
    case "picture":
      return { correctIndex: (p as Payload<"pick_one">).correctIndex };
    case "pick_all":
      return { correctIndexes: (p as Payload<"pick_all">).correctIndexes };
    case "order":
      return { correctOrder: (p as Payload<"order">).correctOrder };
    case "match":
      return { pairs: (p as Payload<"match">).pairs };
  }
}

/**
 * Grade an answer: correctness in [0, 1]. A malformed answer grades 0 rather than throwing,
 * so one bad client can never stall a round.
 */
export function grade(format: QuestionFormat, payload: unknown, answer: unknown): number {
  const p = payloadSchemas[format].parse(payload);
  const parsed = answerSchemas[format].safeParse(answer);
  if (!parsed.success) return 0;

  switch (format) {
    case "pick_one":
    case "picture": {
      const a = parsed.data as Answer<"pick_one">;
      return a.index === (p as Payload<"pick_one">).correctIndex ? 1 : 0;
    }
    case "pick_all": {
      // Partial credit: each correct pick earns, each wrong pick subtracts, floored at 0.
      const { correctIndexes } = p as Payload<"pick_all">;
      const picks = [...new Set((parsed.data as Answer<"pick_all">).indexes)];
      const correctSet = new Set(correctIndexes);
      const right = picks.filter((i) => correctSet.has(i)).length;
      const wrong = picks.length - right;
      return Math.max(0, (right - wrong) / correctIndexes.length);
    }
    case "order": {
      // Scored per correct position.
      const { correctOrder } = p as Payload<"order">;
      const a = (parsed.data as Answer<"order">).order;
      if (a.length !== correctOrder.length) return 0;
      const right = correctOrder.filter((item, pos) => a[pos] === item).length;
      return right / correctOrder.length;
    }
    case "match": {
      // Scored per correct pair.
      const { pairs } = p as Payload<"match">;
      const a = (parsed.data as Answer<"match">).pairs;
      if (a.length !== pairs.length) return 0;
      const right = pairs.filter((r, i) => a[i] === r).length;
      return right / pairs.length;
    }
  }
}

/** Option-based formats get a per-option answer distribution in the reveal. */
export function isOptionFormat(format: QuestionFormat): boolean {
  return format === "pick_one" || format === "picture" || format === "pick_all";
}

/** Count answers per option for the reveal bars. pick_all answers count each picked option. */
export function distribution(format: QuestionFormat, payload: unknown, answers: unknown[]): number[] | null {
  if (!isOptionFormat(format)) return null;
  const p = payloadSchemas[format].parse(payload) as { options: string[] };
  const counts = p.options.map(() => 0);
  for (const raw of answers) {
    const parsed = answerSchemas[format].safeParse(raw);
    if (!parsed.success) continue;
    const data = parsed.data as Answer<"pick_one"> | Answer<"pick_all">;
    const picks = "index" in data ? [data.index] : [...new Set(data.indexes)];
    for (const i of picks) if (i < counts.length) counts[i]++;
  }
  return counts;
}

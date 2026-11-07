/**
 * One template per question format (a registry: adding a format adds an entry): what to ask the model for,
 * the JSON schema of one item, and how an item becomes the game payload. The model always gives the right
 * answer apart from the wrong ones; we place and shuffle (shuffle.ts). Counts the schema can't enforce are
 * checked here; an item that fails them is dropped, never repaired.
 */
import type { QuestionFormat } from "@contestly/shared";
import type { PoolImage } from "../imagePool.js";
import { derangedOrder, permutation } from "./shuffle.js";

type Item = Record<string, unknown>;
export interface Mapped {
  payload: Record<string, unknown>;
}

export interface FormatTemplate {
  /** What this format is and the rules particular to it, added to the shared instructions. */
  instructions: string;
  /** The format's own fields of one item (the shared ones are added by the generator). */
  fields(ctx: { images: PoolImage[] }): Record<string, unknown>;
  /** The item as a payload, or why it can't be one. */
  toPayload(item: Item, ctx: { images: PoolImage[] }): Mapped | { error: string };
}

const str = { type: "string" };
const strs = { type: "array", items: str };
const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim()) ? v.map((x) => (x as string).trim()) : null);
const distinct = (xs: string[]) => new Set(xs.map((x) => x.toLowerCase())).size === xs.length;

/** The answer placed among the distractors, in a seeded order. */
function placeAmong(question: string, answer: string, distractors: string[]) {
  const all = [answer, ...distractors];
  const order = permutation(all.length, question);
  return { options: order.map((i) => all[i]), correctIndex: order.indexOf(0) };
}

const pickOneLike = (item: Item): { question: string; options: string[]; correctIndex: number } | { error: string } => {
  const question = String(item.question ?? "").trim();
  const answer = String(item.answer ?? "").trim();
  const distractors = strings(item.distractors);
  if (!question || !answer || !distractors) return { error: "missing question, answer or distractors" };
  if (distractors.length !== 3) return { error: `${distractors.length} distractors, need 3` };
  if (!distinct([answer, ...distractors])) return { error: "options repeat" };
  return { question, ...placeAmong(question, answer, distractors) };
};

export const FORMAT_TEMPLATES: Record<QuestionFormat, FormatTemplate> = {
  pick_one: {
    instructions: "Format: pick one. A question with exactly one correct answer and exactly three wrong options (distractors).",
    fields: () => ({ answer: str, distractors: strs }),
    toPayload: (item) => {
      const p = pickOneLike(item);
      return "error" in p ? p : { payload: p };
    },
  },
  pick_all: {
    instructions:
      "Format: pick all that apply. Exactly four options; two or three of them are correct, the rest are wrong. " +
      "The question must make clear that more than one may apply (e.g. \"Which of these…\"), and every option must be clearly in or out.",
    fields: () => ({ correct: strs, incorrect: strs }),
    toPayload: (item) => {
      const question = String(item.question ?? "").trim();
      const correct = strings(item.correct);
      const incorrect = strings(item.incorrect);
      if (!question || !correct || !incorrect) return { error: "missing question or options" };
      if (correct.length < 2 || correct.length > 3 || correct.length + incorrect.length !== 4) return { error: `${correct.length} correct + ${incorrect.length} wrong, need 2–3 of 4` };
      const all = [...correct, ...incorrect];
      if (!distinct(all)) return { error: "options repeat" };
      const order = permutation(all.length, question);
      const options = order.map((i) => all[i]);
      const correctIndexes = order.flatMap((orig, pos) => (orig < correct.length ? [pos] : [])).sort((a, b) => a - b);
      return { payload: { question, options, correctIndexes } };
    },
  },
  order: {
    instructions:
      "Format: put in order. Exactly four items and a question that names the ordering rule and its direction (\"earliest first\", \"largest first\"). " +
      "Give the items in the correct order; we shuffle them. The order must be a matter of record (dates, sizes, sequence), never opinion, with no ties.",
    fields: () => ({ itemsInOrder: strs }),
    toPayload: (item) => {
      const question = String(item.question ?? "").trim();
      const inOrder = strings(item.itemsInOrder);
      if (!question || !inOrder) return { error: "missing question or items" };
      if (inOrder.length !== 4) return { error: `${inOrder.length} items, need 4` };
      if (!distinct(inOrder)) return { error: "items repeat" };
      // display[k] = inOrder[shown[k]]; correctOrder lists display indexes in the right sequence.
      const shown = derangedOrder(inOrder.length, question);
      const items = shown.map((i) => inOrder[i]);
      const correctOrder = inOrder.map((_, rank) => shown.indexOf(rank));
      return { payload: { question, items, correctOrder } };
    },
  },
  match: {
    instructions:
      "Format: match pairs. Exactly three or four pairs, each left item matching exactly one right item and no right item fitting two left ones. " +
      "The question says what links them (\"Match the artist to the song\"). Keep each side the same kind of thing.",
    fields: () => ({ pairs: { type: "array", items: { type: "object", additionalProperties: false, required: ["left", "right"], properties: { left: str, right: str } } } }),
    toPayload: (item) => {
      const question = String(item.question ?? "").trim();
      const raw = Array.isArray(item.pairs) ? (item.pairs as Item[]) : null;
      if (!question || !raw) return { error: "missing question or pairs" };
      const left = strings(raw.map((p) => p.left));
      const right = strings(raw.map((p) => p.right));
      if (!left || !right) return { error: "a pair is missing a side" };
      if (left.length < 3 || left.length > 4) return { error: `${left.length} pairs, need 3–4` };
      if (!distinct(left) || !distinct(right)) return { error: "pairs repeat" };
      const shown = derangedOrder(right.length, question);
      return { payload: { question, left, right: shown.map((i) => right[i]), pairs: left.map((_, i) => shown.indexOf(i)) } };
    },
  },
  picture: {
    instructions:
      "Format: picture round. Each question is about one image from the image list below, named by its imageId; the player sees the image, " +
      "so the question must be answerable from what the image shows plus general knowledge (the image's subject is the answer or leads to it). " +
      "Exactly one correct answer and three wrong options of the same kind. Never refer to an image that isn't in the list. Use each image at most once.",
    fields: ({ images }) => ({ imageId: { type: "string", enum: images.map((i) => i.id) }, answer: str, distractors: strs }),
    toPayload: (item, { images }) => {
      const image = images.find((i) => i.id === item.imageId);
      if (!image) return { error: "image not in the pool" };
      const p = pickOneLike(item);
      return "error" in p ? p : { payload: { question: p.question, imageUrl: image.url, imageAlt: image.alt, options: p.options, correctIndex: p.correctIndex } };
    },
  },
};

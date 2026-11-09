/**
 * What POST /parties carries from party templates (ADR 0015): a host-written question and the template it was made
 * from. Kept apart from templates.ts so the root's createPartySchema doesn't pull the whole templates contract (its
 * config, rules and the safety filter) into the app's startup; templates.ts re-exports all of it.
 */
import { z } from "zod";

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

/** A template's id (and an occasion's): lowercase letters, digits, _ or -. */
export const templateIdSchema = z.string().trim().regex(/^[a-z0-9_-]{1,40}$/, "lowercase letters, digits, _ or -");

/** POST /parties `template`: which template, and the version the builder showed (it must still exist in that version). */
export const templateRefSchema = z.object({ id: templateIdSchema, version: z.number().int().positive() });
export type TemplateRef = z.infer<typeof templateRefSchema>;

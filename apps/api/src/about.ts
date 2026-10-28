/**
 * About you (ADR 0009): a person's answers are checked against the version they were given, stored
 * with it, and turned into lanes and an archetype here. Changing the config never reaches back into
 * these rows; editing from Me answers the current version.
 */
import { eq } from "drizzle-orm";
import { aboutConfigVersion, currentAboutConfig, db, users, type AboutConfigRow, type User } from "@contestly/db";
import {
  answerProblems, deriveAbout, meAboutSchema, prefillAnswers, type AboutAnswers, type AboutAudience, type AboutVersion, type MeAbout, type Who,
} from "@contestly/shared";
import { httpError } from "./httpError.js";

/** Which set someone answers: brands the brand one, everyone else (not asked yet included) the person one. */
export const audienceOf = (who: string | null): AboutAudience => (who === "brand" ? "brand" : "person");

export const aboutView = (row: AboutConfigRow): AboutVersion => ({ audience: row.audience, version: row.version, config: row.config, createdAt: row.createdAt.toISOString() });

/** Answers against `version` of the user's set: refused (422) unless complete and valid; then stored with what they give. */
export async function answerAbout(u: User, version: number, answers: AboutAnswers): Promise<User> {
  const audience = audienceOf(u.who);
  const row = await aboutConfigVersion(audience, version);
  if (!row) throw httpError(422, "unknown_about_version");
  const problems = answerProblems(row.config, answers);
  if (problems.length) throw httpError(422, "invalid_answers", problems);
  const { lanes, archetype } = deriveAbout(audience, row.config, answers);
  const [saved] = await db.update(users)
    .set({ aboutAudience: audience, aboutVersion: version, aboutAnswers: answers, aboutAnsweredAt: new Date(), archetype, interests: lanes })
    .where(eq(users.id, u.id)).returning();
  return saved;
}

/**
 * Who's playing. Switching between person and brand means a different About you set, so answers to
 * the other set (and the archetype they gave) are cleared; lanes stay.
 */
export async function setWho(u: User, who: Who): Promise<User> {
  const otherSet = u.aboutAudience !== null && u.aboutAudience !== audienceOf(who);
  const [saved] = await db.update(users)
    .set({ who, ...(otherSet ? { aboutAudience: null, aboutVersion: null, aboutAnswers: null, aboutAnsweredAt: null, archetype: null } : {}) })
    .where(eq(users.id, u.id)).returning();
  return saved;
}

/** GET /me/onboarding: their answers and version, what they gave, and the current set to edit against. */
export async function meAbout(u: User): Promise<MeAbout> {
  const audience = audienceOf(u.who);
  const current = await currentAboutConfig(audience);
  const answered = u.aboutVersion !== null && u.aboutAnswers && u.aboutAnsweredAt
    ? { version: u.aboutVersion, answers: u.aboutAnswers, answeredAt: u.aboutAnsweredAt.toISOString() } : null;
  const prefill = prefillAnswers(current.config, answered?.answers ?? null);
  return meAboutSchema.parse({
    audience, answered, lanes: u.interests, archetype: u.archetype, current: aboutView(current), prefill,
    hasNewQuestions: !!answered && answered.version !== current.version && answerProblems(current.config, prefill).length > 0,
  });
}

/**
 * Sim data. The sims send the dev-only x-dev-sim header; the account it marks (users.is_sim) marks the
 * parties it creates and its corner. Suggestions, the Parties tab and nudge targeting show sim data only to
 * sim viewers (so a sim can still see what it made), never to real people.
 */
import { and, eq, type AnyColumn } from "drizzle-orm";
import { db } from "./client.js";
import { users, type User } from "./schema.js";

/** A where-clause part: nothing for a sim viewer, "not sim data" for everyone else. */
export const simVisibleTo = (viewer: Pick<User, "isSim"> | null | undefined, isSimColumn: AnyColumn) =>
  viewer?.isSim ? undefined : eq(isSimColumn, false);

/** Marks a dev account as a sim's, once. Only the dev auth path calls it. */
export async function markSimUser(user: User): Promise<User> {
  if (user.isSim) return user;
  const [u] = await db.update(users).set({ isSim: true }).where(and(eq(users.id, user.id), eq(users.isSim, false))).returning();
  return u ?? { ...user, isSim: true };
}

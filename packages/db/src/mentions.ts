import { and, inArray } from "drizzle-orm";
import { mentionedHandles } from "@contestly/shared";
import { db } from "./client.js";
import { users } from "./schema.js";
import { liveUser } from "./accounts.js";
import { notBlockedWith } from "./safety/people.js";

/**
 * The handles in a line that belong to real, live people (not system or deleted accounts), for its mentions. Someone
 * blocked either way with the writer isn't resolved: they can't be tagged (ADR 0014).
 */
export async function resolveMentions(text: string | undefined, writerId: string): Promise<string[]> {
  const handles = text ? mentionedHandles(text) : [];
  if (!handles.length) return [];
  const rows = await db.select({ handle: users.handle, isSystem: users.isSystem }).from(users).where(and(inArray(users.handle, handles), liveUser, notBlockedWith(writerId, users.id)));
  return rows.filter((r) => !r.isSystem).map((r) => r.handle);
}

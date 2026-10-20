import { inArray } from "drizzle-orm";
import { mentionedHandles } from "@contestly/shared";
import { db } from "./client.js";
import { users } from "./schema.js";

/** The handles in a chat line that belong to real people (not system accounts), for chat_messages.mentions. */
export async function resolveMentions(text: string | undefined): Promise<string[]> {
  const handles = text ? mentionedHandles(text) : [];
  if (!handles.length) return [];
  const rows = await db.select({ handle: users.handle, isSystem: users.isSystem }).from(users).where(inArray(users.handle, handles));
  return rows.filter((r) => !r.isSystem).map((r) => r.handle);
}

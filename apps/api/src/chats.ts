/**
 * Chats read-model: the Messages and Requests lists, the tab badge, and each party's thread for Chats ›
 * Parties. Lines are written only through postMessage (rooms) and systemLine; this file only reads, plus
 * publishing the API's own system lines to the room.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { chatMembers, chatMessages, chatThreads, db, lineDeliveries, users, voiceNotes } from "@contestly/db";
import { MY_RECENT_DAYS, UNREAD_CAP, type ChatMessage, type ChatPreview, type ChatUnread, type DmThread } from "@contestly/shared";
import { personColumns } from "./people.js";
import { valkey } from "./redis.js";

/** A line the API wrote (after its transaction committed) reaches rooms, open screens and, for DMs and crews, inboxes. */
export async function publishLine(message: ChatMessage) {
  for (const d of await lineDeliveries(message)) await valkey().publish(d.channel, JSON.stringify(d.payload));
}

const capped = (n: unknown) => Math.min(Number(n), UNREAD_CAP);

/** Lines after the member's last read, not their own. */
const unreadOf = (userId: string) =>
  sql<number>`(select count(*) from ${chatMessages} x where x.thread_id = ${chatMembers.threadId} and x.created_at > ${chatMembers.lastReadAt} and x.user_id is distinct from ${userId})`;

/** Each thread's last line, for list rows. */
export async function previews(threadIds: string[]): Promise<Map<string, ChatPreview>> {
  if (!threadIds.length) return new Map();
  const rows = await db.selectDistinctOn([chatMessages.threadId], {
    threadId: chatMessages.threadId, kind: chatMessages.kind, text: chatMessages.text, sticker: chatMessages.sticker, createdAt: chatMessages.createdAt,
    handle: users.handle, displayName: users.displayName, voiceDurationMs: voiceNotes.durationMs,
  }).from(chatMessages).leftJoin(users, eq(users.id, chatMessages.userId)).leftJoin(voiceNotes, eq(voiceNotes.id, chatMessages.voiceNoteId))
    .where(inArray(chatMessages.threadId, threadIds)).orderBy(chatMessages.threadId, desc(chatMessages.createdAt));
  return new Map(rows.map((r) => [r.threadId, {
    author: r.handle && r.displayName ? { handle: r.handle, displayName: r.displayName } : null,
    kind: r.kind, text: r.text, sticker: r.sticker, voiceDurationMs: r.voiceDurationMs, createdAt: r.createdAt.toISOString(),
  }]));
}

/**
 * The viewer's DMs that have a line in them, newest first. `requests`: only the ones someone asked them
 * (Messages › Requests); otherwise everything else, their own pending requests included. Declined ones never show.
 */
export async function dmThreads(userId: string, which: "messages" | "requests"): Promise<DmThread[]> {
  const other = sql`(select o.user_id from ${chatMembers} o where o.thread_id = ${chatThreads.id} and o.user_id <> ${userId})`;
  const theirState = sql<string>`(select o.state from ${chatMembers} o where o.thread_id = ${chatThreads.id} and o.user_id <> ${userId})`;
  const rows = await db.select({ id: chatThreads.id, mine: chatMembers.state, theirs: theirState, unread: unreadOf(userId), with: personColumns })
    .from(chatThreads)
    .innerJoin(chatMembers, and(eq(chatMembers.threadId, chatThreads.id), eq(chatMembers.userId, userId)))
    .innerJoin(users, sql`${users.id} = ${other}`)
    .where(and(eq(chatThreads.kind, "dm"), sql`${chatThreads.lastMessageAt} is not null`, eq(chatMembers.state, which === "requests" ? "request" : "active")))
    .orderBy(desc(chatThreads.lastMessageAt));
  const last = await previews(rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id, with: r.with, unread: capped(r.unread), lastMessage: last.get(r.id) ?? null,
    request: r.mine !== "active" ? "received" : r.theirs !== "active" ? "sent" : "none",
  }));
}

/** The Chats tab badge. Parties count only those still in the viewer's Chats › Parties window. */
export async function unreadTotals(userId: string): Promise<ChatUnread> {
  const since = new Date(Date.now() - MY_RECENT_DAYS * 24 * 3_600_000).toISOString();
  const rows = await db.select({
    kind: chatThreads.kind, state: chatMembers.state,
    unread: sql<number>`sum(${unreadOf(userId)})`, threads: sql<number>`count(*)`,
  }).from(chatMembers).innerJoin(chatThreads, eq(chatThreads.id, chatMembers.threadId))
    .where(and(eq(chatMembers.userId, userId), sql`${chatThreads.lastMessageAt} is not null`,
      sql`(${chatThreads.kind} <> 'party' or ${chatThreads.lastMessageAt} >= ${since})`))
    .groupBy(chatThreads.kind, chatMembers.state);
  const total = { messages: 0, requests: 0, crews: 0, parties: 0 };
  for (const r of rows) {
    if (r.kind === "dm" && r.state === "active") total.messages += Number(r.unread);
    if (r.kind === "dm" && r.state === "request") total.requests += Number(r.threads);
    if (r.kind === "crew") total.crews += Number(r.unread);
    if (r.kind === "party") total.parties += Number(r.unread);
  }
  return { messages: capped(total.messages), requests: capped(total.requests), crews: capped(total.crews), parties: capped(total.parties) };
}

/** For Chats › Parties and Chats › Crews: each party's or crew's thread, its last line and the viewer's unread count (0 where they aren't a member). */
export async function threadsFor(kind: "party" | "crew", ownerIds: string[], userId: string) {
  if (!ownerIds.length) return new Map<string, { threadId: string; lastLine: ChatPreview | null; unread: number }>();
  const owner = kind === "party" ? chatThreads.partyId : chatThreads.crewId;
  const rows = await db.select({ ownerId: owner, threadId: chatThreads.id, unread: sql<number | null>`case when ${chatMembers.userId} is null then 0 else ${unreadOf(userId)} end` })
    .from(chatThreads).leftJoin(chatMembers, and(eq(chatMembers.threadId, chatThreads.id), eq(chatMembers.userId, userId)))
    .where(inArray(owner, ownerIds));
  const last = await previews(rows.map((r) => r.threadId));
  return new Map(rows.map((r) => [r.ownerId!, { threadId: r.threadId, lastLine: last.get(r.threadId) ?? null, unread: capped(r.unread ?? 0) }]));
}

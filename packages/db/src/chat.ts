/**
 * Chat persistence (ADR 0007): threads, members, and the one write path every line takes. Party rooms,
 * the inbox room, the API's system lines and the worker all come through here, so the rules (who may
 * write, message requests, masking, mentions, the client message id) live once.
 */
import { and, count, desc, eq, inArray, lt, ne, or, sql } from "drizzle-orm";
import { dmKey, dmPermission, maskProfanity, type ChatConfig, type ChatMessage, type DmPermission } from "@contestly/shared";
import { db, type Tx } from "./client.js";
import { chatMembers, chatMessages, chatThreads, follows, parties, partyPlayers, users, voiceNotes, type ChatThread, type User, type VoiceNote } from "./schema.js";
import { hostTeamOf } from "./host.js";
import { resolveMentions } from "./mentions.js";

type Conn = Tx | typeof db;

/** A refused chat action: `message` is the code clients see. */
export const chatError = (code: string, statusCode = 403) => Object.assign(new Error(code), { statusCode });

/** The author fields a line needs. Rooms keep these on the client; the API has the whole row. */
export type ChatSender = Pick<User, "id" | "handle" | "displayName" | "avatarEmoji" | "isVerified" | "isGuest" | "isBrand" | "isSystem">;

// ---- threads and members ---------------------------------------------------------------

/** The party's thread, made on first use. */
export async function partyThreadId(q: Conn, partyId: string): Promise<string> {
  const [made] = await q.insert(chatThreads).values({ kind: "party", partyId }).onConflictDoNothing({ target: chatThreads.partyId }).returning({ id: chatThreads.id });
  if (made) return made.id;
  const [row] = await q.select({ id: chatThreads.id }).from(chatThreads).where(eq(chatThreads.partyId, partyId));
  return row.id;
}

/** Put someone in a thread (no-op if they're in it). Their unread count starts from now. */
export async function joinThread(q: Conn, threadId: string, userId: string) {
  await q.insert(chatMembers).values({ threadId, userId }).onConflictDoNothing();
}

/** A seat or the host's team joins the party's chat. Returns the thread. */
export async function joinPartyThread(q: Conn, partyId: string, userId: string): Promise<string> {
  const threadId = await partyThreadId(q, partyId);
  await joinThread(q, threadId, userId);
  return threadId;
}

export async function threadById(id: string): Promise<ChatThread | undefined> {
  const [t] = await db.select().from(chatThreads).where(eq(chatThreads.id, id));
  return t;
}

export async function memberOf(q: Conn, threadId: string, userId: string) {
  const [m] = await q.select().from(chatMembers).where(and(eq(chatMembers.threadId, threadId), eq(chatMembers.userId, userId)));
  return m;
}

export async function markRead(threadId: string, userId: string, at = new Date()) {
  await db.update(chatMembers).set({ lastReadAt: at }).where(and(eq(chatMembers.threadId, threadId), eq(chatMembers.userId, userId)));
}

// ---- the DM rule -----------------------------------------------------------------------

const exists = (q: Conn, query: ReturnType<typeof sql>) => q.execute(sql`select exists(${query}) as yes`).then((r) => !!(r as unknown as { yes: boolean }[])[0]?.yes);

/** Loads the facts dmPermission() decides on. */
export async function dmPermissionBetween(q: Conn, sender: ChatSender, recipient: Pick<User, "id" | "isGuest" | "isSystem">): Promise<DmPermission> {
  if (sender.id === recipient.id) return "refused";
  const [recipientFollowsSender, playedTogether, joinedSendersParty] = await Promise.all([
    exists(q, sql`select 1 from ${follows} where follower_id = ${recipient.id} and followee_id = ${sender.id}`),
    exists(q, sql`select 1 from ${partyPlayers} a join ${partyPlayers} b on b.party_id = a.party_id join ${parties} p on p.id = a.party_id
                  where a.user_id = ${sender.id} and b.user_id = ${recipient.id} and p.status = 'finished'`),
    sender.isBrand
      ? q.select({ id: partyPlayers.partyId }).from(partyPlayers).innerJoin(parties, eq(parties.id, partyPlayers.partyId))
        .where(and(eq(partyPlayers.userId, recipient.id), hostTeamOf(sender.id))).limit(1).then((r) => r.length > 0)
      : false,
  ]);
  return dmPermission({
    sender, recipient, recipientFollowsSender, playedTogether, joinedSendersParty,
    shareCrew: false, // crews arrive in row 6b
  });
}

export type DmRequestState = "none" | "sent" | "received";
/** The viewer's side of a DM: their own row being `request` means someone asked them; the other's, that they asked. */
export const requestStateFor = (mine: { state: string }, theirs: { state: string } | undefined): DmRequestState =>
  mine.state !== "active" ? "received" : theirs && theirs.state !== "active" ? "sent" : "none";

/**
 * Open (or find) the DM between sender and recipient. A refused pair gets no thread. A request leaves the
 * recipient's side `request` until they accept or reply; if the rule now says direct (they followed back,
 * played together), a pending or declined side opens up.
 */
export async function openDm(sender: ChatSender, recipient: User) {
  const permission = await dmPermissionBetween(db, sender, recipient);
  if (permission === "refused") throw chatError(sender.id === recipient.id ? "cannot_message_self" : "cannot_message");
  return db.transaction(async (tx) => {
    const key = dmKey(sender.id, recipient.id);
    await tx.insert(chatThreads).values({ kind: "dm", dmKey: key }).onConflictDoNothing({ target: chatThreads.dmKey });
    const [thread] = await tx.select().from(chatThreads).where(eq(chatThreads.dmKey, key));
    await tx.insert(chatMembers).values([
      { threadId: thread.id, userId: sender.id },
      { threadId: thread.id, userId: recipient.id, state: permission === "direct" ? "active" : "request" },
    ]).onConflictDoNothing();
    if (permission === "direct") await tx.update(chatMembers).set({ state: "active" }).where(and(eq(chatMembers.threadId, thread.id), eq(chatMembers.userId, recipient.id)));
    const [mine, theirs] = await Promise.all([memberOf(tx, thread.id, sender.id), memberOf(tx, thread.id, recipient.id)]);
    return { threadId: thread.id, permission, request: requestStateFor(mine, theirs) };
  });
}

/** The recipient answers a message request. Replying accepts it too (postMessage). */
export async function answerRequest(threadId: string, userId: string, accept: boolean) {
  const [row] = await db.update(chatMembers).set({ state: accept ? "active" : "declined" })
    .where(and(eq(chatMembers.threadId, threadId), eq(chatMembers.userId, userId), inArray(chatMembers.state, ["request", "declined"]))).returning();
  if (!row) throw chatError("no_request", 404);
  return { state: row.state };
}

// ---- reading lines ---------------------------------------------------------------------

const messageColumns = {
  m: chatMessages,
  author: { id: users.id, handle: users.handle, displayName: users.displayName, avatarEmoji: users.avatarEmoji, isVerified: users.isVerified },
  voice: { id: voiceNotes.id, durationMs: voiceNotes.durationMs, status: voiceNotes.status },
};
type MessageRow = { m: typeof chatMessages.$inferSelect; author: ChatMessage["author"] | null; voice: { id: string; durationMs: number; status: string } | null };

const toWire = (r: MessageRow): ChatMessage => ({
  id: r.m.id,
  threadId: r.m.threadId,
  kind: r.m.kind,
  author: r.author?.id ? r.author : null,
  text: r.m.text,
  sticker: r.m.sticker,
  mentions: r.m.mentions,
  voice: r.voice?.id ? { id: r.voice.id, durationMs: r.voice.durationMs, expired: r.voice.status === "expired" } : null,
  partyId: r.m.cardPartyId,
  clientMsgId: r.m.clientMsgId,
  createdAt: r.m.createdAt.toISOString(),
});

const selectMessages = (q: Conn) => q.select(messageColumns).from(chatMessages)
  .leftJoin(users, eq(users.id, chatMessages.userId)).leftJoin(voiceNotes, eq(voiceNotes.id, chatMessages.voiceNoteId));

export async function messageById(q: Conn, id: string): Promise<ChatMessage> {
  const [r] = await selectMessages(q).where(eq(chatMessages.id, id));
  return toWire(r as MessageRow);
}

/** One page of a thread, oldest first, ending just before `before` (a message id), and the cursor for the page before it. */
export async function messagesPage(threadId: string, opts: { before?: string; limit: number }): Promise<{ messages: ChatMessage[]; before: string | null }> {
  let cursor;
  if (opts.before) {
    const [b] = await db.select({ createdAt: chatMessages.createdAt, id: chatMessages.id }).from(chatMessages).where(and(eq(chatMessages.id, opts.before), eq(chatMessages.threadId, threadId)));
    if (!b) throw chatError("bad_cursor", 400);
    cursor = or(lt(chatMessages.createdAt, b.createdAt), and(eq(chatMessages.createdAt, b.createdAt), lt(chatMessages.id, b.id)));
  }
  const rows = await selectMessages(db).where(and(eq(chatMessages.threadId, threadId), cursor))
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id)).limit(opts.limit + 1);
  const more = rows.length > opts.limit;
  const page = rows.slice(0, opts.limit).reverse().map((r) => toWire(r as MessageRow));
  return { messages: page, before: more ? page[0].id : null };
}

// ---- writing lines ---------------------------------------------------------------------

/** A system line in a party's chat ("Ada joined"). Inside the caller's transaction; publish it after commit. */
export async function systemLine(q: Conn, partyId: string, text: string): Promise<ChatMessage> {
  const threadId = await partyThreadId(q, partyId);
  return insertLine(q, { threadId, kind: "system", text });
}

/** A party card (a challenge, a crew party) posted into a thread by someone, or by the system. */
export async function partyCardLine(q: Conn, threadId: string, partyId: string, userId: string | null, text: string): Promise<ChatMessage> {
  return insertLine(q, { threadId, kind: "party_card", userId, text, cardPartyId: partyId });
}

async function insertLine(q: Conn, values: typeof chatMessages.$inferInsert): Promise<ChatMessage> {
  const [row] = await q.insert(chatMessages).values(values).returning();
  await q.update(chatThreads).set({ lastMessageAt: row.createdAt }).where(eq(chatThreads.id, values.threadId));
  return messageById(q, row.id);
}

export interface PostInput {
  thread: ChatThread;
  sender: ChatSender;
  clientMsgId: string;
  text?: string;
  sticker?: string;
  voiceNoteId?: string;
}
export interface PostDeps {
  cfg: Pick<ChatConfig, "requestMaxMessages">;
  /** Is the note's object really in storage (and no bigger than it said)? Callers pass the object store's check. */
  voiceUploaded: (note: VoiceNote) => Promise<boolean>;
}
export interface Posted {
  message: ChatMessage;
  /** A repeat of a client message id already kept: nothing new was written. */
  duplicate: boolean;
  /** Thread members this line @-mentions (never the sender), for the mention nudge. */
  mentionedUserIds: string[];
}

/**
 * The one write path. The caller has checked the room's own rules (the party's phase, the rate limit);
 * this checks the thread's: the sender is in it, a message request's limits, the voice note is theirs and
 * uploaded. Text is masked for profanity and its @mentions resolved. A repeated client message id returns
 * the first line, so a retry after an error never posts twice.
 */
export async function postMessage(input: PostInput, deps: PostDeps): Promise<Posted> {
  const { thread, sender, clientMsgId } = input;
  const earlier = await keptLine(sender.id, clientMsgId);
  if (earlier) return { message: earlier, duplicate: true, mentionedUserIds: [] };

  const mine = await memberOf(db, thread.id, sender.id);
  if (!mine) throw chatError("not_in_thread");
  if (thread.kind === "dm") await checkDm(thread, sender, mine, input, deps);

  let note: VoiceNote | undefined;
  if (input.voiceNoteId) {
    [note] = await db.select().from(voiceNotes).where(eq(voiceNotes.id, input.voiceNoteId));
    if (!note || note.userId !== sender.id || note.threadId !== thread.id || note.status !== "pending") throw chatError("voice_note_invalid", 409);
    if (!(await deps.voiceUploaded(note))) throw chatError("voice_not_uploaded", 409);
  }
  const text = input.text ? maskProfanity(input.text) : undefined;
  const mentions = await resolveMentions(text);
  const kind = note ? "voice" : input.sticker ? "sticker" : "text";

  return db.transaction(async (tx) => {
    const [row] = await tx.insert(chatMessages)
      .values({ threadId: thread.id, userId: sender.id, kind, text, sticker: input.sticker, mentions, voiceNoteId: note?.id, clientMsgId })
      .onConflictDoNothing({ target: [chatMessages.userId, chatMessages.clientMsgId] }).returning();
    if (!row) return { message: (await keptLine(sender.id, clientMsgId, tx))!, duplicate: true, mentionedUserIds: [] };
    await tx.update(chatThreads).set({ lastMessageAt: row.createdAt }).where(eq(chatThreads.id, thread.id));
    await tx.update(chatMembers).set({ lastReadAt: row.createdAt }).where(and(eq(chatMembers.threadId, thread.id), eq(chatMembers.userId, sender.id)));
    if (note) await tx.update(voiceNotes).set({ status: "attached", attachedAt: row.createdAt }).where(eq(voiceNotes.id, note.id));
    const mentioned = mentions.length
      ? await tx.select({ id: users.id }).from(users).innerJoin(chatMembers, and(eq(chatMembers.userId, users.id), eq(chatMembers.threadId, thread.id)))
        .where(and(inArray(users.handle, mentions), ne(users.id, sender.id)))
      : [];
    return { message: await messageById(tx, row.id), duplicate: false, mentionedUserIds: mentioned.map((m) => m.id) };
  });
}

async function keptLine(userId: string, clientMsgId: string, q: Conn = db): Promise<ChatMessage | undefined> {
  const [row] = await q.select({ id: chatMessages.id }).from(chatMessages).where(and(eq(chatMessages.userId, userId), eq(chatMessages.clientMsgId, clientMsgId)));
  return row ? messageById(q, row.id) : undefined;
}

/**
 * A DM's own rules. Writing answers a request sent to you (it opens). If the other side hasn't accepted
 * yours, the rule is checked again (a follow-back opens it); otherwise a few text lines may wait for them,
 * and nothing once they've declined.
 */
async function checkDm(thread: ChatThread, sender: ChatSender, mine: { state: string }, input: PostInput, deps: PostDeps) {
  if (mine.state !== "active") await db.update(chatMembers).set({ state: "active" }).where(and(eq(chatMembers.threadId, thread.id), eq(chatMembers.userId, sender.id)));
  const [other] = await db.select({ member: chatMembers, user: users }).from(chatMembers).innerJoin(users, eq(users.id, chatMembers.userId))
    .where(and(eq(chatMembers.threadId, thread.id), ne(chatMembers.userId, sender.id)));
  if (!other) throw chatError("cannot_message");
  const permission = await dmPermissionBetween(db, sender, other.user);
  if (permission === "refused") throw chatError("cannot_message");
  if (other.member.state === "active") return;
  if (permission === "direct") {
    await db.update(chatMembers).set({ state: "active" }).where(and(eq(chatMembers.threadId, thread.id), eq(chatMembers.userId, other.user.id)));
    return;
  }
  if (other.member.state === "declined") throw chatError("cannot_message");
  if (input.voiceNoteId) throw chatError("voice_after_accept");
  const [{ n }] = await db.select({ n: count() }).from(chatMessages).where(and(eq(chatMessages.threadId, thread.id), eq(chatMessages.userId, sender.id)));
  if (Number(n) >= deps.cfg.requestMaxMessages) throw chatError("request_pending", 409);
}

/** Who may read a thread: DM and crew threads are their members'; a party's chat reads like the party (anyone who can open it). */
export async function canReadThread(thread: ChatThread, userId: string) {
  return thread.kind === "party" || !!(await memberOf(db, thread.id, userId));
}

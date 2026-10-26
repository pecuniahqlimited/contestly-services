/**
 * One room per signed-up user (all their devices): the socket for chat outside a live party. It sends
 * lines to DMs, crews, and party threads from Chats › Parties (when the party allows it from outside its
 * room), delivers inbox updates for the user's DM and crew threads, and streams a thread's lines while it's
 * open on screen (watch / unwatch). History is HTTP (GET /chats/:id/messages). Guests have no inbox: they
 * chat in their party's room only.
 */
import type { Client } from "colyseus";
import { eq } from "drizzle-orm";
import { canReadThread, db, getChatConfig, parties, threadById, type ChatSender, type ChatThread } from "@contestly/db";
import { assertNotBanned, resolveUser } from "@contestly/auth";
import { MSG, SIGN_UP_REQUIRED, chatThreadChannel, chatUserChannel, inboxSendSchema, partyChatFromOutside, watchThreadSchema } from "@contestly/shared";
import { SafeRoom } from "./SafeRoom.js";
import { parsePublished, sendLine } from "./chat.js";

/** A user's devices share their inbox room. */
const MAX_DEVICES = 10;

type Sender = ChatSender;

export class InboxRoom extends SafeRoom {
  private userId!: string;
  /** threadId → sessions watching it, and the one subscription that feeds them. */
  private watching = new Map<string, { sessions: Set<string>; listener: (raw: unknown) => void }>();

  protected get label() {
    return `inbox ${this.userId ?? "?"}`;
  }

  private onInbox = (raw: unknown) => this.run("inbox update", () => this.broadcast(MSG.inbox, parsePublished(raw)));

  onCreate(options: { userId?: string }) {
    if (!options?.userId || typeof options.userId !== "string") throw new Error("userId required");
    this.userId = options.userId;
    this.maxClients = MAX_DEVICES;
    this.autoDispose = true;

    this.presence.subscribe(chatUserChannel(this.userId), this.onInbox);
    this.listenForAdminEvents();

    this.handle(MSG.chat, async (client, raw) => {
      const parsed = inboxSendSchema.safeParse(raw);
      if (!parsed.success) return client.send(MSG.error, { error: "validation", issues: parsed.error.issues });
      const { threadId, ...body } = parsed.data;
      const thread = await threadById(threadId);
      if (!thread) return client.send(MSG.error, { error: "not_found", clientMsgId: body.clientMsgId });
      const refused = await this.outsideRoomRefusal(thread);
      if (refused) return client.send(MSG.error, { error: refused, clientMsgId: body.clientMsgId });
      await sendLine(this.presence, client, thread, client.auth as Sender, body);
    });

    this.handle(MSG.watch, async (client, raw) => {
      const parsed = watchThreadSchema.safeParse(raw);
      if (!parsed.success) return client.send(MSG.error, { error: "validation", issues: parsed.error.issues });
      const thread = await threadById(parsed.data.threadId);
      if (!thread || !(await canReadThread(thread, this.userId))) return client.send(MSG.error, { error: "not_found" });
      this.watch(thread.id, client.sessionId);
    });

    this.handle(MSG.unwatch, (client, raw) => {
      const parsed = watchThreadSchema.safeParse(raw);
      if (parsed.success) this.unwatch(parsed.data.threadId, client.sessionId);
    });
  }

  /** Only the user whose inbox this is, signed up, not banned. */
  async onAuth(_client: Client, options: { token?: string; devUser?: string }) {
    const { user } = await resolveUser({ authorization: options?.token ? `Bearer ${options.token}` : undefined, devUser: options?.devUser });
    assertNotBanned(user);
    if (user.isGuest) throw new Error(SIGN_UP_REQUIRED);
    if (user.id !== this.userId) throw new Error("not_your_inbox");
    return { id: user.id, handle: user.handle, displayName: user.displayName, avatarEmoji: user.avatarEmoji, isVerified: user.isVerified, isGuest: user.isGuest, isBrand: user.isBrand, isSystem: user.isSystem } satisfies Sender;
  }

  onLeave(client: Client) {
    for (const threadId of [...this.watching.keys()]) this.unwatch(threadId, client.sessionId);
  }

  /** Subscriptions outlive a room unless dropped. */
  onDispose() {
    this.presence.unsubscribe(chatUserChannel(this.userId), this.onInbox);
    for (const [threadId, w] of this.watching) this.presence.unsubscribe(chatThreadChannel(threadId), w.listener);
    this.watching.clear();
  }

  /** A party thread is written from its room while the party is live; from here only before it and for a while after. */
  private async outsideRoomRefusal(thread: ChatThread): Promise<string | null> {
    if (thread.kind !== "party" || !thread.partyId) return null;
    const [party] = await db.select().from(parties).where(eq(parties.id, thread.partyId));
    if (!party) return "not_found";
    const verdict = partyChatFromOutside(party, new Date(), await getChatConfig());
    return verdict === "open" ? null : verdict;
  }

  private watch(threadId: string, sessionId: string) {
    const existing = this.watching.get(threadId);
    if (existing) return void existing.sessions.add(sessionId);
    const sessions = new Set([sessionId]);
    const listener = (raw: unknown) => this.run("thread line", () => {
      const line = parsePublished(raw);
      for (const c of this.clients) if (sessions.has(c.sessionId)) c.send(MSG.chatMessage, line);
    });
    this.watching.set(threadId, { sessions, listener });
    this.presence.subscribe(chatThreadChannel(threadId), listener);
  }

  private unwatch(threadId: string, sessionId: string) {
    const w = this.watching.get(threadId);
    if (!w) return;
    w.sessions.delete(sessionId);
    if (w.sessions.size) return;
    this.watching.delete(threadId);
    this.presence.unsubscribe(chatThreadChannel(threadId), w.listener);
  }
}

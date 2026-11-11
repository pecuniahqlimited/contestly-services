/**
 * One room per signed-up user (all their devices): the socket for chat outside a live party. It sends
 * lines to DMs, crews, and party threads from Chats › Parties (when the party allows it from outside its
 * room), delivers inbox updates for the user's DM and crew threads, and streams a thread's lines while it's
 * open on screen (watch / unwatch). History is HTTP (GET /chats/:id/messages). Guests have no inbox: they
 * chat in their party's room only. It also carries the user's nudges as in-app banners (MSG.nudge): while this
 * room is up, the worker sends a banner instead of a push (its subscription is how the worker knows).
 */
import type { Client } from "colyseus";
import { eq } from "drizzle-orm";
import { assertBrandCan, canReadThread, db, getChatConfig, parties, threadById, type ChatSender, type ChatThread } from "@contestly/db";
import { assertNotBanned, refuseNewGuests, resolveUser } from "@contestly/auth";
import { BRAND_ROLE_FORBIDDEN, MSG, SIGN_UP_REQUIRED, brandRoleCan, chatThreadChannel, chatUserChannel, inboxSendSchema, partyChatFromOutside, watchThreadSchema } from "@contestly/shared";
import { nudgeChannel } from "@contestly/queue";
import { SafeRoom } from "./SafeRoom.js";
import { firstSighting, parsePublished, sendLine } from "./chat.js";
import type { ChatMessage, InboxUpdate } from "@contestly/shared";

/** A user's devices share their inbox room. */
const MAX_DEVICES = 10;

/** Who's on this socket: the inbox's owner, or a brand team member acting as the brand (sentBy). */
type Sender = ChatSender & { canWrite: boolean };

export class InboxRoom extends SafeRoom {
  private userId!: string;
  /** threadId → sessions watching it, and the one subscription that feeds them. */
  private watching = new Map<string, { sessions: Set<string>; listener: (raw: unknown) => void }>();

  protected get label() {
    return `inbox ${this.userId ?? "?"}`;
  }

  /** A DM or crew line for this user's inbox, unless its author is hidden from them (ADR 0014). */
  private onInbox = (raw: unknown) => this.run("inbox update", async () => {
    const update = parsePublished<InboxUpdate>(raw);
    if (await this.hidden.sees(this.userId, update.message.author?.id)) this.broadcast(MSG.inbox, { ...update, message: await this.asSeenBy(update.message, this.userId) });
  });
  private onNudge = (raw: unknown) => this.run("nudge", () => this.broadcast(MSG.nudge, parsePublished(raw)));

  onCreate(options: { userId?: string }) {
    if (!options?.userId || typeof options.userId !== "string") throw new Error("userId required");
    this.userId = options.userId;
    this.maxClients = MAX_DEVICES;
    this.autoDispose = true;

    this.presence.subscribe(chatUserChannel(this.userId), this.onInbox);
    this.presence.subscribe(nudgeChannel(this.userId), this.onNudge);
    this.listenForAdminEvents();
    this.listenForSafetyEvents((threadId, messageId) => {
      const w = this.watching.get(threadId);
      if (w) for (const c of this.clients) if (w.sessions.has(c.sessionId)) c.send(MSG.chatHidden, { threadId, messageId });
    });

    this.handle(MSG.chat, async (client, raw) => {
      const parsed = inboxSendSchema.safeParse(raw);
      if (!parsed.success) return client.send(MSG.error, { error: "validation", issues: parsed.error.issues });
      const { threadId, ...body } = parsed.data;
      const thread = await threadById(threadId);
      if (!thread) return client.send(MSG.error, { error: "not_found", clientMsgId: body.clientMsgId });
      if (!(client.auth as Sender).canWrite) return client.send(MSG.error, { error: BRAND_ROLE_FORBIDDEN, clientMsgId: body.clientMsgId });
      const refused = await this.outsideRoomRefusal(thread);
      if (refused) return client.send(MSG.error, { error: refused, clientMsgId: body.clientMsgId });
      const { canWrite: _w, ...sender } = client.auth as Sender;
      await sendLine(this.presence, client, thread, sender, body);
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

  /**
   * Only the user whose inbox this is, signed up, not banned; or, with `actAs` (a brand's id, ADR 0017), a member of
   * that brand's team joining the brand's inbox: every role reads, hosts and up write (canWrite), and a line goes out
   * from the brand with the member kept as `sentBy`.
   */
  async onAuth(_client: Client, options: { token?: string; devUser?: string; actAs?: string }) {
    const { user } = await resolveUser({ authorization: options?.token ? `Bearer ${options.token}` : undefined, devUser: options?.devUser, beforeNewGuest: refuseNewGuests });
    assertNotBanned(user);
    if (user.isGuest) throw new Error(SIGN_UP_REQUIRED);
    if (options?.actAs) {
      if (options.actAs !== this.userId) throw new Error("not_your_inbox");
      const { account, role } = await assertBrandCan(db, options.actAs, user, "inbox.read");
      const sender = { id: account.id, handle: account.handle, displayName: account.displayName, avatarEmoji: account.avatarEmoji, isVerified: account.isVerified, isGuest: false, isBrand: true, isSystem: false, sentBy: user.id };
      return { ...sender, canWrite: brandRoleCan(role, "inbox.write") };
    }
    if (user.id !== this.userId) throw new Error("not_your_inbox");
    return { id: user.id, handle: user.handle, displayName: user.displayName, avatarEmoji: user.avatarEmoji, isVerified: user.isVerified, isGuest: user.isGuest, isBrand: user.isBrand, isSystem: user.isSystem, canWrite: true };
  }

  onLeave(client: Client) {
    for (const threadId of [...this.watching.keys()]) this.unwatch(threadId, client.sessionId);
  }

  /** Subscriptions outlive a room unless dropped. */
  onDispose() {
    this.presence.unsubscribe(chatUserChannel(this.userId), this.onInbox);
    this.presence.unsubscribe(nudgeChannel(this.userId), this.onNudge);
    for (const [threadId, w] of this.watching) this.presence.unsubscribe(chatThreadChannel(threadId), w.listener);
    this.watching.clear();
    this.stopSafetyEvents();
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
    const first = firstSighting();
    const listener = (raw: unknown) => this.run("thread line", async () => {
      const line = parsePublished<ChatMessage>(raw);
      if (!first(line.id)) return; // a republished line
      await this.deliverLine(this.clients.filter((c) => sessions.has(c.sessionId)), line);
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

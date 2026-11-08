/**
 * What can be reported (ADR 0014), one entry per target type: find it as the reporter sees it (or refuse with
 * not_found), file it as a queue kind with what it looks like now (the snapshot), and hide or show it for
 * everyone. Adding a reportable thing adds an entry here and nothing else.
 */
import { and, eq, isNull, or } from "drizzle-orm";
import { type ModerationKind, type ReportTargetType, type SafetyEvent } from "@contestly/shared";
import type { Tx } from "../client.js";
import { chatMessages, chatThreads, cornerPostReplies, cornerPosts, corners, moderationItems, parties, partyPlayers, users, voiceNotes } from "../schema.js";
import { canReadThread } from "../chat.js";
import { cornerShown } from "../corners.js";
import { liveUser } from "../accounts.js";
import { isHostTeam, publicHostId } from "../host.js";

const notFound = () => Object.assign(new Error("not_found"), { statusCode: 404 });

export type Snapshot = Record<string, unknown>;

/** A target found for a reporter: how the queue files it. */
export interface FiledTarget {
  kind: ModerationKind;
  refId: string;
  /** Who's behind it. Null for a line nobody wrote (never reportable). */
  subjectUserId: string;
  threadId?: string | null;
  snapshot: Snapshot;
}

/** Hiding or showing returns what rooms must hear once it commits. */
type Visibility = (tx: Tx, refId: string, snapshot: Snapshot | null) => Promise<SafetyEvent[]>;

interface KindDef {
  /** Hidden for everyone (a hold, a removal) and shown again (a release, a dismissal). Absent: nothing to hide. */
  hide?: Visibility;
  show?: Visibility;
}

// ---- finding a target as the reporter sees it ------------------------------------------------

async function chatLine(tx: Tx, messageId: string, reporterId: string): Promise<FiledTarget> {
  const [r] = await tx.select({ m: chatMessages, t: chatThreads }).from(chatMessages).innerJoin(chatThreads, eq(chatThreads.id, chatMessages.threadId))
    .where(and(eq(chatMessages.id, messageId), isNull(chatMessages.hiddenAt)));
  if (!r || !r.m.userId || !(await canReadThread(r.t, reporterId))) throw notFound();
  const base = { threadKind: r.t.kind, messageId: r.m.id, partyId: r.t.partyId ?? undefined, text: r.m.text, sentAt: r.m.createdAt.toISOString() };
  if (r.m.voiceNoteId) return { kind: "voice_note", refId: r.m.voiceNoteId, subjectUserId: r.m.userId, threadId: r.t.id, snapshot: { ...base, voiceNoteId: r.m.voiceNoteId } };
  const kind = r.t.kind === "party" ? "party_message" : r.t.kind === "dm" ? "dm_message" : "crew_message";
  return { kind, refId: r.m.id, subjectUserId: r.m.userId, threadId: r.t.id, snapshot: base };
}

const FINDERS: Record<ReportTargetType, (tx: Tx, id: string, reporterId: string) => Promise<FiledTarget>> = {
  async user(tx, id) {
    const [u] = await tx.select().from(users).where(and(eq(users.id, id), liveUser, eq(users.isSystem, false)));
    if (!u) throw notFound();
    return { kind: "user", refId: u.id, subjectUserId: u.id, snapshot: { handle: u.handle, displayName: u.displayName, bio: u.bio, avatarEmoji: u.avatarEmoji } };
  },
  message: chatLine,
  async voice_note(tx, id, reporterId) {
    const [m] = await tx.select({ id: chatMessages.id }).from(chatMessages).where(eq(chatMessages.voiceNoteId, id));
    if (!m) throw notFound();
    return chatLine(tx, m.id, reporterId);
  },
  async corner_post(tx, id) {
    const [r] = await tx.select({ p: cornerPosts }).from(cornerPosts).innerJoin(corners, eq(corners.id, cornerPosts.cornerId))
      .where(and(eq(cornerPosts.id, id), isNull(cornerPosts.deletedAt), isNull(cornerPosts.hiddenAt), cornerShown));
    if (!r) throw notFound();
    return { kind: "corner_post", refId: r.p.id, subjectUserId: r.p.authorUserId, snapshot: { text: r.p.text, cornerId: r.p.cornerId, sentAt: r.p.createdAt.toISOString() } };
  },
  async corner_reply(tx, id, reporterId) {
    const [r] = await tx.select({ r: cornerPostReplies, cornerId: cornerPosts.cornerId }).from(cornerPostReplies).innerJoin(cornerPosts, eq(cornerPosts.id, cornerPostReplies.postId))
      .where(and(eq(cornerPostReplies.id, id), isNull(cornerPostReplies.deletedAt), isNull(cornerPostReplies.hiddenAt), or(eq(cornerPostReplies.muted, false), eq(cornerPostReplies.userId, reporterId))));
    if (!r) throw notFound();
    return { kind: "corner_reply", refId: r.r.id, subjectUserId: r.r.userId, snapshot: { text: r.r.text, postId: r.r.postId, cornerId: r.cornerId, sentAt: r.r.createdAt.toISOString() } };
  },
  async party(tx, id, reporterId) {
    const [p] = await tx.select().from(parties).where(eq(parties.id, id));
    if (!p) throw notFound();
    if (p.visibility !== "public" && !(await isHostTeam(p, reporterId))) {
      const [seat] = await tx.select({ id: partyPlayers.id }).from(partyPlayers).where(and(eq(partyPlayers.partyId, p.id), eq(partyPlayers.userId, reporterId)));
      if (!seat) throw notFound();
    }
    return { kind: "party", refId: p.id, subjectUserId: publicHostId(p), snapshot: { title: p.title, coverEmoji: p.coverEmoji, coverColor: p.coverColor } };
  },
};

/** The target as the reporter can see it, or not_found (never say a private thing exists). */
export const findTarget = (tx: Tx, type: ReportTargetType, id: string, reporterId: string) => FINDERS[type](tx, id, reporterId);

// ---- hiding and showing ------------------------------------------------------------------

/** A line hidden or shown again: rooms drop a hidden one from screens; a shown one comes back with history. */
async function setLineHidden(tx: Tx, messageId: string, hiddenAt: Date | null): Promise<SafetyEvent[]> {
  const [m] = await tx.update(chatMessages).set({ hiddenAt }).where(eq(chatMessages.id, messageId)).returning({ id: chatMessages.id, threadId: chatMessages.threadId });
  return m && hiddenAt ? [{ kind: "line_hidden", threadId: m.threadId, messageId: m.id }] : [];
}

const line = (byVoiceNote: boolean): KindDef => {
  const messageOf = async (tx: Tx, refId: string) => {
    if (!byVoiceNote) return refId;
    const [m] = await tx.select({ id: chatMessages.id }).from(chatMessages).where(eq(chatMessages.voiceNoteId, refId));
    return m?.id;
  };
  return {
    hide: async (tx, refId) => { const id = await messageOf(tx, refId); return id ? setLineHidden(tx, id, new Date()) : []; },
    show: async (tx, refId) => { const id = await messageOf(tx, refId); return id ? setLineHidden(tx, id, null) : []; },
  };
};

/** Held or removed, a party shows a neutral title and cover; the snapshot keeps what it was. */
export const HIDDEN_PARTY_TITLE = "Party under review";
/** The columns' own defaults (schema.ts). */
const HIDDEN_PARTY_COVER = { coverEmoji: "🎉", coverColor: "#7B5CFF" };

const KINDS: Record<ModerationKind, KindDef> = {
  /** A person's profile: removing it resets the name and clears the bio (the snapshot keeps them). */
  user: {
    hide: async (tx, refId) => {
      const [u] = await tx.select({ handle: users.handle }).from(users).where(eq(users.id, refId));
      if (u) await tx.update(users).set({ bio: null, displayName: u.handle }).where(eq(users.id, refId));
      return [];
    },
    show: async (tx, refId, snap) => {
      if (snap?.displayName) await tx.update(users).set({ displayName: String(snap.displayName), bio: (snap.bio as string | null) ?? null }).where(eq(users.id, refId));
      return [];
    },
  },
  party_message: line(false),
  dm_message: line(false),
  crew_message: line(false),
  voice_note: line(true),
  corner_post: {
    hide: async (tx, refId) => { await tx.update(cornerPosts).set({ hiddenAt: new Date() }).where(eq(cornerPosts.id, refId)); return []; },
    show: async (tx, refId) => { await tx.update(cornerPosts).set({ hiddenAt: null }).where(eq(cornerPosts.id, refId)); return []; },
  },
  corner_reply: {
    hide: async (tx, refId) => { await tx.update(cornerPostReplies).set({ hiddenAt: new Date() }).where(eq(cornerPostReplies.id, refId)); return []; },
    show: async (tx, refId) => { await tx.update(cornerPostReplies).set({ hiddenAt: null }).where(eq(cornerPostReplies.id, refId)); return []; },
  },
  party: {
    hide: async (tx, refId) => { await tx.update(parties).set({ title: HIDDEN_PARTY_TITLE, ...HIDDEN_PARTY_COVER }).where(eq(parties.id, refId)); return []; },
    show: async (tx, refId, snap) => {
      if (snap?.title) await tx.update(parties).set({ title: String(snap.title), coverEmoji: String(snap.coverEmoji), coverColor: String(snap.coverColor) }).where(eq(parties.id, refId));
      return [];
    },
  },
};

/** Whether the automatic hold applies: people are timed out, not hidden, by reports against them. */
export const holdable = (kind: ModerationKind) => kind !== "user";

export async function hideItem(tx: Tx, item: typeof moderationItems.$inferSelect): Promise<SafetyEvent[]> {
  return (await KINDS[item.kind as ModerationKind].hide?.(tx, item.refId, item.snapshot as Snapshot | null)) ?? [];
}
export async function showItem(tx: Tx, item: typeof moderationItems.$inferSelect): Promise<SafetyEvent[]> {
  return (await KINDS[item.kind as ModerationKind].show?.(tx, item.refId, item.snapshot as Snapshot | null)) ?? [];
}

/** Which voice note an item's audio is (a voice_note item's ref). */
export async function voiceNoteOf(tx: Tx, item: typeof moderationItems.$inferSelect) {
  if (item.kind !== "voice_note") return null;
  const [n] = await tx.select().from(voiceNotes).where(eq(voiceNotes.id, item.refId));
  return n ?? null;
}

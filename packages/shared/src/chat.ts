/**
 * Chat: one thread model for party rooms, one-to-one messages and crews (ADR 0007). One composer:
 * text with @mentions, emoji (a sticker is a lone emoji), and voice notes uploaded straight to object
 * storage. Writes go through the realtime rooms and carry a client message id; the server keeps the
 * first and answers a repeat with it.
 */
import { z } from "zod";
import { personSchema } from "./person.js";
import { PROFANITY } from "./safety.js";

export const CHAT_THREAD_KINDS = ["party", "dm", "crew"] as const;
export type ChatThreadKind = (typeof CHAT_THREAD_KINDS)[number];
export const CHAT_MESSAGE_KINDS = ["text", "sticker", "voice", "system", "party_card"] as const;
export type ChatMessageKind = (typeof CHAT_MESSAGE_KINDS)[number];
/** A member's standing in a thread. Only a DM recipient is ever `request` (not yet accepted) or `declined`. */
export const CHAT_MEMBER_STATES = ["active", "request", "declined"] as const;
export type ChatMemberState = (typeof CHAT_MEMBER_STATES)[number];

export const MAX_CHAT_TEXT = 500;
export const MAX_STICKER_CHARS = 8;
/** Voice note formats the app records; anything else is refused before an upload URL is made. */
export const VOICE_CONTENT_TYPES = ["audio/mp4", "audio/aac", "audio/mpeg", "audio/webm", "audio/ogg"] as const;
export type VoiceContentType = (typeof VOICE_CONTENT_TYPES)[number];

/** Admin-editable chat settings (app_config "chat"). */
export const chatConfigSchema = z.object({
  /** Longest voice note, in seconds. */
  maxVoiceSeconds: z.number().int().min(5).max(300),
  /** Largest voice upload, in bytes. */
  maxVoiceBytes: z.number().int().min(10_000).max(10_000_000),
  /** Messages per user across every thread: a burst window and an hourly cap. */
  burstMax: z.number().int().min(1),
  burstSeconds: z.number().int().min(1),
  hourlyMax: z.number().int().min(1),
  /** Voice upload URLs per user per hour. */
  voiceUploadsPerHour: z.number().int().min(1),
  /** Text messages a sender may send into a message request before the recipient accepts it. */
  requestMaxMessages: z.number().int().min(1).max(20),
  /** Party chat stays open this long after a party ends, then reads only. */
  postGameChatHours: z.number().int().min(0).max(24 * 14),
  /** Voice notes are deleted from storage this long after they're sent; the line stays as "expired". */
  voiceRetentionDays: z.number().int().min(1),
  /** An upload URL nobody sent a message with is cleaned up after this long. */
  unattachedVoiceHours: z.number().int().min(1),
});
export type ChatConfig = z.infer<typeof chatConfigSchema>;
export const DEFAULT_CHAT_CONFIG: ChatConfig = {
  maxVoiceSeconds: 60,
  maxVoiceBytes: 1_500_000,
  burstMax: 8,
  burstSeconds: 10,
  hourlyMax: 200,
  voiceUploadsPerHour: 30,
  requestMaxMessages: 3,
  postGameChatHours: 24,
  voiceRetentionDays: 90,
  unattachedVoiceHours: 24,
};
/** Upload URLs live this long; the client uploads right after asking. */
export const VOICE_UPLOAD_URL_SECONDS = 300;
/** Playback URLs live this long. */
export const VOICE_PLAYBACK_URL_SECONDS = 900;

/** What a client sends: exactly one of text, a sticker, or an uploaded voice note, with its own message id. */
const messageBody = {
  clientMsgId: z.string().uuid(),
  text: z.string().trim().min(1).max(MAX_CHAT_TEXT).optional(),
  sticker: z.string().min(1).max(MAX_STICKER_CHARS).optional(),
  voiceNoteId: z.string().uuid().optional(),
};
const exactlyOne = (m: { text?: string; sticker?: string; voiceNoteId?: string }) => [m.text, m.sticker, m.voiceNoteId].filter(Boolean).length === 1;
/** MSG.chat in a party room: the party comes from the room. */
export const chatSendSchema = z.object(messageBody).refine(exactlyOne, "send one of text, a sticker or a voice note");
/** MSG.chat in the inbox room: any thread the sender may write to. */
export const inboxSendSchema = z.object({ threadId: z.string().uuid(), ...messageBody }).refine(exactlyOne, "send one of text, a sticker or a voice note");
/** MSG.watch / MSG.unwatch in the inbox room: live lines for a thread open on screen. */
export const watchThreadSchema = z.object({ threadId: z.string().uuid() });
export type ChatSend = z.infer<typeof chatSendSchema>;
export type InboxSend = z.infer<typeof inboxSendSchema>;

/** A voice note on a line. Play it via GET /voice-notes/:id; `expired` once retention has removed it. */
export const chatVoiceSchema = z.object({ id: z.string().uuid(), durationMs: z.number().int(), expired: z.boolean() });

/** A persisted line, as every surface shows it. System lines have no author. */
export const chatMessageSchema = z.object({
  id: z.string().uuid(),
  threadId: z.string().uuid(),
  kind: z.enum(CHAT_MESSAGE_KINDS),
  author: personSchema.nullable(),
  text: z.string().nullable(),
  sticker: z.string().nullable(),
  /** The real users this line @-mentions, resolved when sent; only these are tappable. */
  mentions: z.array(z.string()),
  voice: chatVoiceSchema.nullable(),
  /** A party card (a challenge, a crew party): the party to open. */
  partyId: z.string().uuid().nullable(),
  /** The sender's id for this line; a retried send gets the same line back. Null on system lines. */
  clientMsgId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

/** MSG.chatAck: the sender's line was kept (or had been already; `duplicate`). */
export const chatAckSchema = z.object({ clientMsgId: z.string().uuid(), duplicate: z.boolean(), message: chatMessageSchema });
export type ChatAck = z.infer<typeof chatAckSchema>;

/** A thread's last line, short enough for a list row. */
export const chatPreviewSchema = z.object({
  author: personSchema.pick({ handle: true, displayName: true }).nullable(),
  kind: z.enum(CHAT_MESSAGE_KINDS),
  text: z.string().nullable(),
  sticker: z.string().nullable(),
  voiceDurationMs: z.number().int().nullable(),
  createdAt: z.string().datetime(),
});
export type ChatPreview = z.infer<typeof chatPreviewSchema>;

/**
 * Where a DM stands for the viewer. none: an open conversation. sent: the viewer's request, not accepted
 * yet. received: someone's request to the viewer (Messages › Requests).
 */
export const DM_REQUEST_STATES = ["none", "sent", "received"] as const;

/** MSG.inbox in the inbox room: a line landed in one of the viewer's DM or crew threads. */
export const inboxUpdateSchema = z.object({ threadId: z.string().uuid(), kind: z.enum(CHAT_THREAD_KINDS), message: chatMessageSchema });
export type InboxUpdate = z.infer<typeof inboxUpdateSchema>;

/** GET /chats?kind=dm: one-to-one threads, newest first, with the other person. */
export const dmThreadSchema = z.object({
  id: z.string().uuid(),
  with: personSchema,
  request: z.enum(DM_REQUEST_STATES),
  lastMessage: chatPreviewSchema.nullable(),
  unread: z.number().int(),
});
export const dmThreadsResponseSchema = z.array(dmThreadSchema);
export type DmThread = z.infer<typeof dmThreadSchema>;

/** GET /chats/unread: the Chats tab badge, per inner tab. Requests are counted apart from messages. Counts stop at UNREAD_CAP. */
export const UNREAD_CAP = 99;
export const chatUnreadSchema = z.object({ messages: z.number().int(), requests: z.number().int(), crews: z.number().int(), parties: z.number().int() });
export type ChatUnread = z.infer<typeof chatUnreadSchema>;

/** GET /chats/:id/messages?before=<message id>&limit=: one page, oldest first; `before` for the next (older) page, null at the start. */
export const CHAT_PAGE_DEFAULT = 50;
export const CHAT_PAGE_MAX = 100;
export const chatPageQuerySchema = z.object({
  before: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(CHAT_PAGE_MAX).default(CHAT_PAGE_DEFAULT),
});
export const chatPageSchema = z.object({ messages: z.array(chatMessageSchema), before: z.string().uuid().nullable() });
export type ChatPage = z.infer<typeof chatPageSchema>;

/**
 * Who may message whom (ADR 0007). direct: the conversation is open. request: the first few text lines
 * wait in the recipient's Requests until they accept. refused: no thread at all.
 */
export const DM_PERMISSIONS = ["direct", "request", "refused"] as const;
export type DmPermission = (typeof DM_PERMISSIONS)[number];

/** POST /dm/:userId: the thread with that person (made if new), and where it stands. */
export const openDmResponseSchema = z.object({ threadId: z.string().uuid(), permission: z.enum(DM_PERMISSIONS), request: z.enum(DM_REQUEST_STATES) });
export type OpenDmResponse = z.infer<typeof openDmResponseSchema>;
/** POST /chats/:id/request/accept|decline → the viewer's side of it. */
export const requestAnswerResponseSchema = z.object({ state: z.enum(CHAT_MEMBER_STATES) });

/** POST /chats/:id/voice: ask for an upload URL. Duration is the recorder's; the transcriber measures it again. */
export const voiceUploadRequestSchema = z.object({
  durationMs: z.number().int().min(1),
  contentType: z.enum(VOICE_CONTENT_TYPES),
  bytes: z.number().int().min(1),
});
export const voiceUploadResponseSchema = z.object({
  voiceNoteId: z.string().uuid(),
  upload: z.object({ url: z.string(), method: z.literal("PUT"), headers: z.record(z.string()), expiresAt: z.string().datetime() }),
});
export type VoiceUploadRequest = z.infer<typeof voiceUploadRequestSchema>;
export type VoiceUploadResponse = z.infer<typeof voiceUploadResponseSchema>;
/** GET /voice-notes/:id → a short-lived playback URL. */
export const voicePlaybackResponseSchema = z.object({ url: z.string(), expiresAt: z.string().datetime(), durationMs: z.number().int() });

/** The facts the DM rule needs about two people. Loaded by packages/db; decided here. */
export interface DmFacts {
  sender: { isGuest: boolean; isBrand: boolean; isSystem: boolean };
  recipient: { isGuest: boolean; isSystem: boolean };
  /** The recipient follows the sender (mutual follows included): they opted in. */
  recipientFollowsSender: boolean;
  /** Both played the same finished party. */
  playedTogether: boolean;
  /** Both are in the same crew. */
  shareCrew: boolean;
  /** The recipient joined a party the sender hosted (what lets a brand write). */
  joinedSendersParty: boolean;
}

/**
 * The one place the DM rule lives. Guests and system accounts never DM. A brand writes only to people
 * who joined its parties, and never sends requests (no cold messages). Anyone else is direct when the
 * recipient follows them, they've finished a party together or share a crew; otherwise a request.
 * Row 11's blocks refuse here too.
 */
export function dmPermission(f: DmFacts): DmPermission {
  if (f.sender.isGuest || f.recipient.isGuest || f.sender.isSystem || f.recipient.isSystem) return "refused";
  if (f.sender.isBrand) return f.joinedSendersParty ? "direct" : "refused";
  if (f.recipientFollowsSender || f.playedTogether || f.shareCrew) return "direct";
  return "request";
}

/** Party room phases in which players may chat: the lobby, the standings beat, and after the game. Never during a question or its reveal. */
export const PARTY_CHAT_PHASES = ["lobby", "generating", "standings", "finished"] as const;
export const partyChatOpenIn = (phase: string) => (PARTY_CHAT_PHASES as readonly string[]).includes(phase);

/**
 * Party chat from outside the room (Chats › Parties): open before the party, closed while it's live
 * (there it's the room's standings beat or nothing), open for a while after it ends, then read-only.
 */
export function partyChatFromOutside(party: { status: string; endedAt: Date | null; startsAt: Date }, now: Date, cfg: Pick<ChatConfig, "postGameChatHours">): "open" | "join_the_round" | "chat_ended" {
  if (party.status === "open") return "open";
  if (party.status === "live") return "join_the_round";
  const ended = (party.endedAt ?? party.startsAt).getTime();
  return now.getTime() - ended <= cfg.postGameChatHours * 3_600_000 ? "open" : "chat_ended";
}

/** Profanity in chat is masked, not refused (one list, shared with the question filter). Whole words only. */
const PROFANITY_RE = new RegExp(`\\b(${PROFANITY.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "gi");
export const maskProfanity = (text: string) => text.replace(PROFANITY_RE, (w) => w[0] + "*".repeat(w.length - 1));

/** The two people in a DM, as one key: a pair has one thread whoever writes first. */
export const dmKey = (a: string, b: string) => [a, b].sort().join(":");

/** Inbox room: one per signed-up user, any number of their devices. */
export const INBOX_ROOM = "inbox";
/** Valkey channels: every line of a thread, and one person's inbox updates (DMs and crews only). */
export const chatThreadChannel = (threadId: string) => `chat:thread:${threadId}`;
export const chatUserChannel = (userId: string) => `chat:user:${userId}`;

import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { answerRequest, canReadThread, chatMembers, db, getChatConfig, markRead, memberOf, messagesPage, liveUser, openDm, threadById, users, voiceNotes } from "@contestly/db";
import { VOICE_PLAYBACK_URL_SECONDS, VOICE_UPLOAD_URL_SECONDS, chatPageQuerySchema, voiceUploadRequestSchema } from "@contestly/shared";
import { objectStoreFromEnv, type ObjectStore } from "@contestly/storage";
import { uuidParam } from "../auth.js";
import { actor, sessionOrBrand } from "../acting.js";
import { httpError } from "../httpError.js";
import { limit } from "../redis.js";
import { dmThreads, unreadTotals } from "../chats.js";

let store: ObjectStore | undefined;
const storage = () => (store ??= objectStoreFromEnv());

const voiceKey = (threadId: string, noteId: string) => `voice/${threadId}/${noteId}`;

/** A thread the viewer may read, or 404 (never say a private thread exists). */
async function readableThread(id: string, userId: string) {
  const thread = await threadById(id);
  if (!thread || !(await canReadThread(thread, userId))) throw httpError(404, "not_found");
  return thread;
}

/** Chats: a person's, or with ACT_AS_HEADER a brand's inbox (ADR 0017 §10): every team role reads it, hosts and up write. */
export async function chatsRoutes(app: FastifyInstance) {
  /** Messages: one-to-one threads, newest first (crews join in row 6b). */
  app.get("/chats", { config: { actAs: "inbox.read" } }, async (req) => {
    const { as: me } = await actor(req);
    const { kind } = (req.query ?? {}) as { kind?: string };
    if (kind && kind !== "dm") throw httpError(400, "unknown_kind");
    return dmThreads(me.id, "messages");
  });

  /** Messages › Requests: people who wrote to the viewer and wait for an answer. */
  app.get("/chats/requests", { config: { actAs: "inbox.read" } }, async (req) => dmThreads((await actor(req)).as.id, "requests"));

  /** The Chats tab badge. */
  app.get("/chats/unread", { config: { actAs: "inbox.read" } }, async (req) => unreadTotals((await actor(req)).as.id));

  /** History, one page at a time, oldest first within the page. Guests read their party's chat. */
  app.get("/chats/:id/messages", { config: { actAs: "inbox.read" } }, async (req) => {
    const me = await sessionOrBrand(req);
    const thread = await readableThread(uuidParam(req), me.id);
    return messagesPage(thread.id, { ...chatPageQuerySchema.parse(req.query ?? {}), viewerId: me.id });
  });

  /** The viewer has read the thread up to now. */
  app.post("/chats/:id/read", { config: { actAs: "inbox.read" } }, async (req) => {
    const me = await sessionOrBrand(req);
    const thread = await readableThread(uuidParam(req), me.id);
    await markRead(thread.id, me.id);
    return { ok: true };
  });

  /** Open (or find) the thread with someone: direct, or a message request (ADR 0007). */
  app.post("/dm/:id", { config: { actAs: "inbox.write" } }, async (req) => {
    const { as: me } = await actor(req);
    const [them] = await db.select().from(users).where(and(eq(users.id, uuidParam(req)), liveUser));
    if (!them) throw httpError(404, "not_found");
    return openDm(me, them);
  });

  for (const [answer, accept] of [["accept", true], ["decline", false]] as const) {
    app.post(`/chats/:id/request/${answer}`, { config: { actAs: "inbox.write" } }, async (req) => answerRequest(uuidParam(req), (await actor(req)).as.id, accept));
  }

  /**
   * A voice note's upload URL. The bytes go straight to object storage, never through here; the line is sent
   * on the room afterwards with the note's id. Not inside a message request (text only until accepted).
   */
  app.post("/chats/:id/voice", { config: { actAs: "inbox.write" } }, async (req) => {
    const me = await sessionOrBrand(req);
    const body = voiceUploadRequestSchema.parse(req.body);
    const thread = await threadById(uuidParam(req));
    if (!thread || !(await memberOf(db, thread.id, me.id))) throw httpError(404, "not_found");
    const cfg = await getChatConfig();
    if (body.durationMs > cfg.maxVoiceSeconds * 1000) throw httpError(422, "voice_too_long");
    if (body.bytes > cfg.maxVoiceBytes) throw httpError(422, "voice_too_large");
    if (thread.kind === "dm") {
      const [other] = await db.select({ state: chatMembers.state }).from(chatMembers).where(and(eq(chatMembers.threadId, thread.id), ne(chatMembers.userId, me.id)));
      if (other?.state !== "active") throw httpError(403, "voice_after_accept");
    }
    await limit("voice", me.id, cfg.voiceUploadsPerHour, 3600);
    const id = randomUUID();
    const objectKey = voiceKey(thread.id, id);
    await db.insert(voiceNotes).values({ id, threadId: thread.id, userId: me.id, objectKey, contentType: body.contentType, bytes: body.bytes, durationMs: body.durationMs });
    const upload = await storage().presignPut({ key: objectKey, contentType: body.contentType, contentLength: body.bytes, expiresSeconds: VOICE_UPLOAD_URL_SECONDS });
    return { voiceNoteId: id, upload };
  });

  /** Play a voice note: a short-lived URL, for anyone who can read its thread. */
  app.get("/voice-notes/:id", { config: { actAs: "inbox.read" } }, async (req) => {
    const me = await sessionOrBrand(req);
    const [note] = await db.select().from(voiceNotes).where(eq(voiceNotes.id, uuidParam(req)));
    if (!note || note.status === "pending") throw httpError(404, "not_found");
    await readableThread(note.threadId, me.id);
    if (note.status === "expired") throw httpError(410, "voice_expired");
    const { url, expiresAt } = await storage().presignGet({ key: note.objectKey, expiresSeconds: VOICE_PLAYBACK_URL_SECONDS });
    return { url, expiresAt, durationMs: note.durationMs };
  });
}

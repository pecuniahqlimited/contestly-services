/**
 * Sending a chat line from a room, the same way from the party room and the inbox room: rate limit,
 * postMessage (packages/db: the thread's rules, masking, mentions, the client message id), ack the
 * sender, publish the line, then the follow-ups (mention nudges, voice transcription). Rooms check their
 * own rules first (the party's phase; whether a party can be written to from outside its room).
 */
import type { Client } from "colyseus";
import { getChatConfig, lineDeliveries, postMessage, type ChatSender, type ChatThread } from "@contestly/db";
import { chatQueue, makeRedis, notifyQueue } from "@contestly/queue";
import { objectStoreFromEnv, type ObjectStore } from "@contestly/storage";
import { MSG, type ChatMessage, type ChatSend } from "@contestly/shared";
import { chatRateCheck, valkeyCounter, type WindowCounter } from "./chatRate.js";

/** What a room publishes on: its Colyseus presence (Valkey). */
export interface Publisher {
  publish(topic: string, data: unknown): unknown;
}

let counter: WindowCounter | undefined;
let store: ObjectStore | undefined;
const rate = () => (counter ??= valkeyCounter(makeRedis()));
const storage = () => (store ??= objectStoreFromEnv());
const notify = notifyQueue();
const chatJobs = chatQueue();

const isRefusal = (e: unknown): e is Error & { statusCode: number } => e instanceof Error && typeof (e as { statusCode?: unknown }).statusCode === "number";

export async function sendLine(presence: Publisher, client: Client, thread: ChatThread, sender: ChatSender, body: ChatSend): Promise<void> {
  const cfg = await getChatConfig();
  const limited = await chatRateCheck(rate(), sender.id, cfg);
  if (limited) return void client.send(MSG.error, { error: "rate_limited", clientMsgId: body.clientMsgId, retryAfter: limited.retryAfter });

  let posted;
  try {
    posted = await postMessage({ thread, sender, ...body }, {
      cfg,
      // The upload URL signed its exact length, so a stored object of that size is the one we handed out.
      voiceUploaded: async (note) => (await storage().head(note.objectKey))?.bytes === note.bytes,
    });
  } catch (e) {
    if (!isRefusal(e)) throw e;
    return void client.send(MSG.error, { error: e.message, clientMsgId: body.clientMsgId });
  }
  client.send(MSG.chatAck, { clientMsgId: body.clientMsgId, duplicate: posted.duplicate, message: posted.message });
  if (posted.duplicate) return;

  await publishLine(presence, posted.message);
  if (posted.mentionedUserIds.length) {
    await notify.add("chat_mention", { kind: "chat_mention", threadId: thread.id, messageId: posted.message.id, fromUserId: sender.id, toUserIds: posted.mentionedUserIds });
  }
  if (posted.message.voice) await chatJobs.add("transcribe_voice", { kind: "transcribe_voice", voiceNoteId: posted.message.voice.id }, { jobId: `transcribe-${posted.message.voice.id}` });
}

/** After commit: the line to its thread's channel, and to members' inboxes for DMs and crews (lineDeliveries). */
export async function publishLine(presence: Publisher, message: ChatMessage) {
  for (const d of await lineDeliveries(message)) presence.publish(d.channel, d.payload);
}

/** Valkey pub/sub hands RedisPresence callbacks parsed JSON and LocalPresence the raw string. */
export const parsePublished = <T>(raw: unknown): T => (typeof raw === "string" ? JSON.parse(raw) : raw) as T;

/**
 * Voice notes after they're sent: transcribed into the moderation queue (row 11 reviews it), and cleaned
 * out of storage when nobody sent the upload or retention has passed. Objects go first, then rows, so a
 * crash in between leaves something the next run finishes.
 */
import { and, eq, isNotNull, lt } from "drizzle-orm";
import { db, getChatConfig, moderationItems, voiceNotes } from "@contestly/db";
import type { ObjectStore } from "@contestly/storage";
import type { Transcriber } from "./transcribe/index.js";

const HOUR_MS = 3_600_000;
const PURGE_BATCH = 500;
/** A measured length this far past the cap means the recorder's claim was wrong: flag it for review. */
const OVER_CAP_TOLERANCE_MS = 2000;

/** Transcribe one attached note into moderation_items. Idempotent on (kind, ref). */
export async function transcribeVoice(store: ObjectStore, transcriber: Transcriber, voiceNoteId: string) {
  const [note] = await db.select().from(voiceNotes).where(eq(voiceNotes.id, voiceNoteId));
  if (!note || note.status !== "attached" || note.transcribedAt) return;
  const cfg = await getChatConfig();
  const out = await transcriber.transcribe({ bytes: await store.read(note.objectKey), contentType: note.contentType });
  const overCap = out.durationMs !== undefined && out.durationMs > cfg.maxVoiceSeconds * 1000 + OVER_CAP_TOLERANCE_MS;
  await db.transaction(async (tx) => {
    await tx.insert(moderationItems).values({
      kind: "voice_note", refId: note.id, userId: note.userId, threadId: note.threadId, transcript: out.text, provider: out.provider,
      detail: { claimedMs: note.durationMs, measuredMs: out.durationMs ?? null, overCap },
    }).onConflictDoNothing();
    await tx.update(voiceNotes).set({ transcribedAt: new Date(), measuredMs: out.durationMs ?? null }).where(eq(voiceNotes.id, note.id));
  });
}

/** Uploads nobody sent, past unattachedVoiceHours: object and row go. Sent notes past voiceRetentionDays: object goes, the line shows "expired". */
export async function purgeVoiceNotes(store: ObjectStore, now = new Date()) {
  const cfg = await getChatConfig();
  const unsent = await db.select().from(voiceNotes)
    .where(and(eq(voiceNotes.status, "pending"), lt(voiceNotes.createdAt, new Date(now.getTime() - cfg.unattachedVoiceHours * HOUR_MS)))).limit(PURGE_BATCH);
  for (const n of unsent) {
    await store.remove(n.objectKey);
    await db.delete(voiceNotes).where(and(eq(voiceNotes.id, n.id), eq(voiceNotes.status, "pending")));
  }
  const old = await db.select().from(voiceNotes)
    .where(and(eq(voiceNotes.status, "attached"), isNotNull(voiceNotes.attachedAt), lt(voiceNotes.attachedAt, new Date(now.getTime() - cfg.voiceRetentionDays * 24 * HOUR_MS)))).limit(PURGE_BATCH);
  for (const n of old) {
    await store.remove(n.objectKey);
    await db.update(voiceNotes).set({ status: "expired" }).where(eq(voiceNotes.id, n.id));
  }
  return { unsent: unsent.length, expired: old.length };
}

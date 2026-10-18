/**
 * Source files for question generation: read, never stored. The host sends the file straight to us
 * (multipart, size-capped); we pull its text out in a worker thread, keep only the chunks, and let the
 * bytes go. The questions service then embeds the chunks. A new file replaces the old one and its
 * chunks. Only the host's team, only while the party is open and its questions aren't made yet.
 */
import { and, asc, eq } from "drizzle-orm";
import { db, parties, partyFiles, partyQuestions, fileChunks, isHostTeam, type Party, type Tx, type User } from "@contestly/db";
import { questionsQueue } from "@contestly/queue";
import { MAX_UPLOAD_FILENAME_CHARS, UPLOAD_CONTENT_TYPES, type UploadContentType } from "@contestly/shared";
import { readSource } from "./sources/readSource.js";

const questionJobs = questionsQueue();
const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

export const isUploadContentType = (type: string): type is UploadContentType => Object.hasOwn(UPLOAD_CONTENT_TYPES, type);

const fileView = { id: partyFiles.id, filename: partyFiles.filename, contentType: partyFiles.contentType, sizeBytes: partyFiles.sizeBytes, status: partyFiles.status, error: partyFiles.error, createdAt: partyFiles.createdAt };

/**
 * A file can be swapped until the questions are made from it: none in the set yet, and not mid-build
 * from a file that's already been read (a sealed set waiting for its file is fine).
 */
async function assertReplaceable(q: Tx | typeof db, p: Party, user: User) {
  if (!isHostTeam(p, user.id)) throw httpError(403, "host_team_only");
  if (p.status !== "open") throw httpError(409, "party_not_open");
  const built = await q.select({ id: partyQuestions.id }).from(partyQuestions).where(eq(partyQuestions.partyId, p.id)).limit(1);
  if (built.length) throw httpError(409, "questions_already_made");
  if (p.questionsStatus === "generating") {
    const read = await q.select({ id: partyFiles.id }).from(partyFiles).where(and(eq(partyFiles.partyId, p.id), eq(partyFiles.status, "parsed"))).limit(1);
    if (read.length) throw httpError(409, "questions_being_made");
  }
}

/** Checked before the body is read, so nobody's bytes are parsed for a party they can't change. */
export async function assertCanSendSource(partyId: string, user: User): Promise<void> {
  const [p] = await db.select().from(parties).where(eq(parties.id, partyId));
  if (!p) throw httpError(404, "not_found");
  await assertReplaceable(db, p, user);
}

export async function replaceSource(partyId: string, user: User, file: { filename: string; contentType: UploadContentType; bytes: Uint8Array }) {
  const sizeBytes = file.bytes.byteLength;
  const read = await readSource(file.contentType, file.bytes); // the bytes go to the worker and no further
  const row = await db.transaction(async (tx) => {
    const [p] = await tx.select().from(parties).where(eq(parties.id, partyId)).for("update");
    if (!p) throw httpError(404, "not_found");
    await assertReplaceable(tx, p, user);
    await tx.delete(partyFiles).where(eq(partyFiles.partyId, partyId)); // chunks cascade
    const [f] = await tx.insert(partyFiles).values({
      partyId, uploaderId: user.id, filename: file.filename.trim().slice(0, MAX_UPLOAD_FILENAME_CHARS) || "file", contentType: file.contentType, sizeBytes,
      status: read.ok ? "parsing" : "failed", error: read.ok ? null : read.reason,
    }).returning(fileView);
    if (read.ok) await tx.insert(fileChunks).values(read.chunks.map((text, idx) => ({ fileId: f.id, idx, text })));
    return f;
  });
  // Even a failed read is news: a sealed set waiting for this file now fails with a reason the host can act on.
  await questionJobs.add("file_read", { kind: "file_read", fileId: row.id }, { jobId: `file-read-${row.id}` });
  return row;
}

export async function listFiles(partyId: string, user: User) {
  const [p] = await db.select().from(parties).where(eq(parties.id, partyId));
  if (!p) throw httpError(404, "not_found");
  if (!isHostTeam(p, user.id)) throw httpError(403, "host_team_only");
  return db.select(fileView).from(partyFiles).where(eq(partyFiles.partyId, partyId)).orderBy(asc(partyFiles.createdAt));
}

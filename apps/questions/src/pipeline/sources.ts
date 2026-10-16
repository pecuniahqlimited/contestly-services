/**
 * A party's source scope. No files: open knowledge. Files: questions come only from their chunks,
 * so every file must be parsed first — a party whose file is still parsing or failed does not
 * quietly fall back to open knowledge (fail closed).
 */
import { asc, cosineDistance, eq, inArray } from "drizzle-orm";
import { db, partyFiles, fileChunks } from "@contestly/db";
import type { SourceChunk } from "../providers/types.js";

/** Most relevant chunks handed to the generator for one set. */
export const MAX_SOURCE_CHUNKS = 40;

export class FilesNotReady extends Error {
  constructor(statuses: string[]) {
    super(`source files not ready (${statuses.join(", ")}); not generating from open knowledge instead`);
  }
}

export async function partyFileIds(partyId: string): Promise<string[]> {
  const files = await db.select().from(partyFiles).where(eq(partyFiles.partyId, partyId)).orderBy(asc(partyFiles.createdAt));
  const notReady = files.filter((f) => f.status !== "parsed");
  if (notReady.length) throw new FilesNotReady(notReady.map((f) => `${f.filename}: ${f.status}`));
  return files.map((f) => f.id);
}

/** The chunks closest to the spec, in file order — retrieval for file-scoped generation. */
export async function retrieveChunks(fileIds: string[], specEmbedding: number[]): Promise<SourceChunk[]> {
  const rows = await db
    .select({ id: fileChunks.id, text: fileChunks.text, fileId: fileChunks.fileId, idx: fileChunks.idx })
    .from(fileChunks)
    .where(inArray(fileChunks.fileId, fileIds))
    .orderBy(cosineDistance(fileChunks.embedding, specEmbedding))
    .limit(MAX_SOURCE_CHUNKS);
  rows.sort((a, b) => fileIds.indexOf(a.fileId) - fileIds.indexOf(b.fileId) || a.idx - b.idx);
  return rows.map(({ id, text }) => ({ id, text }));
}

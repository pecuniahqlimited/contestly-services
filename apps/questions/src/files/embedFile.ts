/**
 * file_read, first half: the API has read a source file in memory and kept only its text, chunked.
 * Embed those chunks so retrieval can rank them, and mark the file parsed. There are no bytes here to
 * read: they were never stored. A file the API couldn't read is already marked failed; nothing to do.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { db, parties, partyFiles, fileChunks } from "@contestly/db";
import type { Embedder } from "../providers/types.js";

export async function embedFile(fileId: string, deps: { embedder: Embedder }): Promise<void> {
  const [file] = await db.select().from(partyFiles).where(eq(partyFiles.id, fileId));
  if (!file || file.status !== "parsing") return;
  const chunks = await db.select({ id: fileChunks.id, text: fileChunks.text }).from(fileChunks)
    .where(and(eq(fileChunks.fileId, fileId), isNull(fileChunks.embedding))).orderBy(asc(fileChunks.idx));
  const embeddings = await deps.embedder.embed(chunks.map((c) => c.text));
  await db.transaction(async (tx) => {
    // Locked like a set retry is, so "is the file still being read?" has one answer at a time (see retrySealedSet).
    await tx.select({ id: parties.id }).from(parties).where(eq(parties.id, file.partyId)).for("update");
    for (const [i, c] of chunks.entries()) await tx.update(fileChunks).set({ embedding: embeddings[i] }).where(eq(fileChunks.id, c.id));
    // Replaced while we embedded: the row is gone and this updates nothing.
    await tx.update(partyFiles).set({ status: "parsed", error: null }).where(and(eq(partyFiles.id, fileId), eq(partyFiles.status, "parsing")));
  });
  console.log(`[questions] file ${file.filename}: ${chunks.length} chunk(s) indexed`);
}

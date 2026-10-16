/**
 * parse_file: read an uploaded source file from object storage, extract its text, chunk it and
 * embed the chunks. A file that can't be read is marked failed with the reason (fail closed: a
 * party with a failed file won't generate from open knowledge instead). Storage errors throw so
 * BullMQ retries them.
 */
import { eq } from "drizzle-orm";
import { db, partyFiles, fileChunks } from "@contestly/db";
import { ObjectNotFound, type ObjectStore } from "@contestly/storage";
import type { Embedder } from "../providers/types.js";
import { chunkText } from "./chunk.js";
import { extractFileText } from "./extract.js";

/** Below this much extracted text there's nothing to write questions from (scanned images, empty docs). */
const MIN_TEXT_CHARS = 200;

export async function parseFile(fileId: string, deps: { store: ObjectStore; embedder: Embedder }): Promise<void> {
  const [file] = await db.select().from(partyFiles).where(eq(partyFiles.id, fileId));
  if (!file || file.status !== "parsing") return;

  const fail = (error: string) => db.update(partyFiles).set({ status: "failed", error }).where(eq(partyFiles.id, fileId));
  let bytes: Uint8Array;
  try {
    bytes = await deps.store.get(file.storageKey);
  } catch (err) {
    if (!(err instanceof ObjectNotFound)) throw err; // transient storage trouble: BullMQ retries
    await fail("the upload never arrived; upload the file again");
    return;
  }

  let text: string;
  try {
    text = await extractFileText(file.contentType, bytes);
  } catch (err) {
    await fail(`could not read the file: ${(err as Error).message}`);
    console.warn(`[questions] file ${file.filename}: extraction failed`, (err as Error).message);
    return;
  }
  if (text.replace(/\s+/g, "").length < MIN_TEXT_CHARS) {
    await fail("not enough readable text in the file (scanned pages aren't supported yet)");
    return;
  }

  const chunks = chunkText(text);
  const embeddings = await deps.embedder.embed(chunks);
  await db.transaction(async (tx) => {
    await tx.delete(fileChunks).where(eq(fileChunks.fileId, fileId));
    await tx.insert(fileChunks).values(chunks.map((t, idx) => ({ fileId, idx, text: t, embedding: embeddings[idx] })));
    await tx.update(partyFiles).set({ status: "parsed", error: null }).where(eq(partyFiles.id, fileId));
  });
  console.log(`[questions] file ${file.filename}: ${text.length} chars → ${chunks.length} chunk(s)`);
}

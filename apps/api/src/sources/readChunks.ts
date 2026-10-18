/**
 * Bytes → chunks of text, or the reason we couldn't, worded for the host. Pure apart from the
 * extractors; runs inside the read worker. Nothing here keeps the bytes.
 */
import { chunkText } from "./chunk.js";
import { extractFileText } from "./extract.js";

/** Below this much extracted text there's nothing to write questions from (scanned images, empty docs). */
export const MIN_TEXT_CHARS = 200;

export interface ReadInput {
  contentType: string;
  bytes: Uint8Array;
}

export type ReadResult = { ok: true; chunks: string[] } | { ok: false; reason: string };

export const READ_FAILURES = {
  unreadable: "We couldn't read this file. Check it opens normally, then send it again.",
  tooLittleText: "There isn't enough readable text in this file. Scanned pages aren't supported yet.",
  tooSlow: "This file took too long to read. Try a shorter one.",
} as const;

export async function readChunks({ contentType, bytes }: ReadInput): Promise<ReadResult> {
  let text: string;
  try {
    text = await extractFileText(contentType, bytes);
  } catch {
    return { ok: false, reason: READ_FAILURES.unreadable };
  }
  if (text.replace(/\s+/g, "").length < MIN_TEXT_CHARS) return { ok: false, reason: READ_FAILURES.tooLittleText };
  return { ok: true, chunks: chunkText(text) };
}

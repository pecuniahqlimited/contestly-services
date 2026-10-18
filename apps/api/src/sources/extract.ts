/** Plain-text extraction for the source formats we accept. Images/OCR are not supported yet. */
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";
import { UPLOAD_CONTENT_TYPES } from "@contestly/shared";

export class UnsupportedFile extends Error {}

export async function extractFileText(contentType: string, bytes: Uint8Array): Promise<string> {
  const kind = UPLOAD_CONTENT_TYPES[contentType as keyof typeof UPLOAD_CONTENT_TYPES];
  if (kind === "pdf") {
    const pdf = await getDocumentProxy(bytes);
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  }
  if (kind === "docx") {
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return value;
  }
  throw new UnsupportedFile(`unsupported content type ${contentType}`);
}

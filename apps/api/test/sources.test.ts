import { describe, expect, it } from "vitest";
import { chunkText } from "../src/sources/chunk.js";
import { MIN_TEXT_CHARS, READ_FAILURES, readChunks } from "../src/sources/readChunks.js";
import { minimalPdf } from "../../../scripts/sim-pdf.js";

const PDF = "application/pdf";

const SOURCE = [
  "The Lagos Lagoon separates Lagos Island from the Mainland.",
  "The Third Mainland Bridge was opened in 1990 and is about 11 kilometres long.",
  "Carter Bridge was the first bridge linking Lagos Island to Ebute Metta in 1901.",
  "Eko Bridge was completed in 1975 to ease traffic on Carter Bridge.",
  "The Lekki toll bridge, opened in 2013, connects Lekki with Ikoyi across the lagoon.",
  "Ferries from Falomo and Ikorodu carry thousands of commuters across the water every day.",
].join(" ");

describe("chunkText", () => {
  it("keeps sentences whole and overlaps neighbouring chunks", () => {
    const chunks = chunkText(SOURCE, 160, 80);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(160);
    for (const c of chunks) expect(c.endsWith(".")).toBe(true);
    // the last sentence of one chunk opens the next
    const lastOfFirst = chunks[0].split(/(?<=\.)\s+/).pop()!;
    expect(chunks[1].startsWith(lastOfFirst)).toBe(true);
  });

  it("hard-splits a sentence longer than a chunk instead of dropping it", () => {
    const long = "a".repeat(500) + ".";
    const chunks = chunkText(long, 200, 0);
    expect(chunks.join("")).toBe(long);
  });

  it("returns nothing for empty text", () => {
    expect(chunkText("   \n ")).toEqual([]);
  });
});

describe("readChunks", () => {
  it("reads a PDF's text into chunks", async () => {
    const res = await readChunks({ contentType: PDF, bytes: minimalPdf(SOURCE.split(/(?<=\.) /)) });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.chunks.join(" ")).toContain("Third Mainland Bridge was opened in 1990");
  });

  it("refuses a PDF with too little text to write questions from", async () => {
    expect(await readChunks({ contentType: PDF, bytes: minimalPdf(["Lagos."]) })).toEqual({ ok: false, reason: READ_FAILURES.tooLittleText });
  });

  it("says a file it can't open is unreadable", async () => {
    // A docx is a zip; this one isn't, so mammoth can't open it at all.
    expect(await readChunks({ contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: new Uint8Array([1, 2, 3]) }))
      .toEqual({ ok: false, reason: READ_FAILURES.unreadable });
  });

  it("refuses a content type it has no reader for, in the host's words", async () => {
    expect(await readChunks({ contentType: "image/png", bytes: new Uint8Array(MIN_TEXT_CHARS) })).toEqual({ ok: false, reason: READ_FAILURES.unreadable });
  });
});

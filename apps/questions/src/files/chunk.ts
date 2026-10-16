/**
 * Split extracted text into overlapping, sentence-aligned chunks — the retrieval and citation unit
 * for file-sourced questions. Pure. Sentences longer than a chunk are hard-split so nothing is lost.
 */

export const CHUNK_CHARS = 1200;
export const CHUNK_OVERLAP_CHARS = 200;

function sentencesOf(text: string, max: number): string[] {
  const out: string[] = [];
  for (const s of text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/)) {
    for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
  }
  return out.filter((s) => s.length > 0);
}

export function chunkText(text: string, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP_CHARS): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;
  for (const sentence of sentencesOf(text, size)) {
    if (length + sentence.length + 1 > size && current.length) {
      chunks.push(current.join(" "));
      // Carry trailing sentences (up to `overlap` chars) into the next chunk so facts at a boundary stay whole.
      const carry: string[] = [];
      let carried = 0;
      for (let i = current.length - 1; i >= 0 && carried + current[i].length <= overlap; i--) {
        carry.unshift(current[i]);
        carried += current[i].length + 1;
      }
      current = carry;
      length = carried;
    }
    current.push(sentence);
    length += sentence.length + 1;
  }
  if (current.length) chunks.push(current.join(" "));
  return chunks;
}

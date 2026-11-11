/**
 * A verification batch (ADR 0016, 11 Nov 2026): several questions in one call, in a shuffled order so position
 * says nothing, each under an id its verdict must carry. Verdicts are matched back by id; a question with no
 * verdict, two, or one that isn't a verdict fails closed on its own, and the rest of the batch stands. Every vendor
 * adapter uses this, so the matching rule lives in one place.
 */
import type { VerifyInput, VerifyVerdict } from "../types.js";
import { permutation } from "../drafting/shuffle.js";
import { isVerdict } from "./verifyPrompt.js";

export interface BatchItem {
  id: string;
  /** Where the question was in the caller's list. */
  index: number;
  q: VerifyInput;
}

/** What one verdict in the reply says (vendor fields like sourceUrls ride along). */
export interface RawVerdict {
  id: string;
  verdict: VerifyVerdict["verdict"];
  foundAnswer?: string;
  note?: string;
  sourceUrls?: string[];
}

/** The questions in a seeded shuffled order (the same batch always shuffles the same way), each with an id. */
export function shuffledBatch(qs: VerifyInput[]): BatchItem[] {
  const order = permutation(qs.length, qs.map((q) => q.claim).join("\n"));
  return order.map((index, k) => ({ id: `q${k + 1}`, index, q: qs[index] }));
}

/** The verdict list's JSON schema, with a vendor's own fields on each verdict. */
export function verdictsSchema(fields: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["verdicts"],
    properties: { verdicts: { type: "array", items: { type: "object", additionalProperties: false, required, properties: fields } } },
  };
}

/** A failed-closed verdict for one question of the batch. */
export const failedClosed = (why: string, verifiedBy: VerifyVerdict["verifiedBy"]): VerifyVerdict =>
  ({ verdict: "unverifiable", sources: [], note: `${why} (fails closed)`, ...(verifiedBy ? { verifiedBy } : {}) });

/**
 * The reply's verdicts by id, each turned into a verdict by `build`, in the caller's order. Missing, repeated or
 * malformed: that question fails closed. An id that isn't in the batch is ignored (and said).
 */
export function matchVerdicts(items: BatchItem[], reply: unknown, build: (v: RawVerdict, item: BatchItem) => VerifyVerdict, verifiedBy: VerifyVerdict["verifiedBy"]): VerifyVerdict[] {
  const list = (reply as { verdicts?: unknown })?.verdicts;
  const out = new Array<VerifyVerdict>(items.length);
  if (!Array.isArray(list)) {
    console.warn(`[questions] verifier: the reply had no verdict list; ${items.length} question(s) fail closed`);
    for (const item of items) out[item.index] = failedClosed("the verifier's reply had no verdict list", verifiedBy);
    return out;
  }
  const byId = new Map<string, unknown[]>();
  for (const v of list) {
    const id = typeof (v as { id?: unknown })?.id === "string" ? (v as { id: string }).id : "";
    byId.set(id, [...(byId.get(id) ?? []), v]);
  }
  const known = new Set(items.map((i) => i.id));
  const extra = [...byId.keys()].filter((id) => !known.has(id));
  if (extra.length) console.warn(`[questions] verifier: ignored ${extra.length} verdict(s) for ids not in the batch`);
  for (const item of items) {
    const found = byId.get(item.id) ?? [];
    if (!found.length) out[item.index] = failedClosed("no verdict for this question", verifiedBy);
    else if (found.length > 1) out[item.index] = failedClosed("more than one verdict for this question", verifiedBy);
    else {
      const raw = wellFormed(found[0]);
      out[item.index] = raw ? build(raw, item) : failedClosed("a malformed verdict", verifiedBy);
    }
  }
  return out;
}

function wellFormed(v: unknown): RawVerdict | null {
  const o = v as Record<string, unknown>;
  if (!o || typeof o !== "object" || !isVerdict(o.verdict)) return null;
  const optString = (x: unknown) => x === undefined || typeof x === "string";
  if (!optString(o.foundAnswer) || !optString(o.note)) return null;
  if (o.sourceUrls !== undefined && !(Array.isArray(o.sourceUrls) && o.sourceUrls.every((u) => typeof u === "string"))) return null;
  return { id: o.id as string, verdict: o.verdict, foundAnswer: (o.foundAnswer as string) || undefined, note: (o.note as string) || undefined, ...(o.sourceUrls ? { sourceUrls: o.sourceUrls as string[] } : {}) };
}

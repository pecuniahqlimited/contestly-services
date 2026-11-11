/**
 * Verification results cached per question (ADR 0016): the same question, checked by the same verifier and
 * model against the same source, is paid for once, and a batch only ever sends the questions the cache doesn't
 * have. The key hashes everything the verdict depends on. Only definite answers are cached: "unverifiable" may
 * be a search that came up empty this time (or a question the batch failed closed), and an unavailable verifier
 * throws, so neither is stored.
 */
import { createHash } from "node:crypto";
import { cachedVerification, cacheVerification } from "@contestly/db";
import type { Verifier, VerifyInput, VerifyVerdict } from "./types.js";

export interface VerificationCache {
  get(key: string): Promise<unknown | null>;
  put(key: string, model: string, verdict: VerifyVerdict): Promise<void>;
}

export const dbVerificationCache: VerificationCache = { get: cachedVerification, put: cacheVerification };

/** Stable JSON: object keys sorted, so the same payload always hashes the same. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

export const verificationKey = (verifier: string, model: string, q: VerifyInput) =>
  createHash("sha256").update(canonical({ verifier, model, format: q.format, payload: q.payload, claim: q.claim, explanation: q.explanation ?? null, sourceText: q.sourceText ?? null })).digest("hex");

export function cachedVerifier(inner: Verifier, model: () => Promise<string>, cache: VerificationCache = dbVerificationCache): Verifier {
  return {
    name: inner.name,
    async verifyBatch(qs) {
      const m = await model();
      const keys = qs.map((q) => verificationKey(inner.name, m, q));
      const out = new Array<VerifyVerdict>(qs.length);
      const misses: number[] = [];
      for (const [i, key] of keys.entries()) {
        const hit = (await cache.get(key)) as VerifyVerdict | null;
        if (hit) out[i] = { ...hit, verifiedBy: { provider: hit.verifiedBy?.provider ?? inner.name, model: hit.verifiedBy?.model ?? m, cached: true } };
        else misses.push(i);
      }
      if (!misses.length) return out;
      const fresh = await inner.verifyBatch(misses.map((i) => qs[i]));
      for (const [k, i] of misses.entries()) {
        out[i] = fresh[k];
        if (fresh[k].verdict !== "unverifiable") await cache.put(keys[i], m, fresh[k]);
      }
      return out;
    },
  };
}

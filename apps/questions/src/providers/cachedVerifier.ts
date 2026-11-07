/**
 * Verification results cached per question (ADR 0016): the same question, checked by the same verifier and
 * model against the same source, is paid for once. The key hashes everything the verdict depends on. Only
 * definite answers are cached: "unverifiable" may be a search that came up empty this time, and an
 * unavailable verifier throws, so neither is stored.
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
    async verify(q) {
      const m = await model();
      const key = verificationKey(inner.name, m, q);
      const hit = (await cache.get(key)) as VerifyVerdict | null;
      if (hit) return { ...hit, verifiedBy: { provider: hit.verifiedBy?.provider ?? inner.name, model: hit.verifiedBy?.model ?? m, cached: true } };
      const verdict = await inner.verify(q);
      if (verdict.verdict !== "unverifiable") await cache.put(key, m, verdict);
      return verdict;
    },
  };
}

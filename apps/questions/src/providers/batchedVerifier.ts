/**
 * Questions to a verifier in batches of the admin's size (questions.providers.verifyBatchSize, read per call),
 * a couple of batches at a time. A batch whose reply was unusable (malformed or refused after the call path's
 * retries) fails only its own questions closed; any other unavailability (budget, quota, a circuit open, the
 * provider down) is thrown, and the pipeline stops calling the verifier.
 */
import { ProviderUnavailable } from "@contestly/ai";
import { mapLimit } from "../pipeline/concurrency.js";
import { failedClosed } from "./checks/verifyBatch.js";
import type { Verifier, VerifyVerdict } from "./types.js";

/** Batch calls in flight at once. */
export const VERIFY_BATCHES_AT_ONCE = 2;

export function batchedVerifier(inner: Verifier, batchSize: () => Promise<number>): Verifier {
  return {
    name: inner.name,
    async verifyBatch(qs) {
      if (!qs.length) return [];
      const size = Math.max(1, await batchSize());
      const batches = Array.from({ length: Math.ceil(qs.length / size) }, (_, b) => qs.slice(b * size, (b + 1) * size));
      const results = await mapLimit(batches, VERIFY_BATCHES_AT_ONCE, async (batch): Promise<VerifyVerdict[]> => {
        try {
          return await inner.verifyBatch(batch);
        } catch (err) {
          if (!(err instanceof ProviderUnavailable) || (err.kind !== "malformed" && err.kind !== "refused")) throw err;
          return batch.map(() => failedClosed(`the verifier's reply couldn't be used (${err.kind})`, undefined));
        }
      });
      return results.flat();
    },
  };
}

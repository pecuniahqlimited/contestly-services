/**
 * What a provider call is part of: the party (for its budget and the usage view) and the job. Set once where a
 * job starts (withCallContext) and read by providerCall, so the vendor-neutral provider interfaces don't carry
 * bookkeeping parameters through every pipeline step.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { ProviderStep } from "@contestly/shared";

/** What a piece of work (a question set) spent on providers: every call made inside it adds to it. */
export interface CallTally {
  calls: number;
  failed: number;
  byStep: Partial<Record<ProviderStep, number>>;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

export const newTally = (): CallTally => ({ calls: 0, failed: 0, byStep: {}, inputTokens: 0, outputTokens: 0, costMicros: 0 });

/** "6 calls (generate 1, verify 2, safety 1, embed 2), 12,400 in / 5,100 out tokens, $0.0123". */
export function describeTally(t: CallTally): string {
  const steps = Object.entries(t.byStep).map(([s, n]) => `${s} ${n}`).join(", ");
  return `${t.calls} call${t.calls === 1 ? "" : "s"}${steps ? ` (${steps})` : ""}${t.failed ? `, ${t.failed} failed` : ""}, ` +
    `${t.inputTokens.toLocaleString("en")} in / ${t.outputTokens.toLocaleString("en")} out tokens, $${(t.costMicros / 1_000_000).toFixed(4)}`;
}

export interface CallContext {
  partyId?: string | null;
  /** The job or script the call belongs to: "generate_set", "transcribe_voice", "eval". */
  job?: string | null;
  /** Totals for the work in hand (a set), when someone is counting. */
  tally?: CallTally;
}

const storage = new AsyncLocalStorage<CallContext>();

export const withCallContext = <T>(ctx: CallContext, fn: () => Promise<T>): Promise<T> => storage.run(ctx, fn);

export const currentCallContext = (): CallContext => storage.getStore() ?? {};

/** Run `fn` counting its provider calls (inside whatever context is current), and return both. */
export async function tallied<T>(fn: () => Promise<T>): Promise<{ value: T; tally: CallTally }> {
  const tally = newTally();
  const value = await withCallContext({ ...currentCallContext(), tally }, fn);
  return { value, tally };
}

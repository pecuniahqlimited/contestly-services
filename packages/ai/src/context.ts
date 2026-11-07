/**
 * What a provider call is part of: the party (for its budget and the usage view) and the job. Set once where a
 * job starts (withCallContext) and read by providerCall, so the vendor-neutral provider interfaces don't carry
 * bookkeeping parameters through every pipeline step.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface CallContext {
  partyId?: string | null;
  /** The job or script the call belongs to: "generate_set", "transcribe_voice", "eval". */
  job?: string | null;
}

const storage = new AsyncLocalStorage<CallContext>();

export const withCallContext = <T>(ctx: CallContext, fn: () => Promise<T>): Promise<T> => storage.run(ctx, fn);

export const currentCallContext = (): CallContext => storage.getStore() ?? {};

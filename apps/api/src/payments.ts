/** The API's side of the payments module: its job queue and its Valkey store, passed in (ADR 0013). */
import { paymentsQueue } from "@contestly/queue";
import type { KeyValue, PaymentsDeps } from "@contestly/payments";
import { valkey } from "./redis.js";

let queue: ReturnType<typeof paymentsQueue> | undefined;
export const paymentsDeps: PaymentsDeps = {
  async enqueue(job, opts) {
    await (queue ??= paymentsQueue()).add(job.kind, job, { jobId: opts?.jobId, delay: opts?.delayMs });
  },
};

export const paymentsKv: KeyValue = {
  get: (k) => valkey().get(k),
  async set(k, v, ttl) { await valkey().set(k, v, "EX", ttl); },
  async del(k) { await valkey().del(k); },
};

/** Where the provider sends the person back after checkout (the app polls GET /wallet/topups/:reference). */
export const topupReturnUrl = () => process.env.PAYMENTS_RETURN_URL || null;
/** PAYMENTS_WEBHOOK_IP_ALLOWLIST=true: only the provider's published addresses may post webhooks. */
export const webhookIpAllowlist = () => process.env.PAYMENTS_WEBHOOK_IP_ALLOWLIST === "true";

/**
 * The payments worker (ADR 0013): webhooks stored by the API, top-up checks, sending and checking withdrawals,
 * the minute sweep that finds whatever is due, the hourly invariants and the nightly reconciliation. Every job
 * is safe to run twice: the transitions lock the row and look at its state first.
 */
import { Worker } from "bullmq";
import { QUEUE_PREFIX, makeRedis, paymentsQueue } from "@contestly/queue";
import { CLIMB_TIME_ZONE, QUEUES, lagosDay, type PaymentsJob } from "@contestly/shared";
import {
  assertPaymentsEnv, checkPayout, configuredProviderNames, confirmTopup, processWebhookEvent, reconcileDay, runInvariants, submitPayout, sweepDue, type PaymentsDeps,
} from "@contestly/payments";
import { schedule } from "./liveness.js";

assertPaymentsEnv();

const jobs = paymentsQueue();
const deps: PaymentsDeps = { async enqueue(job, opts) { await jobs.add(job.kind, job, { jobId: opts?.jobId, delay: opts?.delayMs }); } };
const DAY_MS = 24 * 3600_000;

async function run(job: PaymentsJob) {
  switch (job.kind) {
    case "webhook": return processWebhookEvent(job.eventId);
    case "topup_check": return confirmTopup(job.topupId, "check");
    case "payout_submit": return submitPayout(job.payoutId);
    case "payout_check": return checkPayout(job.payoutId, "check");
    case "sweep": return sweepDue(deps);
    case "invariants": {
      const out = await runInvariants();
      if (out.breaches.length) console.error(`[payments] invariant breach: ${out.breaches.map((b) => b.kind).join(", ")}${out.paused ? " — payouts paused" : ""}`);
      return out.breaches.length;
    }
    case "reconcile": {
      const day = job.day ?? lagosDay(new Date(Date.now() - DAY_MS));
      for (const provider of job.provider ? [job.provider] : configuredProviderNames()) await reconcileDay(provider, day);
      return day;
    }
  }
}

export const paymentsWorker = new Worker<PaymentsJob>(QUEUES.payments, (job) => run(job.data), { connection: makeRedis(), prefix: QUEUE_PREFIX });
paymentsWorker.on("failed", (job, err) => console.error(`[payments] job ${job?.name} ${job?.id} failed:`, err.message));

/** Every minute; hourly at :05; nightly at 02:30 Lagos for the day before. */
const SWEEP_EVERY_MS = 60_000;
await schedule(jobs, "sweep", { every: SWEEP_EVERY_MS }, { kind: "sweep" }, SWEEP_EVERY_MS);
await schedule(jobs, "invariants", { pattern: "5 * * * *", tz: CLIMB_TIME_ZONE }, { kind: "invariants" }, 3600_000);
await schedule(jobs, "reconcile", { pattern: "30 2 * * *", tz: CLIMB_TIME_ZONE }, { kind: "reconcile" }, DAY_MS);

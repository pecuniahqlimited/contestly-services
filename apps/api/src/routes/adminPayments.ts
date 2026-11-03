import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPaymentsConfig } from "@contestly/db";
import {
  adminFinalizeBodySchema, adminFinalizeResponseSchema, adminPaymentListQuerySchema, adminPaymentPermissionsBodySchema, adminPaymentSettingsBodySchema,
  adminPaymentsConfigBodySchema, adminReasonBodySchema, owedListSchema, owedWaiverSchema, paymentConfigChangeSchema, permissionGrantSchema, invariantAcknowledgmentSchema, acknowledgeBreachBodySchema, paymentSettingsSchema, payoutContradictionSchema, providerCheckSchema,
} from "@contestly/shared";
import {
  acknowledgeAlert, adminVerifyTopup, confirmLinkedIssueClearance, requestLinkedIssueClearance, approvePayout, confirmContradictionResolution, confirmControlChange, confirmFinalization, currentSettings, finalizationsFor, freshCheck,
  listAlerts, listContradictions, listControlChanges, listPayouts, listReconciliation, listTopups, listWebhooks, paymentsOverview, permissionsOf, proposeControlChange,
  rejectionSummary, rejectPayout, requestContradictionResolution, requestFinalization, resolveReconItem, runInvariants, setPermissions,
  confirmAcknowledgment, listAcknowledgments, requestAcknowledgment, confirmOwedWaiver, confirmPermissionGrant, listOwed, listOwedWaivers, listPermissionGrants, requestOwedWaiver,
} from "@contestly/payments";
import { requirePermission, uuidParam } from "../auth.js";
import { paymentsDeps } from "../payments.js";

const checkView = (c: Awaited<ReturnType<typeof freshCheck>>) => providerCheckSchema.parse({ status: c.status, providerStatus: c.providerStatus, amountKobo: c.amountKobo, checkedAt: c.checkedAt, error: c.error });
const limitQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), open: z.enum(["true", "false"]).optional() });
const reconRunSchema = z.object({ provider: z.string().min(1), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

/**
 * The console's payments pages (ADR 0013). Each route names the permission it needs: payments.view (read),
 * payments.approve (payouts over the threshold), payments.finalize (stuck transactions, alerts, reconciliation
 * notes, contradictions), payments.config (providers, pauses, limits, who holds which permission). Every write
 * is logged. Maker-checker: a finalize the provider doesn't back (or over the threshold), resolving a
 * contradiction, and any change that loosens a control each need a second admin.
 */
export async function adminPaymentsRoutes(app: FastifyInstance) {
  app.get("/admin/payments", async (req) => {
    await requirePermission(req, "payments.view");
    return paymentsOverview();
  });
  app.get("/admin/payments/topups", async (req) => {
    await requirePermission(req, "payments.view");
    return { topups: await listTopups(adminPaymentListQuerySchema.parse(req.query)) };
  });
  app.get("/admin/payments/payouts", async (req) => {
    await requirePermission(req, "payments.view");
    return { payouts: await listPayouts(adminPaymentListQuerySchema.parse(req.query)) };
  });
  app.get("/admin/payments/webhooks", async (req) => {
    await requirePermission(req, "payments.view");
    return { webhooks: await listWebhooks(limitQuery.parse(req.query).limit), rejections: await rejectionSummary() };
  });
  app.get("/admin/payments/alerts", async (req) => {
    await requirePermission(req, "payments.view");
    const q = limitQuery.parse(req.query);
    return { alerts: await listAlerts(q.open !== "false", q.limit) };
  });
  app.get("/admin/payments/reconciliation", async (req) => {
    await requirePermission(req, "payments.view");
    return { runs: await listReconciliation(limitQuery.parse(req.query).limit) };
  });

  // ---- Approval ----
  app.post("/admin/payments/payouts/:id/approve", async (req) => {
    const admin = await requirePermission(req, "payments.approve");
    return { payout: await approvePayout(admin.id, uuidParam(req), paymentsDeps) };
  });
  app.post("/admin/payments/payouts/:id/reject", async (req) => {
    const admin = await requirePermission(req, "payments.approve");
    const { reason } = adminReasonBodySchema.parse(req.body);
    return { payout: await rejectPayout(admin.id, uuidParam(req), reason) };
  });

  // ---- Finalize: see the provider's answer first, then decide (a second admin above the threshold) ----
  for (const type of ["payout", "topup"] as const) {
    app.get(`/admin/payments/${type}s/:id/check`, async (req) => {
      await requirePermission(req, "payments.finalize");
      const id = uuidParam(req);
      return { check: checkView(await freshCheck({ type, id })), finalizations: await finalizationsFor(id) };
    });
    app.post(`/admin/payments/${type}s/:id/finalize`, async (req) => {
      const admin = await requirePermission(req, "payments.finalize");
      const { outcome, reason } = adminFinalizeBodySchema.parse(req.body);
      return adminFinalizeResponseSchema.parse({ finalization: await requestFinalization(admin.id, { type, id: uuidParam(req) }, outcome, reason) });
    });
  }
  app.post("/admin/payments/finalizations/:id/confirm", async (req) => {
    const admin = await requirePermission(req, "payments.finalize");
    return adminFinalizeResponseSchema.parse({ finalization: await confirmFinalization(admin.id, uuidParam(req)) });
  });
  /** Replay the normal verify for a top-up (a missed webhook a reconciliation found). Same checks; credits at most once. */
  app.post("/admin/payments/topups/:id/verify", async (req) => {
    const admin = await requirePermission(req, "payments.finalize");
    const { reason } = adminReasonBodySchema.parse(req.body);
    return { outcome: await adminVerifyTopup(admin.id, uuidParam(req), reason) };
  });
  app.post("/admin/payments/alerts/:id/ack", async (req) => {
    const admin = await requirePermission(req, "payments.finalize");
    return { alert: await acknowledgeAlert(admin.id, uuidParam(req)) };
  });
  app.post("/admin/payments/reconciliation/items/:id/resolve", async (req) => {
    const admin = await requirePermission(req, "payments.finalize");
    const { reason } = adminReasonBodySchema.parse(req.body);
    return { item: await resolveReconItem(admin.id, uuidParam(req), reason) };
  });
  app.post("/admin/payments/reconciliation/run", async (req) => {
    await requirePermission(req, "payments.finalize");
    const body = reconRunSchema.parse(req.body);
    await paymentsDeps.enqueue({ kind: "reconcile", provider: body.provider, day: body.day });
    return { queued: true };
  });
  // ---- Contradictions: a reversed payout the provider says was paid (the person's withdrawals are frozen) ----
  app.get("/admin/payments/contradictions", async (req) => {
    await requirePermission(req, "payments.view");
    const q = limitQuery.parse(req.query);
    return { contradictions: (await listContradictions(q.open !== "false", q.limit)).map((c) => payoutContradictionSchema.parse(c)) };
  });
  app.post("/admin/payments/contradictions/:id/resolve", async (req) => {
    const admin = await requirePermission(req, "payments.finalize");
    const { reason } = adminReasonBodySchema.parse(req.body);
    return { contradiction: payoutContradictionSchema.parse(await requestContradictionResolution(admin.id, uuidParam(req), reason)) };
  });
  /** The second admin: re-applies the debit up to the cash there, records the rest as owed, unfreezes. */
  app.post("/admin/payments/contradictions/:id/confirm", async (req) => {
    const admin = await requirePermission(req, "payments.finalize");
    return { contradiction: payoutContradictionSchema.parse(await confirmContradictionResolution(admin.id, uuidParam(req))) };
  });

  // ---- What people owe after a duplicate payout; waiving it takes two admins ----
  app.get("/admin/payments/owed", async (req) => {
    await requirePermission(req, "payments.view");
    return owedListSchema.parse({ owed: await listOwed(limitQuery.parse(req.query).limit) });
  });
  app.get("/admin/payments/owed-waivers", async (req) => {
    await requirePermission(req, "payments.view");
    return { waivers: (await listOwedWaivers(limitQuery.parse(req.query).limit)).map((w) => owedWaiverSchema.parse(w)) };
  });
  app.post("/admin/payments/users/:id/owed/waive", async (req) => {
    const admin = await requirePermission(req, "payments.finalize");
    const { reason } = adminReasonBodySchema.parse(req.body);
    return { waiver: owedWaiverSchema.parse(await requestOwedWaiver(admin.id, uuidParam(req), reason)) };
  });
  /** The second admin: the platform bears what's still owed, up to what was asked. */
  app.post("/admin/payments/owed-waivers/:id/confirm", async (req) => {
    const admin = await requirePermission(req, "payments.finalize");
    return { waiver: owedWaiverSchema.parse(await confirmOwedWaiver(admin.id, uuidParam(req))) };
  });

  /**
   * A new account matching a deleted one with a payment issue (same email or phone): an admin checked it and
   * asks to let it withdraw (202); a different admin confirms. Neither may be the account holder.
   */
  app.post("/admin/payments/users/:id/clear-linked-issue", async (req, reply) => {
    const admin = await requirePermission(req, "payments.finalize");
    const { reason } = adminReasonBodySchema.parse(req.body);
    return reply.code(202).send({ clearance: await requestLinkedIssueClearance(admin.id, uuidParam(req), reason) });
  });
  app.post("/admin/payments/linked-issue-clearances/:id/confirm", async (req) => {
    const admin = await requirePermission(req, "payments.finalize");
    return { clearance: await confirmLinkedIssueClearance(admin.id, uuidParam(req)) };
  });

  /** Run the invariant checks now (they also run hourly). A breach that repeats alerts and pauses payouts. */
  app.post("/admin/payments/invariants/run", async (req) => {
    await requirePermission(req, "payments.finalize");
    return runInvariants();
  });

  /** Acknowledge a breach as it stands now (payments.config, then a second admin): the same, no larger, won't pause payouts again. */
  app.post("/admin/payments/invariants/acknowledge", async (req) => {
    const admin = await requirePermission(req, "payments.config");
    const { kind, reason } = acknowledgeBreachBodySchema.parse(req.body);
    return { acknowledgment: invariantAcknowledgmentSchema.parse(await requestAcknowledgment(admin.id, kind, reason)) };
  });
  app.post("/admin/payments/invariant-acknowledgments/:id/confirm", async (req) => {
    const admin = await requirePermission(req, "payments.config");
    return { acknowledgment: invariantAcknowledgmentSchema.parse(await confirmAcknowledgment(admin.id, uuidParam(req))) };
  });
  app.get("/admin/payments/invariant-acknowledgments", async (req) => {
    await requirePermission(req, "payments.view");
    return { acknowledgments: (await listAcknowledgments(limitQuery.parse(req.query).limit)).map((a) => invariantAcknowledgmentSchema.parse(a)) };
  });

  // ---- Config ----
  app.get("/admin/payments/settings", async (req) => {
    await requirePermission(req, "payments.view");
    return { settings: paymentSettingsSchema.parse(await currentSettings()) };
  });
  /**
   * Providers and kill switches. Transactions already started finish with their own provider. Pausing payouts
   * never reverses one. Pausing applies at once; switching a provider or un-pausing waits for a second admin (202).
   */
  app.put("/admin/payments/settings", async (req, reply) => {
    const admin = await requirePermission(req, "payments.config");
    const { reason, ...change } = adminPaymentSettingsBodySchema.parse(req.body);
    const out = await proposeControlChange(admin.id, "settings", change, reason);
    return reply.code(out.applied ? 200 : 202).send({ settings: paymentSettingsSchema.parse(await currentSettings()), change: out.change && paymentConfigChangeSchema.parse(out.change) });
  });
  app.get("/admin/payments/config", async (req) => {
    await requirePermission(req, "payments.view");
    return { config: await getPaymentsConfig() };
  });
  /** Limits and thresholds. Lowering a limit applies at once; anything that loosens waits for a second admin (202). */
  app.put("/admin/payments/config", async (req, reply) => {
    const admin = await requirePermission(req, "payments.config");
    const { config, reason } = adminPaymentsConfigBodySchema.parse(req.body);
    const out = await proposeControlChange(admin.id, "config", config, reason);
    return reply.code(out.applied ? 200 : 202).send({ config: await getPaymentsConfig(), change: out.change && paymentConfigChangeSchema.parse(out.change) });
  });
  app.get("/admin/payments/config-changes", async (req) => {
    await requirePermission(req, "payments.view");
    return { changes: (await listControlChanges(limitQuery.parse(req.query).limit)).map((c) => paymentConfigChangeSchema.parse(c)) };
  });
  /** A second payments.config holder confirms a loosening change; superseded instead if the config moved since. */
  app.post("/admin/payments/config-changes/:id/confirm", async (req) => {
    const admin = await requirePermission(req, "payments.config");
    return { change: paymentConfigChangeSchema.parse(await confirmControlChange(admin.id, uuidParam(req))) };
  });
  app.get("/admin/payments/permissions/:id", async (req) => {
    await requirePermission(req, "payments.config");
    return { permissions: await permissionsOf(uuidParam(req)) };
  });
  /** Revoking applies at once; anything granted waits for a second payments.config holder (202, pendingGrant). */
  app.put("/admin/payments/permissions/:id", async (req, reply) => {
    const admin = await requirePermission(req, "payments.config");
    const { permissions, reason } = adminPaymentPermissionsBodySchema.parse(req.body);
    const out = await setPermissions(admin.id, uuidParam(req), permissions, reason);
    return reply.code(out.pendingGrant ? 202 : 200).send({ permissions: out.permissions, pendingGrant: out.pendingGrant && permissionGrantSchema.parse(out.pendingGrant) });
  });
  app.get("/admin/payments/permission-grants", async (req) => {
    await requirePermission(req, "payments.config");
    return { grants: (await listPermissionGrants(limitQuery.parse(req.query).limit)).map((g) => permissionGrantSchema.parse(g)) };
  });
  /** A second payments.config holder confirms: not whoever asked, never the grantee. */
  app.post("/admin/payments/permission-grants/:id/confirm", async (req) => {
    const admin = await requirePermission(req, "payments.config");
    return { grant: permissionGrantSchema.parse(await confirmPermissionGrant(admin.id, uuidParam(req))) };
  });
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, getPaymentsConfig, recordAdminAction, setPaymentsConfig } from "@contestly/db";
import {
  adminFinalizeBodySchema, adminFinalizeResponseSchema, adminPaymentListQuerySchema, adminPaymentPermissionsBodySchema, adminPaymentSettingsBodySchema,
  adminPaymentsConfigBodySchema, adminReasonBodySchema, paymentSettingsSchema, providerCheckSchema,
} from "@contestly/shared";
import {
  acknowledgeAlert, adminVerifyTopup, approvePayout, confirmFinalization, currentSettings, finalizationsFor, freshCheck, listAlerts, listPayouts, listReconciliation,
  listTopups, listWebhooks, paymentsOverview, permissionsOf, rejectPayout, requestFinalization, resolveReconItem, runInvariants, saveSettings, setPermissions,
} from "@contestly/payments";
import { requirePermission, uuidParam } from "../auth.js";
import { paymentsDeps } from "../payments.js";

const checkView = (c: Awaited<ReturnType<typeof freshCheck>>) => providerCheckSchema.parse({ status: c.status, providerStatus: c.providerStatus, amountKobo: c.amountKobo, checkedAt: c.checkedAt, error: c.error });
const limitQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), open: z.enum(["true", "false"]).optional() });
const reconRunSchema = z.object({ provider: z.string().min(1), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

/**
 * The console's payments pages (ADR 0012). Each route names the permission it needs: payments.view (read),
 * payments.approve (payouts over the threshold), payments.finalize (stuck transactions, alerts, reconciliation
 * notes), payments.config (providers, pauses, limits, who holds which permission). Every write is logged.
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
    return { webhooks: await listWebhooks(limitQuery.parse(req.query).limit) };
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
  /** Run the invariant checks now (they also run hourly). A breach alerts and pauses payouts. */
  app.post("/admin/payments/invariants/run", async (req) => {
    await requirePermission(req, "payments.finalize");
    return runInvariants();
  });

  // ---- Config ----
  app.get("/admin/payments/settings", async (req) => {
    await requirePermission(req, "payments.view");
    return { settings: paymentSettingsSchema.parse(await currentSettings()) };
  });
  /** Providers and kill switches. Transactions already started finish with their own provider. Pausing payouts never reverses one. */
  app.put("/admin/payments/settings", async (req) => {
    const admin = await requirePermission(req, "payments.config");
    const { reason, ...change } = adminPaymentSettingsBodySchema.parse(req.body);
    await db.transaction(async (tx) => {
      const before = await currentSettings(tx);
      await saveSettings(tx, { ...change, reason }, admin.id);
      await recordAdminAction(tx, { adminUserId: admin.id, action: "config.payments_settings", targetType: "config", targetId: "payments_settings", reason, before, after: change });
    });
    return { settings: paymentSettingsSchema.parse(await currentSettings()) };
  });
  app.get("/admin/payments/config", async (req) => {
    await requirePermission(req, "payments.view");
    return { config: await getPaymentsConfig() };
  });
  app.put("/admin/payments/config", async (req) => {
    const admin = await requirePermission(req, "payments.config");
    const { config, reason } = adminPaymentsConfigBodySchema.parse(req.body);
    const before = await getPaymentsConfig();
    const saved = await setPaymentsConfig(config);
    await recordAdminAction(db, { adminUserId: admin.id, action: "config.payments", targetType: "config", targetId: "payments", reason, before, after: saved });
    return { config: saved };
  });
  app.get("/admin/payments/permissions/:id", async (req) => {
    await requirePermission(req, "payments.config");
    return { permissions: await permissionsOf(uuidParam(req)) };
  });
  app.put("/admin/payments/permissions/:id", async (req) => {
    const admin = await requirePermission(req, "payments.config");
    const { permissions, reason } = adminPaymentPermissionsBodySchema.parse(req.body);
    return { permissions: await setPermissions(admin.id, uuidParam(req), permissions, reason) };
  });
}

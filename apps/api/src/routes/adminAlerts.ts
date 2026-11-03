import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { acknowledgeAdminAlert, adminAlerts, db, listAdminAlerts, openAlertCounts, raiseTestAlert, type AdminAlertRow, type User } from "@contestly/db";

/** Alerts raised by payments (ADR 0013): payments.view to see them, payments.finalize to acknowledge them. */
const PAYMENTS_ALERT_PREFIX = "payments.";
import { adminAlertAckResponseSchema, adminAlertAckSchema, adminAlertSchema, adminAlertTestResponseSchema, adminAlertTestSchema, type AlertSeverity, adminAlertsQuerySchema, adminAlertsResponseSchema, adminAlertsSummarySchema, type AdminAlert } from "@contestly/shared";
import { holdsPermission, requireAdmin, requirePermission, uuidParam } from "../auth.js";
import { toPerson } from "../people.js";
import { httpError } from "../httpError.js";

const alertView = (a: AdminAlertRow, ackedBy: User | null): AdminAlert => adminAlertSchema.parse({
  id: a.id, kind: a.kind, severity: a.severity, subject: a.subject, details: a.details, refType: a.refType, refId: a.refId,
  firstSeenAt: a.firstSeenAt.toISOString(), lastSeenAt: a.lastSeenAt.toISOString(), count: a.count,
  acknowledgedBy: ackedBy ? toPerson(ackedBy) : null, acknowledgedAt: a.acknowledgedAt?.toISOString() ?? null, ackNote: a.ackNote,
});

/** What the worker will do with an alert of this severity (alertDelivery.ts), for the test endpoint's answer. */
const DELIVERY: Record<AlertSeverity, string> = {
  critical: "email (ADMIN_ALERT_EMAILS) and the webhook, if set, within 15 seconds",
  warning: "the next email digest (ADMIN_ALERT_DIGEST_MINUTES), and the webhook only if it takes warnings",
  info: "the console's alert list only",
};

/** Admin alerts (raised with adminAlert() in packages/db, delivered by the worker): the list, the home badge, acknowledging. */
export async function adminAlertsRoutes(app: FastifyInstance) {
  /** Newest first by last seen; ?severity=&kind=&state=open|acknowledged|all&before=&limit=. */
  app.get("/admin/alerts", async (req) => {
    requireAdmin(req);
    const q = adminAlertsQuerySchema.parse(req.query);
    // Payments alerts (kind payments.*) are for admins with payments.view (ADR 0013); everyone else's list leaves them out.
    const seesPayments = await holdsPermission(req, "payments.view");
    if (q.kind?.startsWith(PAYMENTS_ALERT_PREFIX) && !seesPayments) await requirePermission(req, "payments.view");
    const rows = await listAdminAlerts({ ...q, excludeKindPrefix: seesPayments ? undefined : PAYMENTS_ALERT_PREFIX });
    return adminAlertsResponseSchema.parse({ alerts: rows.map((r) => alertView(r.alert, r.ackedBy)) });
  });

  /** Open alerts by severity, for the admin home (it shows the critical count). */
  app.get("/admin/alerts/summary", async (req) => {
    requireAdmin(req);
    return adminAlertsSummarySchema.parse({ open: await openAlertCounts() });
  });

  /** A test alert of this severity through the normal delivery path, to check each channel. Logged. */
  app.post("/admin/alerts/test", async (req) => {
    const admin = requireAdmin(req);
    const { severity } = adminAlertTestSchema.parse(req.body);
    const alert = await raiseTestAlert(admin, severity);
    return adminAlertTestResponseSchema.parse({ alert: alertView(alert, null), delivery: DELIVERY[severity] });
  });

  /** Acknowledge with a note (what was found or done), logged. A second acknowledge answers the first (replayed). */
  app.post("/admin/alerts/:id/ack", async (req) => {
    const admin = requireAdmin(req);
    const id = uuidParam(req);
    // Acknowledging a payments alert takes payments.finalize.
    const [target] = await db.select({ kind: adminAlerts.kind }).from(adminAlerts).where(eq(adminAlerts.id, id));
    if (target?.kind.startsWith(PAYMENTS_ALERT_PREFIX)) await requirePermission(req, "payments.finalize");
    const { note } = adminAlertAckSchema.parse(req.body);
    const done = await acknowledgeAdminAlert(admin.id, id, note);
    if (!done) throw httpError(404, "not_found");
    return adminAlertAckResponseSchema.parse({ alert: alertView(done.alert, done.ackedBy), replayed: done.replayed });
  });
}

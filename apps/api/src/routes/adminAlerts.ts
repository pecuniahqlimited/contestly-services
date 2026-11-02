import type { FastifyInstance } from "fastify";
import { acknowledgeAdminAlert, listAdminAlerts, openAlertCounts, type AdminAlertRow, type User } from "@contestly/db";
import { adminAlertAckResponseSchema, adminAlertAckSchema, adminAlertSchema, adminAlertsQuerySchema, adminAlertsResponseSchema, adminAlertsSummarySchema, type AdminAlert } from "@contestly/shared";
import { requireAdmin, uuidParam } from "../auth.js";
import { toPerson } from "../people.js";
import { httpError } from "../httpError.js";

const alertView = (a: AdminAlertRow, ackedBy: User | null): AdminAlert => adminAlertSchema.parse({
  id: a.id, kind: a.kind, severity: a.severity, subject: a.subject, details: a.details, refType: a.refType, refId: a.refId,
  firstSeenAt: a.firstSeenAt.toISOString(), lastSeenAt: a.lastSeenAt.toISOString(), count: a.count,
  acknowledgedBy: ackedBy ? toPerson(ackedBy) : null, acknowledgedAt: a.acknowledgedAt?.toISOString() ?? null, ackNote: a.ackNote,
});

/** Admin alerts (raised with adminAlert() in packages/db, delivered by the worker): the list, the home badge, acknowledging. */
export async function adminAlertsRoutes(app: FastifyInstance) {
  /** Newest first by last seen; ?severity=&kind=&state=open|acknowledged|all&before=&limit=. */
  app.get("/admin/alerts", async (req) => {
    requireAdmin(req);
    const rows = await listAdminAlerts(adminAlertsQuerySchema.parse(req.query));
    return adminAlertsResponseSchema.parse({ alerts: rows.map((r) => alertView(r.alert, r.ackedBy)) });
  });

  /** Open alerts by severity, for the admin home (it shows the critical count). */
  app.get("/admin/alerts/summary", async (req) => {
    requireAdmin(req);
    return adminAlertsSummarySchema.parse({ open: await openAlertCounts() });
  });

  /** Acknowledge with a note (what was found or done), logged. A second acknowledge answers the first (replayed). */
  app.post("/admin/alerts/:id/ack", async (req) => {
    const admin = requireAdmin(req);
    const id = uuidParam(req);
    const { note } = adminAlertAckSchema.parse(req.body);
    const done = await acknowledgeAdminAlert(admin.id, id, note);
    if (!done) throw httpError(404, "not_found");
    return adminAlertAckResponseSchema.parse({ alert: alertView(done.alert, done.ackedBy), replayed: done.replayed });
  });
}

/**
 * Something an admin should look at now. There is no alert channel yet (no paging, no admin inbox), so an
 * alert is an error-level log line tagged `adminAlert: <name>`, the one place to route to a real channel
 * (email to ADMIN_EMAILS, a webhook) when there is one.
 */
import type { FastifyBaseLogger } from "fastify";

export function adminAlert(log: FastifyBaseLogger, name: string, details: Record<string, unknown>): void {
  log.error({ adminAlert: name, ...details }, `admin alert: ${name}`);
}

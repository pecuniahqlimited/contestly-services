/**
 * Admin alerts: something an admin should look at. adminAlert() only records (inside the caller's
 * transaction when one is passed, so an alert commits or rolls back with what caused it); the worker
 * delivers from the table (apps/worker/src/alertDelivery.ts), never the request that raised it.
 * Severity decides where it goes: critical by email at once (and the webhook), warning in the email
 * digest, info only in the console's list. Every alert is also a console line when raised.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { ALERT_SEVERITIES, ALERT_TEST_KIND, type AlertSeverity } from "@contestly/shared";
import { db, type Tx } from "./client.js";
import { adminAlertDeliveries, adminAlerts, users, type User } from "./schema.js";
import { recordAdminAction } from "./admin.js";
import { afterCommit } from "./retry.js";

type Conn = Tx | typeof db;
export type AdminAlertRow = typeof adminAlerts.$inferSelect;

/** A repeat of the same dedupe key within this long of the first bumps the count (callers can pass their own). */
export const DEFAULT_ALERT_DEDUPE_WINDOW_SECONDS = 24 * 3600;
/**
 * A window at least this long marks a key about one thing (a payout, a top-up: ONCE_PER_THING_SECONDS in
 * payments). Acknowledging such an alert settles it for the rest of its window: repeats are counted on the
 * acknowledged row and nobody is told again. A shorter window (a rate, a spike) behaves as before: after an
 * acknowledge, the next raise is a new alert.
 */
export const LONG_ALERT_WINDOW_SECONDS = 7 * 24 * 3600;

export interface AdminAlertInput {
  /** What happened, as a stable code: "payout_unknown_too_long", "code_sends_spike". Throttling is per kind. */
  kind: string;
  severity: AlertSeverity;
  /** One line a person reads first (the email subject, the list row). */
  subject: string;
  details: Record<string, unknown>;
  /**
   * The same key within the window is the same alert: its count goes up instead of a new row. Once
   * acknowledged, a short window's next raise is a new alert; a long one's (LONG_ALERT_WINDOW_SECONDS) isn't.
   */
  dedupeKey: string;
  /** What it's about, to find a thing's alerts: ("payout", id), ("user", id). */
  refType?: string;
  refId?: string;
  dedupeWindowSeconds?: number;
}

export interface RaisedAlert {
  id: string;
  /** False when it bumped an alert with the same key in its window. */
  isNew: boolean;
  count: number;
  /** True when that alert was acknowledged and its long window holds: counted, nobody told. */
  suppressed: boolean;
}

const consoleFor: Record<AlertSeverity, (line: string) => void> = { info: (l) => console.log(l), warning: (l) => console.warn(l), critical: (l) => console.error(l) };

/**
 * Record an alert. Pass the transaction it belongs to (a freeze and its alert commit together); without
 * one it runs in its own. Two raises of one key at once are serialised on the key, so they share a row.
 */
export async function adminAlert(a: AdminAlertInput, conn: Conn = db): Promise<RaisedAlert> {
  const raised = "rollback" in conn ? await raiseIn(conn, a) : await db.transaction((tx) => raiseIn(tx, a));
  // A new alert is logged; a repeat only at ×10, ×100, ×1000…, so a storm doesn't flood the log either; an
  // acknowledged one not at all. Inside a money transaction the line waits for the commit (afterCommit), so a
  // retried attempt doesn't repeat it.
  if (raised.isNew || (!raised.suppressed && Number.isInteger(Math.log10(raised.count)))) afterCommit(conn, () => {
    consoleFor[a.severity](`[alert] ${a.severity.toUpperCase()} ${a.kind}${raised.isNew ? "" : ` (×${raised.count})`}: ${a.subject} ${JSON.stringify(a.details)}`);
  });
  return raised;
}

async function raiseIn(tx: Tx, a: AdminAlertInput): Promise<RaisedAlert> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`admin_alert:${a.dedupeKey}`}, 0))`);
  // The alert this repeats: still in its window, and open, or acknowledged with a long window (it stays settled).
  const longWindow = sql`${adminAlerts.windowEndsAt} - ${adminAlerts.firstSeenAt} >= make_interval(secs => ${LONG_ALERT_WINDOW_SECONDS})`;
  const [open] = await tx.select({ id: adminAlerts.id, acknowledgedAt: adminAlerts.acknowledgedAt }).from(adminAlerts)
    .where(and(eq(adminAlerts.dedupeKey, a.dedupeKey), gt(adminAlerts.windowEndsAt, sql`now()`), or(isNull(adminAlerts.acknowledgedAt), longWindow)))
    .orderBy(desc(adminAlerts.firstSeenAt)).limit(1);
  if (open) {
    const [bumped] = await tx.update(adminAlerts)
      .set({ count: sql`${adminAlerts.count} + 1`, lastSeenAt: sql`now()`, subject: a.subject, details: a.details })
      .where(eq(adminAlerts.id, open.id)).returning({ id: adminAlerts.id, count: adminAlerts.count });
    return { id: bumped.id, isNew: false, count: bumped.count, suppressed: open.acknowledgedAt !== null };
  }
  const window = a.dedupeWindowSeconds ?? DEFAULT_ALERT_DEDUPE_WINDOW_SECONDS;
  const [row] = await tx.insert(adminAlerts).values({
    kind: a.kind, severity: a.severity, subject: a.subject, details: a.details, dedupeKey: a.dedupeKey,
    refType: a.refType ?? null, refId: a.refId ?? null, windowEndsAt: sql`now() + make_interval(secs => ${window})`,
  }).returning({ id: adminAlerts.id, count: adminAlerts.count });
  return { id: row.id, isNew: true, count: row.count, suppressed: false };
}

// ---------------------------------------------------------------- the console

export interface AlertFilter {
  severity?: AlertSeverity;
  kind?: string;
  /** Leave out kinds starting with this (payments.* for an admin without payments.view). */
  excludeKindPrefix?: string;
  state: "open" | "acknowledged" | "all";
  before?: string;
  limit: number;
}

export async function listAdminAlerts(f: AlertFilter): Promise<{ alert: AdminAlertRow; ackedBy: User | null }[]> {
  const where: SQL[] = [];
  if (f.severity) where.push(eq(adminAlerts.severity, f.severity));
  if (f.kind) where.push(eq(adminAlerts.kind, f.kind));
  if (f.excludeKindPrefix) where.push(sql`not starts_with(${adminAlerts.kind}, ${f.excludeKindPrefix})`);
  if (f.state === "open") where.push(isNull(adminAlerts.acknowledgedAt));
  if (f.state === "acknowledged") where.push(isNotNull(adminAlerts.acknowledgedAt));
  if (f.before) where.push(lt(adminAlerts.lastSeenAt, new Date(f.before)));
  const rows = await db.select({ alert: adminAlerts, ackedBy: users }).from(adminAlerts).leftJoin(users, eq(users.id, adminAlerts.acknowledgedByUserId))
    .where(where.length ? and(...where) : undefined).orderBy(desc(adminAlerts.lastSeenAt)).limit(f.limit);
  return rows;
}

/** Open (unacknowledged) alerts by severity: the admin home shows the critical count. Without a prefix's kinds when given (what the viewer can't see). */
export async function openAlertCounts(opts: { excludeKindPrefix?: string } = {}): Promise<Record<AlertSeverity, number>> {
  const rows = await db.select({ severity: adminAlerts.severity, n: sql<number>`count(*)::int` }).from(adminAlerts)
    .where(and(isNull(adminAlerts.acknowledgedAt), opts.excludeKindPrefix ? sql`not starts_with(${adminAlerts.kind}, ${opts.excludeKindPrefix})` : undefined)).groupBy(adminAlerts.severity);
  const counts = Object.fromEntries(ALERT_SEVERITIES.map((s) => [s, 0])) as Record<AlertSeverity, number>;
  for (const r of rows) counts[r.severity] = r.n;
  return counts;
}

/**
 * An admin acknowledges with a note (what they found or did), logged in admin_actions in the same
 * transaction. Acknowledging twice keeps the first and logs nothing more. Delivery stops for it. The next
 * raise of its key is a new alert, unless its window is long (LONG_ALERT_WINDOW_SECONDS): then repeats are
 * counted on this row until the window ends, and nobody is told again.
 */
export async function acknowledgeAdminAlert(adminUserId: string, id: string, note: string): Promise<{ alert: AdminAlertRow; ackedBy: User; replayed: boolean } | null> {
  return db.transaction(async (tx) => {
    const [a] = await tx.select().from(adminAlerts).where(eq(adminAlerts.id, id)).for("update");
    if (!a) return null;
    const acker = async (userId: string) => (await tx.select().from(users).where(eq(users.id, userId)))[0];
    if (a.acknowledgedAt) return { alert: a, ackedBy: await acker(a.acknowledgedByUserId!), replayed: true };
    const [after] = await tx.update(adminAlerts).set({ acknowledgedByUserId: adminUserId, acknowledgedAt: sql`now()`, ackNote: note }).where(eq(adminAlerts.id, id)).returning();
    await recordAdminAction(tx, {
      adminUserId, action: "alert.acknowledge", targetType: "alert", targetId: id, reason: note,
      before: { acknowledgedAt: null }, after: { kind: a.kind, severity: a.severity, count: a.count },
    });
    return { alert: after, ackedBy: await acker(adminUserId), replayed: false };
  });
}

/**
 * An admin's test alert, to check each channel in dev and production: a fresh key every time (never
 * deduped into an earlier one), delivered by the worker like any other, logged in admin_actions.
 */
export async function raiseTestAlert(admin: User, severity: AlertSeverity): Promise<AdminAlertRow> {
  return db.transaction(async (tx) => {
    const at = new Date().toISOString();
    const { id } = await adminAlert({
      kind: ALERT_TEST_KIND, severity, subject: `Test alert (${severity}) sent by @${admin.handle}`,
      details: { test: true, by: admin.handle, at }, dedupeKey: `${ALERT_TEST_KIND}:${randomUUID()}`, refType: "user", refId: admin.id,
    }, tx);
    await recordAdminAction(tx, { adminUserId: admin.id, action: "alert.test", targetType: "alert", targetId: id, after: { severity } });
    const [row] = await tx.select().from(adminAlerts).where(eq(adminAlerts.id, id));
    return row;
  });
}

// ---------------------------------------------------------------- delivery (the worker)

/** How far back delivery looks: an alert nobody delivered for a week isn't sent late. */
const DELIVERY_LOOKBACK = sql`now() - interval '7 days'`;

/**
 * Open alerts of these severities with occurrences this channel hasn't sent yet, oldest first. `pending`
 * is how many; `deliveredUpTo` is the count to mark once they're sent (new repeats after this read stay pending).
 */
export async function undeliveredAlerts(channel: string, severities: readonly AlertSeverity[], conn: Conn = db, kindPrefix?: string) {
  const sent = sql<number>`coalesce((${adminAlerts.delivered} ->> ${channel})::int, 0)`;
  const rows = await conn.select({ alert: adminAlerts, sent }).from(adminAlerts)
    .where(and(
      inArray(adminAlerts.severity, [...severities]), isNull(adminAlerts.acknowledgedAt), gt(adminAlerts.lastSeenAt, DELIVERY_LOOKBACK), sql`${adminAlerts.count} > ${sent}`,
      kindPrefix ? sql`starts_with(${adminAlerts.kind}, ${kindPrefix})` : undefined,
    ))
    .orderBy(adminAlerts.firstSeenAt);
  return rows.map(({ alert, sent }) => ({ alert, alreadySent: sent, pending: alert.count - sent, deliveredUpTo: alert.count }));
}
export type UndeliveredAlert = Awaited<ReturnType<typeof undeliveredAlerts>>[number];

/** After a channel sent them: those occurrences are delivered on that channel. */
export async function markAlertsDelivered(channel: string, sent: readonly { id: string; deliveredUpTo: number }[], conn: Conn = db) {
  for (const s of sent) {
    await conn.update(adminAlerts).set({ delivered: sql`${adminAlerts.delivered} || jsonb_build_object(${channel}::text, ${s.deliveredUpTo}::int)` }).where(eq(adminAlerts.id, s.id));
  }
}

export async function recordAlertDelivery(d: typeof adminAlertDeliveries.$inferInsert, conn: Conn = db) {
  await conn.insert(adminAlertDeliveries).values(d);
}

/** When this channel last sent (ok) or last tried and failed, for one mode and kind (null kind: the digest). */
export async function lastAlertDelivery(channel: string, mode: "immediate" | "digest", kind: string | null, conn: Conn = db) {
  const where = and(eq(adminAlertDeliveries.channel, channel), eq(adminAlertDeliveries.mode, mode), kind === null ? isNull(adminAlertDeliveries.kind) : eq(adminAlertDeliveries.kind, kind));
  const [ok] = await conn.select({ at: adminAlertDeliveries.sentAt }).from(adminAlertDeliveries).where(and(where, eq(adminAlertDeliveries.ok, true))).orderBy(desc(adminAlertDeliveries.sentAt)).limit(1);
  const [failed] = await conn.select({ at: adminAlertDeliveries.sentAt }).from(adminAlertDeliveries).where(and(where, eq(adminAlertDeliveries.ok, false))).orderBy(desc(adminAlertDeliveries.sentAt)).limit(1);
  return { ok: ok?.at ?? null, failed: failed?.at ?? null };
}

/**
 * Runs `fn` only if no other worker is delivering right now (a transaction-scoped advisory lock), so two
 * worker instances never send the same alert twice. Returns null when another had it.
 */
export async function withAlertDeliveryLock<T>(fn: (tx: Tx) => Promise<T>): Promise<T | null> {
  return db.transaction(async (tx) => {
    const [{ locked }] = await tx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended('admin_alert_delivery', 0)) as locked`);
    return locked ? fn(tx) : null;
  });
}

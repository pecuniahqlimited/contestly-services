/**
 * Filing a report (ADR 0014) and the automatic holds it can trigger. One moderation item per target (kind +
 * ref) with the snapshot from its first report; one report row per reporter. A new distinct reporter reopens
 * a closed item. Past `holdReporters` the content is hidden for everyone; past `userTimeoutReporters` distinct
 * people reporting one person's things within the window, that person is timed out of chat. Both are logged
 * as the system and raise a warning, in the report's transaction.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import type { ModerationKind, Person, ReportBody, SafetyEvent } from "@contestly/shared";
import { db, type Tx } from "../client.js";
import { moderationItems, reports, users, type ModerationItem } from "../schema.js";
import { getSafetyConfig } from "../config.js";
import { recordAdminAction, systemActorId } from "../admin.js";
import { adminAlert } from "../alerts.js";
import { findTarget, hideItem, holdable } from "./targets.js";
import { blockedEitherWay } from "./people.js";
import { setChatTimeout } from "./standing.js";

const httpError = (statusCode: number, code: string) => Object.assign(new Error(code), { statusCode });

export interface ReportFiled { reportId: string; replayed: boolean; offerBlock: Person | null; events: SafetyEvent[] }

export async function fileReport(reporter: { id: string }, body: ReportBody, now = new Date()): Promise<ReportFiled> {
  return db.transaction(async (tx) => {
    const target = await findTarget(tx, body.target.type, body.target.id, reporter.id);
    if (target.subjectUserId === reporter.id) throw httpError(409, "cannot_report_self");
    await tx.insert(moderationItems).values({ kind: target.kind, refId: target.refId, userId: target.subjectUserId, threadId: target.threadId ?? null, snapshot: target.snapshot })
      .onConflictDoUpdate({
        target: [moderationItems.kind, moderationItems.refId],
        // A voice note's transcript item has no snapshot until someone reports it.
        set: { snapshot: sql`coalesce(${moderationItems.snapshot}, excluded.snapshot)`, userId: sql`coalesce(${moderationItems.userId}, excluded.user_id)` },
      });
    const [item] = await tx.select().from(moderationItems).where(and(eq(moderationItems.kind, target.kind), eq(moderationItems.refId, target.refId))).for("update");

    const [made] = await tx.insert(reports).values({ itemId: item.id, reporterId: reporter.id, reason: body.reason, note: body.note ?? null, createdAt: now }).onConflictDoNothing().returning();
    const offerBlock = await blockOffer(tx, reporter.id, target.subjectUserId);
    if (!made) {
      const [earlier] = await tx.select({ id: reports.id }).from(reports).where(and(eq(reports.itemId, item.id), eq(reports.reporterId, reporter.id)));
      return { reportId: earlier.id, replayed: true, offerBlock, events: [] };
    }
    const [counted] = await tx.update(moderationItems).set({
      reportCount: sql`${moderationItems.reportCount} + 1`, lastReportedAt: now, status: "open",
    }).where(eq(moderationItems.id, item.id)).returning();
    const events = await holdIfDue(tx, counted);
    await timeOutIfDue(tx, target.subjectUserId, now);
    return { reportId: made.id, replayed: false, offerBlock, events };
  });
}

/** "Block them too?": the person behind it, unless the reporter has already blocked them. */
async function blockOffer(tx: Tx, reporterId: string, subjectId: string): Promise<Person | null> {
  if (await blockedEitherWay(tx, reporterId, subjectId)) return null;
  const [u] = await tx.select({ id: users.id, handle: users.handle, displayName: users.displayName, avatarEmoji: users.avatarEmoji, isVerified: users.isVerified })
    .from(users).where(eq(users.id, subjectId));
  return u ?? null;
}

async function holdIfDue(tx: Tx, item: ModerationItem): Promise<SafetyEvent[]> {
  const cfg = await getSafetyConfig(tx);
  if (item.heldAt || item.reportCount < cfg.holdReporters || !holdable(item.kind as ModerationKind)) return [];
  const heldAt = new Date();
  await tx.update(moderationItems).set({ heldAt }).where(eq(moderationItems.id, item.id));
  const events = await hideItem(tx, item);
  await recordAdminAction(tx, {
    adminUserId: await systemActorId(tx), action: "moderation.auto_hold", targetType: "moderation_item", targetId: item.id,
    reason: `${item.reportCount} people reported it (hold at ${cfg.holdReporters})`, before: { heldAt: null }, after: { heldAt: heldAt.toISOString(), kind: item.kind },
  });
  await adminAlert({
    kind: "safety.content_held", severity: "warning", subject: `Hidden pending review: a ${item.kind.replace("_", " ")} reported by ${item.reportCount} people`,
    details: { itemId: item.id, kind: item.kind, reports: item.reportCount }, dedupeKey: `safety.content_held:${item.id}`, refType: "moderation_item", refId: item.id,
  }, tx);
  return events;
}

/** Distinct people who reported anything of theirs within the window. */
async function distinctReportersOf(tx: Tx, userId: string, since: Date): Promise<number> {
  const [r] = await tx.select({ n: sql<number>`count(distinct ${reports.reporterId})` }).from(reports)
    .innerJoin(moderationItems, eq(moderationItems.id, reports.itemId)).where(and(eq(moderationItems.userId, userId), gte(reports.createdAt, since)));
  return Number(r.n);
}

async function timeOutIfDue(tx: Tx, userId: string, now: Date) {
  const cfg = await getSafetyConfig(tx);
  const [u] = await tx.select({ until: users.chatTimeoutUntil }).from(users).where(eq(users.id, userId));
  if (!u || (u.until && u.until > now)) return;
  const n = await distinctReportersOf(tx, userId, new Date(now.getTime() - cfg.userReportWindowHours * 3_600_000));
  if (n < cfg.userTimeoutReporters) return;
  const until = new Date(now.getTime() + cfg.autoTimeoutHours * 3_600_000);
  await setChatTimeout(tx, { adminUserId: await systemActorId(tx), action: "user.auto_chat_timeout", reason: `${n} people reported them within ${cfg.userReportWindowHours}h (timeout at ${cfg.userTimeoutReporters})` }, userId, until);
  await adminAlert({
    kind: "safety.user_timed_out", severity: "warning", subject: `Timed out of chat pending review: reported by ${n} people in ${cfg.userReportWindowHours}h`,
    details: { userId, reporters: n, until: until.toISOString() }, dedupeKey: `safety.user_timed_out:${userId}`, refType: "user", refId: userId,
  }, tx);
}

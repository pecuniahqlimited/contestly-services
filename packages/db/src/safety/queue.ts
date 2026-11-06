/**
 * The moderation queue (ADR 0014): the list, one item in full, and what admins do to an item. Every action is
 * logged with its reason in its transaction; reporters hear "action taken" or "reviewed". Suspensions and bans
 * are applied by the caller first (they go through packages/payments for payments admins) and recorded here.
 */
import { and, asc, count, desc, eq, gt, inArray, lt, ne, sql, type SQL } from "drizzle-orm";
import { BULK_DISMISS_MAX, type BulkDismissFilter, type ModerationAction, type ModerationItemView, type ModerationKind, type ModerationStatus, type ReportReason, type SafetyEvent } from "@contestly/shared";
import { db, type Tx } from "../client.js";
import { adminActions, chatMessages, moderationItems, reports, users, voiceNotes, type ModerationItem } from "../schema.js";
import { recordAdminAction } from "../admin.js";
import { messageById } from "../chat.js";
import { hideItem, showItem, type Snapshot } from "./targets.js";
import { setChatTimeout, tellReporters, warnUser } from "./standing.js";

const httpError = (statusCode: number, code: string) => Object.assign(new Error(code), { statusCode });
const iso = (d: Date | null) => d?.toISOString() ?? null;
const personCols = { id: users.id, handle: users.handle, displayName: users.displayName, avatarEmoji: users.avatarEmoji, isVerified: users.isVerified };
const CONTEXT_LINES = 5;
const HISTORY_ITEMS = 20;
const HISTORY_ACTIONS = 30;

async function views(rows: ModerationItem[]): Promise<ModerationItemView[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const subjectIds = [...new Set(rows.map((r) => r.userId).filter((x): x is string => !!x))];
  const [reasons, people] = await Promise.all([
    db.select({ itemId: reports.itemId, reason: reports.reason, n: count() }).from(reports).where(inArray(reports.itemId, ids)).groupBy(reports.itemId, reports.reason),
    subjectIds.length ? db.select(personCols).from(users).where(inArray(users.id, subjectIds)) : [],
  ]);
  const personOf = new Map(people.map((p) => [p.id, p]));
  return rows.map((r) => ({
    id: r.id, kind: r.kind as ModerationKind, refId: r.refId, status: r.status as ModerationStatus, resolution: r.resolution,
    subject: r.userId ? personOf.get(r.userId) ?? null : null, snapshot: (r.snapshot as Snapshot | null) ?? null, reportCount: r.reportCount,
    reasons: reasons.filter((x) => x.itemId === r.id).map((x) => ({ reason: x.reason as ReportReason, count: Number(x.n) })).sort((a, b) => b.count - a.count),
    heldAt: iso(r.heldAt), lastReportedAt: iso(r.lastReportedAt), createdAt: r.createdAt.toISOString(),
  }));
}

/** Most-reported first, then the latest report, then the newest. */
export async function moderationPage(q: { type?: ModerationKind; reason?: ReportReason; status: ModerationStatus; offset: number; limit: number }) {
  const where: SQL[] = [eq(moderationItems.status, q.status)];
  if (q.type) where.push(eq(moderationItems.kind, q.type));
  if (q.reason) where.push(sql`exists (select 1 from ${reports} r where r.item_id = ${moderationItems.id} and r.reason = ${q.reason})`);
  const rows = await db.select().from(moderationItems).where(and(...where))
    .orderBy(desc(moderationItems.reportCount), sql`${moderationItems.lastReportedAt} desc nulls last`, desc(moderationItems.createdAt))
    .offset(q.offset).limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  return { items: await views(page), nextOffset: rows.length > q.limit ? q.offset + q.limit : null };
}

async function itemById(id: string, tx: Tx | typeof db = db) {
  const [item] = await tx.select().from(moderationItems).where(eq(moderationItems.id, id));
  if (!item) throw httpError(404, "not_found");
  return item;
}

/** A chat line's neighbours in its thread, as they are now. */
async function contextOf(item: ModerationItem) {
  const messageId = (item.snapshot as Snapshot | null)?.messageId as string | undefined;
  if (!messageId || !item.threadId) return null;
  const [m] = await db.select({ id: chatMessages.id }).from(chatMessages).where(eq(chatMessages.id, messageId));
  if (!m) return null;
  // Compared in SQL: a JS Date drops the microseconds Postgres keeps, which would bring the line itself back.
  const at = sql`(select created_at from ${chatMessages} where id = ${messageId})`;
  const [before, after] = await Promise.all([
    db.select({ id: chatMessages.id }).from(chatMessages).where(and(eq(chatMessages.threadId, item.threadId), lt(chatMessages.createdAt, at), ne(chatMessages.id, messageId))).orderBy(desc(chatMessages.createdAt)).limit(CONTEXT_LINES),
    db.select({ id: chatMessages.id }).from(chatMessages).where(and(eq(chatMessages.threadId, item.threadId), gt(chatMessages.createdAt, at), ne(chatMessages.id, messageId))).orderBy(asc(chatMessages.createdAt)).limit(CONTEXT_LINES),
  ]);
  const ids = [...before.reverse().map((r) => r.id), messageId, ...after.map((r) => r.id)];
  const hidden = new Set((await db.select({ id: chatMessages.id }).from(chatMessages).where(and(inArray(chatMessages.id, ids), sql`${chatMessages.hiddenAt} is not null`))).map((r) => r.id));
  return Promise.all(ids.map(async (id) => ({ ...(await messageById(db, id)), hidden: hidden.has(id), reported: id === messageId })));
}

/** One item in full. `voice.objectKey` is for the caller to sign; it never leaves the API. */
export async function moderationDetail(id: string) {
  const item = await itemById(id);
  const [[view], reportRows, context, subject, note] = await Promise.all([
    views([item]),
    db.select({ reporter: personCols, r: reports }).from(reports).innerJoin(users, eq(users.id, reports.reporterId)).where(eq(reports.itemId, id)).orderBy(desc(reports.createdAt)),
    contextOf(item),
    item.userId ? db.select().from(users).where(eq(users.id, item.userId)).then((r) => r[0]) : undefined,
    item.kind === "voice_note" ? db.select().from(voiceNotes).where(eq(voiceNotes.id, item.refId)).then((r) => r[0]) : undefined,
  ]);
  const [others, actions] = subject ? await Promise.all([
    db.select().from(moderationItems).where(and(eq(moderationItems.userId, subject.id), ne(moderationItems.id, id))).orderBy(desc(moderationItems.createdAt)).limit(HISTORY_ITEMS),
    db.select({ a: adminActions, admin: personCols }).from(adminActions).innerJoin(users, eq(users.id, adminActions.adminUserId))
      .where(and(eq(adminActions.targetType, "user"), eq(adminActions.targetId, subject.id))).orderBy(desc(adminActions.createdAt)).limit(HISTORY_ACTIONS),
  ]) : [[], []];
  return {
    item: view,
    reports: reportRows.map(({ reporter, r }) => ({ reporter, reason: r.reason as ReportReason, note: r.note, at: r.createdAt.toISOString() })),
    context,
    voice: item.kind === "voice_note" ? { transcript: item.transcript, provider: item.provider, objectKey: note && note.status !== "expired" ? note.objectKey : null } : null,
    subjectState: subject ? { bannedAt: iso(subject.bannedAt), bannedUntil: iso(subject.bannedUntil), banCategory: subject.banCategory, chatTimeoutUntil: iso(subject.chatTimeoutUntil) } : null,
    history: {
      items: await views(others),
      actions: actions.map(({ a, admin }) => ({ action: a.action, reason: a.reason, admin, at: a.createdAt.toISOString() })),
    },
  };
}

const RESOLUTION: Record<ModerationAction, { status: ModerationStatus; outcome: "action_taken" | "reviewed" }> = {
  dismiss: { status: "dismissed", outcome: "reviewed" },
  remove: { status: "actioned", outcome: "action_taken" },
  warn: { status: "actioned", outcome: "action_taken" },
  chat_timeout: { status: "actioned", outcome: "action_taken" },
  suspend: { status: "actioned", outcome: "action_taken" },
  ban: { status: "actioned", outcome: "action_taken" },
};

/** The item's most-reported reason: what a warning or a ban names unless the admin picks another. */
export const topReason = (v: ModerationItemView): ReportReason => v.reasons[0]?.reason ?? "other";

export interface ActInput { action: ModerationAction; reason: string; hours?: number; category: ReportReason; resolution?: string; bulk?: boolean }

/**
 * An admin acts on an item. Dismiss shows a held item again; remove hides it for good; warn leaves a notice;
 * a chat timeout runs for `hours`. A suspension or ban was applied by the caller; this records it on the item.
 * Reporters who haven't heard about this item yet get the outcome note.
 */
export async function actOnItem(adminUserId: string, itemId: string, a: ActInput, now = new Date()): Promise<{ events: SafetyEvent[] }> {
  return db.transaction(async (tx) => {
    const [item] = await tx.select().from(moderationItems).where(eq(moderationItems.id, itemId)).for("update");
    if (!item) throw httpError(404, "not_found");
    return { events: await applyAction(tx, adminUserId, item, a, now) };
  });
}

/** One action on a locked item, in the caller's transaction: its effect, the resolution, the log row, the reporters' note. */
async function applyAction(tx: Tx, adminUserId: string, item: ModerationItem, a: ActInput, now: Date): Promise<SafetyEvent[]> {
  const subject = item.userId;
  if (!subject && a.action !== "dismiss" && a.action !== "remove") throw httpError(409, "no_subject");
  let events: SafetyEvent[] = [];
  if (a.action === "dismiss" && item.heldAt) events = await showItem(tx, item);
  if (a.action === "remove") events = await hideItem(tx, item);
  if (a.action === "warn") await warnUser(tx, subject!, a.category, item.id);
  if (a.action === "chat_timeout") {
    await setChatTimeout(tx, { adminUserId, action: "user.chat_timeout", reason: a.reason }, subject!, new Date(now.getTime() + a.hours! * 3_600_000));
  }
  const { status, outcome } = RESOLUTION[a.action];
  await tx.update(moderationItems).set({ status, resolution: a.resolution ?? a.action, resolvedAt: now, resolvedByUserId: adminUserId, heldAt: a.action === "dismiss" ? null : item.heldAt })
    .where(eq(moderationItems.id, item.id));
  await recordAdminAction(tx, {
    adminUserId, action: `moderation.${a.action}`, targetType: "moderation_item", targetId: item.id, reason: a.reason,
    before: { status: item.status, resolution: item.resolution, heldAt: iso(item.heldAt) },
    after: { status, resolution: a.resolution ?? a.action, subject, ...(a.hours ? { hours: a.hours } : {}), category: a.category, ...(a.bulk ? { bulk: true } : {}) },
  });
  await tellReporters(tx, await unnotifiedReporters(tx, item.id), item.id, outcome);
  return events;
}

/**
 * Dismiss open items in one go (the transcripts nobody reported, say): by id, or by a filter, oldest first, at
 * most BULK_DISMISS_MAX. Each is a dismiss like any other (a held one shows again, its reporters hear "reviewed",
 * its own log row, marked bulk). Ids that aren't open are skipped.
 */
export async function bulkDismiss(adminUserId: string, by: { ids: string[] } | { filter: BulkDismissFilter }, reason: string, now = new Date()) {
  return db.transaction(async (tx) => {
    const where: SQL[] = [eq(moderationItems.status, "open")];
    if ("ids" in by) where.push(inArray(moderationItems.id, by.ids));
    else {
      const f = by.filter;
      if (f.type) where.push(eq(moderationItems.kind, f.type));
      if (f.reason) where.push(sql`exists (select 1 from ${reports} r where r.item_id = ${moderationItems.id} and r.reason = ${f.reason})`);
      if (f.unreported) where.push(eq(moderationItems.reportCount, 0));
      if (f.createdBefore) where.push(lt(moderationItems.createdAt, new Date(f.createdBefore)));
    }
    const rows = await tx.select().from(moderationItems).where(and(...where)).orderBy(asc(moderationItems.createdAt)).limit(BULK_DISMISS_MAX + 1).for("update");
    const taken = rows.slice(0, BULK_DISMISS_MAX);
    const events: SafetyEvent[] = [];
    for (const item of taken) events.push(...await applyAction(tx, adminUserId, item, { action: "dismiss", reason, category: "other", bulk: true }, now));
    return { dismissed: taken.map((r) => r.id), more: rows.length > BULK_DISMISS_MAX, events };
  });
}

/** Reporters of this item who haven't had a note about it since they reported. */
async function unnotifiedReporters(tx: Tx, itemId: string): Promise<string[]> {
  const rows = await tx.execute(sql`select r.reporter_id as id from ${reports} r where r.item_id = ${itemId}
    and not exists (select 1 from user_notices n where n.user_id = r.reporter_id and n.item_id = ${itemId} and n.kind = 'report_outcome' and n.created_at >= r.created_at)`);
  return (rows as unknown as { id: string }[]).map((r) => r.id);
}

/** Undo the automatic hold: the content shows again and the item stays open for review. Logged. */
export async function releaseHold(adminUserId: string, itemId: string, reason: string) {
  return db.transaction(async (tx) => {
    const [item] = await tx.select().from(moderationItems).where(eq(moderationItems.id, itemId)).for("update");
    if (!item) throw httpError(404, "not_found");
    if (!item.heldAt) throw httpError(409, "not_held");
    const events = await showItem(tx, item);
    await tx.update(moderationItems).set({ heldAt: null }).where(eq(moderationItems.id, item.id));
    await recordAdminAction(tx, { adminUserId, action: "moderation.release_hold", targetType: "moderation_item", targetId: item.id, reason, before: { heldAt: iso(item.heldAt) }, after: { heldAt: null } });
    return { events };
  });
}

export async function moderationItemView(id: string) {
  return (await views([await itemById(id)]))[0];
}

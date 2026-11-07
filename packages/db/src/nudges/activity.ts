/**
 * Chats › Activity: the person's nudges of the kinds that list there (inActivity), newest first, whatever
 * became of their push (a category toggled off still lists). Out: withdrawn ones, ones hidden for a block
 * or a mute, and ones no longer true; and any about someone blocked either way since.
 */
import { and, desc, eq, inArray, lt, notInArray, or, sql } from "drizzle-orm";
import { NUDGE_KIND_NAMES, NUDGE_KINDS, type NudgeKind, type NudgeSkipReason } from "@contestly/shared";
import { db } from "../client.js";
import { nudges, users } from "../schema.js";
import { liveUser } from "../accounts.js";
import { blockedWith } from "../safety/people.js";

export const ACTIVITY_KINDS = NUDGE_KIND_NAMES.filter((k) => (NUDGE_KINDS[k] as { inActivity?: boolean }).inActivity) as NudgeKind[];
/** Skipped for these, a nudge isn't Activity either: it was hidden, refused or stopped being true. */
const NOT_ACTIVITY: NudgeSkipReason[] = ["unavailable", "blocked", "muted", "money", "not_needed"];

export async function activityFor(userId: string, opts: { before?: string; limit: number }) {
  if (!ACTIVITY_KINDS.length) return { items: [], before: null };
  const [cursor] = opts.before ? await db.select({ createdAt: nudges.createdAt, id: nudges.id }).from(nudges).where(and(eq(nudges.id, opts.before), eq(nudges.userId, userId))) : [];
  const rows = await db.select().from(nudges).where(and(
    eq(nudges.userId, userId), inArray(nudges.kind, ACTIVITY_KINDS), sql`${nudges.status} <> 'withdrawn'`,
    or(sql`${nudges.skipReason} is null`, notInArray(nudges.skipReason, NOT_ACTIVITY)),
    cursor ? or(lt(nudges.createdAt, cursor.createdAt), and(eq(nudges.createdAt, cursor.createdAt), lt(nudges.id, cursor.id))) : undefined,
  )).orderBy(desc(nudges.createdAt), desc(nudges.id)).limit(opts.limit + 1);
  const blocked = await blockedWith(db, userId);
  const page = rows.slice(0, opts.limit);
  const shown = page.filter((r) => !r.actors.some((a) => blocked.has(a.id)));
  const actorIds = [...new Set(shown.flatMap((r) => r.actors.map((a) => a.id)))];
  const people = actorIds.length
    ? await db.select({ id: users.id, handle: users.handle, displayName: users.displayName, avatarEmoji: users.avatarEmoji, isVerified: users.isVerified }).from(users).where(and(inArray(users.id, actorIds), liveUser))
    : [];
  const personOf = new Map(people.map((p) => [p.id, p]));
  return {
    items: shown.map((r) => ({
      id: r.id, kind: r.kind, category: r.category, title: r.title, body: r.body, deepLink: r.deepLink, reason: r.reason,
      people: r.actors.flatMap((a) => (personOf.has(a.id) ? [personOf.get(a.id)!] : [])),
      unread: !r.openedAt && !r.dismissedAt, createdAt: r.createdAt.toISOString(),
    })),
    before: rows.length > opts.limit ? page[page.length - 1].id : null,
  };
}

/** Feed pages: events with the person they're about. Events are written where things happen (packages/db social.ts). */
import { inArray } from "drizzle-orm";
import { db, feedFor, users } from "@contestly/db";
import type { FeedPage, Person } from "@contestly/shared";
import { personColumns } from "./people.js";

export async function feedPage(userIds: string[], viewerId: string, opts: { before?: string; limit: number }): Promise<FeedPage> {
  const { rows, before } = await feedFor(userIds, { ...opts, viewerId });
  const ids = [...new Set(rows.map((r) => r.userId))];
  const people = ids.length ? await db.select(personColumns).from(users).where(inArray(users.id, ids)) : [];
  const personOf = new Map(people.map((p) => [p.id, p as Person]));
  return {
    events: rows.map((r) => ({ id: r.id, kind: r.kind, person: personOf.get(r.userId)!, data: r.data, createdAt: r.createdAt.toISOString() }) as FeedPage["events"][number]),
    before,
  };
}

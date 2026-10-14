/**
 * ADR 0001: the ONLY place that resolves a party's public host. Today the host is the creating
 * user; step 4 adds `parties.brand_id` and this helper returns the brand when it's set — callers
 * never change. Don't read `created_by_user_id` for display anywhere else.
 */
import { eq, inArray } from "drizzle-orm";
import { db } from "./client.js";
import { parties, users } from "./schema.js";

export interface PublicHost {
  id: string;
  kind: "user"; // step 4 adds "brand"
  handle: string;
  displayName: string;
  avatarEmoji: string;
  isBrand: boolean;
  isVerified: boolean;
}

type PartyHostFields = { id: string; createdByUserId: string };

const toPublicHost = (u: typeof users.$inferSelect): PublicHost => ({
  id: u.id,
  kind: "user",
  handle: u.handle,
  displayName: u.displayName,
  avatarEmoji: u.avatarEmoji,
  isBrand: u.isBrand,
  isVerified: u.isVerified,
});

export async function publicHost(party: PartyHostFields): Promise<PublicHost> {
  const [u] = await db.select().from(users).where(eq(users.id, party.createdByUserId));
  return toPublicHost(u);
}

/** Batch variant for list endpoints: one query, a map keyed by party id. */
export async function publicHosts(list: PartyHostFields[]): Promise<Map<string, PublicHost>> {
  if (!list.length) return new Map();
  const ids = [...new Set(list.map((p) => p.createdByUserId))];
  const rows = await db.select().from(users).where(inArray(users.id, ids));
  const byUser = new Map(rows.map((u) => [u.id, toPublicHost(u)]));
  return new Map(list.map((p) => [p.id, byUser.get(p.createdByUserId)!]));
}

/** Parties publicly hosted by this user (step 4 extends to brands). */
export async function partiesHostedBy(userId: string) {
  return db.select().from(parties).where(eq(parties.createdByUserId, userId));
}

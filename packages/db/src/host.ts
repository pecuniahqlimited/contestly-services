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

/**
 * Who would publicly host a party this user creates now: themselves today; from step 4 the brand they create as.
 * The stakes check runs before the party exists, so it can't go through publicHost().
 */
export async function prospectiveHost(creatorId: string): Promise<PublicHost> {
  const [u] = await db.select().from(users).where(eq(users.id, creatorId));
  return toPublicHost(u);
}

/**
 * Who may offer goods (a product or an experience) instead of cash: a party publicly hosted by a verified brand.
 * The ONLY place this is decided; row 8's brand verification changes this body, never its callers. Everyone
 * else's host-funded prize is cash.
 */
export const canOfferNonCashPrize = (host: Pick<PublicHost, "isBrand" | "isVerified">) => host.isBrand && host.isVerified;

/**
 * Who may act for the host: review curate drafts, attach source files. Today only the creator;
 * step 4 extends this to the brand's team with roles. Callers never check created_by_user_id directly.
 */
export function isHostTeam(party: PartyHostFields, userId: string): boolean {
  return party.createdByUserId === userId;
}

/** isHostTeam as a query condition on parties: the parties this user may act for. */
export const hostTeamOf = (userId: string) => eq(parties.createdByUserId, userId);

/** Parties publicly hosted by this user (step 4 extends to brands). */
export async function partiesHostedBy(userId: string) {
  return db.select().from(parties).where(eq(parties.createdByUserId, userId));
}

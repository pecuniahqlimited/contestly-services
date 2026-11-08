/**
 * ADR 0001: the ONLY place that resolves a party's public host: the brand when `parties.brand_id` is set (ADR
 * 0017: a brand is an account, `brands.id` = its users.id), else the creating user. Don't read
 * `created_by_user_id` or `brand_id` for display anywhere else.
 */
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db, type Tx } from "./client.js";
import { HOST_TEAM_ROLES, type CurateHostType } from "@contestly/shared";
import { brandMembers, parties, users } from "./schema.js";

type Conn = Tx | typeof db;

export interface PublicHost {
  id: string;
  kind: "user" | "brand";
  handle: string;
  displayName: string;
  avatarEmoji: string;
  isBrand: boolean;
  isVerified: boolean;
}

type PartyHostFields = { id: string; createdByUserId: string; brandId: string | null };

const toPublicHost = (u: typeof users.$inferSelect): PublicHost => ({
  id: u.id,
  kind: u.isBrand ? "brand" : "user",
  handle: u.handle,
  displayName: u.displayName,
  avatarEmoji: u.avatarEmoji,
  isBrand: u.isBrand,
  isVerified: u.isVerified,
});

/** The id of the account that publicly hosts a party: whose corner it builds (ADR 0012) and whose wallet funds its prize. */
export const publicHostId = (party: Pick<PartyHostFields, "createdByUserId" | "brandId">): string => party.brandId ?? party.createdByUserId;

export async function publicHost(party: Pick<PartyHostFields, "createdByUserId" | "brandId">, conn: Conn = db): Promise<PublicHost> {
  const [u] = await conn.select().from(users).where(eq(users.id, publicHostId(party)));
  return toPublicHost(u);
}

/** Batch variant for list endpoints: one query, a map keyed by party id. */
export async function publicHosts(list: PartyHostFields[]): Promise<Map<string, PublicHost>> {
  if (!list.length) return new Map();
  const ids = [...new Set(list.map(publicHostId))];
  const rows = await db.select().from(users).where(inArray(users.id, ids));
  const byUser = new Map(rows.map((u) => [u.id, toPublicHost(u)]));
  return new Map(list.map((p) => [p.id, byUser.get(publicHostId(p))!]));
}

/**
 * Who would publicly host a party this user creates now: the brand they act as (ADR 0017), else themselves.
 * The stakes check runs before the party exists, so it can't go through publicHost().
 */
export async function prospectiveHost(creatorId: string, brandId: string | null = null): Promise<PublicHost> {
  const [u] = await db.select().from(users).where(eq(users.id, brandId ?? creatorId));
  return toPublicHost(u);
}

/**
 * Who may offer goods (a product or an experience) instead of cash: a party publicly hosted by a verified brand.
 * The ONLY place this is decided. Everyone else's host-funded prize is cash.
 */
export const canOfferNonCashPrize = (host: Pick<PublicHost, "isBrand" | "isVerified">) => host.isBrand && host.isVerified;

/**
 * Whose curate caps a host gets (ADR 0015's capsByHost): the ONLY place this is decided. A verified brand gets the
 * brand caps (ADR 0017 §12); everyone else, unverified brands included, a person's.
 */
export const curateHostType = (host: Pick<PublicHost, "isBrand" | "isVerified">): CurateHostType => (canOfferNonCashPrize(host) ? "brand" : "person");

/** parties.brand_id, qualified: inside a subquery Drizzle may print a bare column name. */
const partyBrandId = sql.raw(`"parties"."brand_id"`);
const hostTeamRoles = sql.join(HOST_TEAM_ROLES.map((r) => sql`${r}`), sql`, `);

/**
 * Who may act for the host: review curate drafts, attach source files, invite as the host, cancel. The creator,
 * and for a brand's party its owners, admins and hosts (ADR 0017 §3). Callers never check the columns directly.
 */
export async function isHostTeam(party: Pick<PartyHostFields, "createdByUserId" | "brandId">, userId: string, conn: Conn = db): Promise<boolean> {
  if (party.createdByUserId === userId) return true;
  if (!party.brandId) return false;
  const [row] = await conn.select({ one: sql`1` }).from(brandMembers)
    .where(and(eq(brandMembers.brandId, party.brandId), eq(brandMembers.userId, userId), inArray(brandMembers.role, [...HOST_TEAM_ROLES])));
  return !!row;
}

/** isHostTeam as a query condition on parties: the parties this user may act for. */
export const hostTeamOf = (userId: string) => or(
  eq(parties.createdByUserId, userId),
  sql`exists (select 1 from ${brandMembers} m where m.brand_id = ${partyBrandId} and m.user_id = ${userId} and m.role in (${hostTeamRoles}))`,
)!;

/** publicHostId as a query condition on parties: the parties this account publicly hosts. */
export const publiclyHostedBy = (hostId: string) => or(eq(parties.brandId, hostId), and(isNull(parties.brandId), eq(parties.createdByUserId, hostId)))!;

/** Parties publicly hosted by this account (a person's own, or a brand's). */
export async function partiesHostedBy(hostId: string) {
  return db.select().from(parties).where(publiclyHostedBy(hostId));
}

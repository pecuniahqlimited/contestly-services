import type { FastifyInstance } from "fastify";
import { and, desc, eq, ilike, or, type SQL } from "drizzle-orm";
import {
  banUser, climbAwards, climbWeeks, db, ledger, parties, partyPlayers, unbanUser, userIdentities, users,
} from "@contestly/db";
import {
  ADMIN_EVENTS_CHANNEL, adminLedgerPageSchema, adminLedgerQuerySchema, adminReasonBodySchema, adminUserDetailSchema, adminUserSearchResponseSchema,
  adminUserSearchSchema, type AdminEvent,
} from "@contestly/shared";
import { sql } from "drizzle-orm";
import { requireAdmin, uuidParam } from "../auth.js";
import { adminUserRow } from "../adminViews.js";
import { httpError } from "../httpError.js";
import { valkey } from "../redis.js";

const SEARCH_LIMIT = 20;
const RECENT_LIMIT = 20;
const CLIMB_WEEKS_SHOWN = 8;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** By id, @handle (prefix), email (exact or prefix), else handle or name (prefix). Never system accounts. */
function searchWhere(q: string): SQL {
  if (UUID.test(q)) return eq(users.id, q);
  if (q.startsWith("@")) return ilike(users.handle, `${escapeLike(q.slice(1).toLowerCase())}%`);
  const like = `${escapeLike(q.toLowerCase())}%`;
  if (q.includes("@")) return or(eq(users.email, q.toLowerCase()), ilike(users.email, like))!;
  return or(ilike(users.handle, like), ilike(users.displayName, like))!;
}

async function userDetail(id: string) {
  const [u] = await db.select().from(users).where(and(eq(users.id, id), eq(users.isSystem, false)));
  if (!u) throw httpError(404, "not_found");
  const [identities, wallet, played, hosted, weeks, awards] = await Promise.all([
    db.select().from(userIdentities).where(eq(userIdentities.userId, id)),
    ledger.balances(id),
    db.select({ id: parties.id, title: parties.title, status: parties.status, startsAt: parties.startsAt, rank: partyPlayers.rank, score: partyPlayers.score, prizeKobo: partyPlayers.prizeKobo })
      .from(partyPlayers).innerJoin(parties, eq(parties.id, partyPlayers.partyId)).where(eq(partyPlayers.userId, id)).orderBy(desc(parties.startsAt)).limit(RECENT_LIMIT),
    db.select({ id: parties.id, title: parties.title, status: parties.status, startsAt: parties.startsAt, playerCount: sql<number>`(select count(*) from ${partyPlayers} pc where pc.party_id = ${parties.id})::int` })
      .from(parties).where(eq(parties.createdByUserId, id)).orderBy(desc(parties.startsAt)).limit(RECENT_LIMIT),
    db.select().from(climbWeeks).where(eq(climbWeeks.userId, id)).orderBy(desc(climbWeeks.week)).limit(CLIMB_WEEKS_SHOWN),
    db.select().from(climbAwards).where(eq(climbAwards.userId, id)).orderBy(desc(climbAwards.week)),
  ]);
  return adminUserDetailSchema.parse({
    user: {
      ...adminUserRow(u), banReason: u.banReason, emailVerifiedAt: u.emailVerifiedAt?.toISOString() ?? null, phoneAdded: !!u.phoneVerifiedAt,
      who: u.who, archetype: u.archetype, aboutVersion: u.aboutVersion, interests: u.interests, streakDays: u.streakDays,
    },
    identities: identities.map((i) => ({ provider: i.provider, externalId: i.externalId, createdAt: i.createdAt.toISOString() })),
    wallet,
    partiesPlayed: played.map((p) => ({ ...p, startsAt: p.startsAt.toISOString() })),
    partiesHosted: hosted.map((p) => ({ ...p, startsAt: p.startsAt.toISOString(), playerCount: Number(p.playerCount) })),
    climbWeeks: weeks.map((w) => ({ week: w.week, points: w.points, bestRunStages: w.bestRunStages })),
    climbAwards: awards.map((a) => ({ id: a.id, week: a.week, place: a.place, amountKobo: a.amountKobo, status: a.status, paidAt: a.paidAt?.toISOString() ?? null })),
  });
}

export async function adminUsersRoutes(app: FastifyInstance) {
  app.get("/admin/users", async (req) => {
    requireAdmin(req);
    const { q } = adminUserSearchSchema.parse(req.query);
    const rows = await db.select().from(users).where(and(eq(users.isSystem, false), searchWhere(q))).orderBy(desc(users.createdAt)).limit(SEARCH_LIMIT);
    return adminUserSearchResponseSchema.parse({ users: rows.map(adminUserRow) });
  });

  app.get("/admin/users/:id", async (req) => {
    requireAdmin(req);
    return userDetail(uuidParam(req));
  });

  /** The user's ledger, newest first, a page at a time (?before= from the last page's nextBefore). */
  app.get("/admin/users/:id/ledger", async (req) => {
    requireAdmin(req);
    const { before, limit } = adminLedgerQuerySchema.parse(req.query);
    const page = await ledger.historyPage(uuidParam(req), { before, limit });
    return adminLedgerPageSchema.parse({ entries: page.entries.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })), nextBefore: page.nextBefore });
  });

  /** Ban: they can't sign in, join, host or play, and any room they're in drops them now. */
  app.post("/admin/users/:id/ban", async (req) => {
    const admin = requireAdmin(req);
    const { reason } = adminReasonBodySchema.parse(req.body);
    const id = uuidParam(req);
    await banUser(admin.id, id, reason);
    const ev: AdminEvent = { kind: "user_banned", userId: id };
    await valkey().publish(ADMIN_EVENTS_CHANNEL, JSON.stringify(ev));
    return userDetail(id);
  });

  app.post("/admin/users/:id/unban", async (req) => {
    const admin = requireAdmin(req);
    const { reason } = adminReasonBodySchema.parse(req.body);
    const id = uuidParam(req);
    await unbanUser(admin.id, id, reason);
    return userDetail(id);
  });
}

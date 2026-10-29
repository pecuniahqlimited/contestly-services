import type { FastifyInstance } from "fastify";
import { and, desc, eq, ilike, inArray, or, type SQL } from "drizzle-orm";
import {
  archivedCrewInvites, archivedFollows, banUser, climbAwards, crews, climbWeeks, db, ledger, parties, partyPlayers, recordAdminAction, unbanUser, userIdentities, users,
} from "@contestly/db";
import {
  ADMIN_EVENTS_CHANNEL, adminLedgerPageSchema, adminLedgerQuerySchema, adminReasonBodySchema, adminUserDetailSchema, adminUserSearchResponseSchema,
  adminUserSearchSchema, normalisePhone, type AdminEvent,
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

/**
 * By id, @handle (prefix), email (exact or prefix), phone (any way it's written), else handle or name
 * (prefix). Deleted accounts match on what they were too (the archive). Never system accounts.
 */
function searchWhere(q: string): SQL {
  if (UUID.test(q)) return eq(users.id, q);
  const handleLike = (h: string) => { const like = `${escapeLike(h.toLowerCase())}%`; return or(ilike(users.handle, like), ilike(users.archivedHandle, like))!; };
  if (q.startsWith("@")) return handleLike(q.slice(1));
  const like = `${escapeLike(q.toLowerCase())}%`;
  if (q.includes("@")) return or(eq(users.email, q.toLowerCase()), ilike(users.email, like), eq(users.archivedEmail, q.toLowerCase()), ilike(users.archivedEmail, like))!;
  const phone = normalisePhone(q);
  if (phone) return or(eq(users.phone, phone), eq(users.archivedPhone, phone))!;
  return or(handleLike(q), ilike(users.displayName, like), ilike(users.archivedDisplayName, like))!;
}

/** A deleted account's archived follows and crew invites, each with the person on the other side. */
async function archivedConnections(id: string) {
  const [follows, invites] = await Promise.all([
    db.select().from(archivedFollows).where(or(eq(archivedFollows.followerId, id), eq(archivedFollows.followeeId, id))).orderBy(desc(archivedFollows.createdAt)),
    db.select({ i: archivedCrewInvites, crewName: crews.name }).from(archivedCrewInvites).innerJoin(crews, eq(crews.id, archivedCrewInvites.crewId))
      .where(or(eq(archivedCrewInvites.inviteeId, id), eq(archivedCrewInvites.inviterId, id))).orderBy(desc(archivedCrewInvites.createdAt)),
  ]);
  const otherIds = [...follows.map((f) => (f.followerId === id ? f.followeeId : f.followerId)), ...invites.map(({ i }) => (i.inviteeId === id ? i.inviterId : i.inviteeId))];
  const others = new Map((otherIds.length ? await db.select().from(users).where(inArray(users.id, otherIds)) : []).map((u) => [u.id, adminUserRow(u)]));
  return {
    archivedFollows: follows.map((f) => ({
      direction: f.followerId === id ? "following" as const : "follower" as const, user: others.get(f.followerId === id ? f.followeeId : f.followerId)!,
      followedAt: f.createdAt.toISOString(), archivedAt: f.archivedAt.toISOString(),
    })),
    archivedCrewInvites: invites.map(({ i, crewName }) => ({
      direction: i.inviteeId === id ? "received" as const : "sent" as const, crew: { id: i.crewId, name: crewName }, user: others.get(i.inviteeId === id ? i.inviterId : i.inviteeId)!,
      status: i.status, invitedAt: i.createdAt.toISOString(), respondedAt: i.respondedAt?.toISOString() ?? null, archivedAt: i.archivedAt.toISOString(),
    })),
  };
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
  const connections = u.deletedAt ? await archivedConnections(id) : null;
  return adminUserDetailSchema.parse({
    user: {
      ...adminUserRow(u), banReason: u.banReason, emailVerifiedAt: u.emailVerifiedAt?.toISOString() ?? null, phoneAdded: !!u.phoneVerifiedAt,
      who: u.who, archetype: u.archetype, aboutVersion: u.aboutVersion, interests: u.interests, streakDays: u.streakDays,
    },
    identities: identities.map((i) => ({ provider: i.provider, externalId: i.externalId, createdAt: i.createdAt.toISOString(), disabledAt: i.disabledAt?.toISOString() ?? null })),
    deletion: u.deletedAt ? {
      at: u.deletedAt.toISOString(), reason: u.deletedReason, archiveClearedAt: u.archiveClearedAt?.toISOString() ?? null,
      archived: { email: u.archivedEmail, handle: u.archivedHandle, displayName: u.archivedDisplayName, avatarEmoji: u.archivedAvatarEmoji, bio: u.archivedBio, phone: u.archivedPhone },
      ...connections!,
    } : null,
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

  /** A deleted account is fully visible here, and every look at it is logged (who looked, when). */
  app.get("/admin/users/:id", async (req) => {
    const admin = requireAdmin(req);
    const detail = await userDetail(uuidParam(req));
    if (detail.deletion) {
      await recordAdminAction(db, { adminUserId: admin.id, action: "user.view_deleted", targetType: "user", targetId: detail.user.id, before: null, after: null });
    }
    return detail;
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

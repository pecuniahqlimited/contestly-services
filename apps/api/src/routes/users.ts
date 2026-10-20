import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, count, desc, eq, min, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, users, follows, parties, partyPlayers, partiesHostedBy } from "@contestly/db";
import { followAlertSchema, MAX_PROFILE_RECENT_PARTIES } from "@contestly/shared";
import { requireUser, uuidParam } from "../auth.js";
import { publicParty } from "../partyView.js";
import { personColumns, viewerRelations } from "../people.js";
import { headToHead } from "../social.js";

export const publicUser = (u: typeof users.$inferSelect) => ({ id: u.id, handle: u.handle, displayName: u.displayName, avatarEmoji: u.avatarEmoji, bio: u.bio, interests: u.interests, isBrand: u.isBrand, isVerified: u.isVerified, streakDays: u.streakDays });

/** Follow lists, at most this many. */
const FOLLOW_LIST_LIMIT = 100;

/** A party on someone's profile: public, or one the viewer was in too. Private parties stay private. */
const visibleTo = (viewerId: string | undefined): SQL =>
  viewerId
    ? or(eq(parties.visibility, "public"), sql`exists (select 1 from ${partyPlayers} v where v.party_id = ${parties.id} and v.user_id = ${viewerId})`)!
    : eq(parties.visibility, "public");

/** Their seats in finished parties: what stats and recent parties count. */
const finishedSeatOf = (userId: string) => and(eq(partyPlayers.userId, userId), eq(parties.status, "finished"));

async function headToHeadWith(meId: string, themId: string) {
  const them = alias(partyPlayers, "them");
  const rows = await db.select({ myRank: partyPlayers.rank, theirRank: them.rank }).from(partyPlayers)
    .innerJoin(them, and(eq(them.partyId, partyPlayers.partyId), eq(them.userId, themId)))
    .innerJoin(parties, eq(parties.id, partyPlayers.partyId))
    .where(finishedSeatOf(meId));
  return headToHead(rows);
}

async function recentParties(userId: string, viewerId: string | undefined) {
  const rows = await db.select({
    id: parties.id, title: parties.title, category: parties.category, coverColor: parties.coverColor, coverEmoji: parties.coverEmoji, startsAt: parties.startsAt,
    rank: partyPlayers.rank, playerCount: sql<number>`(select count(*) from ${partyPlayers} pc where pc.party_id = ${parties.id})`,
  }).from(partyPlayers).innerJoin(parties, eq(parties.id, partyPlayers.partyId))
    .where(and(finishedSeatOf(userId), visibleTo(viewerId)))
    .orderBy(desc(sql`coalesce(${parties.endedAt}, ${parties.startsAt})`)).limit(MAX_PROFILE_RECENT_PARTIES);
  return rows.map((r) => ({ ...r, playerCount: Number(r.playerCount) }));
}

/** Each follow list: whose ids it lists, and whose list it is. */
const FOLLOW_LISTS = {
  followers: { listed: follows.followerId, owner: follows.followeeId },
  following: { listed: follows.followeeId, owner: follows.followerId },
} as const;

async function userByHandle(req: FastifyRequest, reply: FastifyReply) {
  const { handle } = req.params as { handle: string };
  const [u] = await db.select().from(users).where(and(eq(users.handle, handle), eq(users.isSystem, false)));
  if (!u) reply.code(404).send({ error: "not_found" });
  return u;
}

export async function usersRoutes(app: FastifyInstance) {
  app.get("/users/:handle", async (req, reply) => {
    const u = await userByHandle(req, reply);
    if (!u) return reply;
    const me = req.auth?.user;
    const [[fl], [fg], [stats], relations, recent, h2h, hosted] = await Promise.all([
      db.select({ n: count() }).from(follows).where(eq(follows.followeeId, u.id)),
      db.select({ n: count() }).from(follows).where(eq(follows.followerId, u.id)),
      db.select({ parties: count(), wins: sql<number>`count(*) filter (where ${partyPlayers.rank} = 1)`, bestRank: min(partyPlayers.rank) })
        .from(partyPlayers).innerJoin(parties, eq(parties.id, partyPlayers.partyId)).where(finishedSeatOf(u.id)),
      viewerRelations(me?.id, [u.id]),
      recentParties(u.id, me?.id),
      me && me.id !== u.id ? headToHeadWith(me.id, u.id) : null,
      partiesHostedBy(u.id),
    ]);
    const hosting = hosted.filter((p) => (p.status === "open" || p.status === "live") && (p.visibility === "public" || me?.id === u.id))
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()).map(publicParty);
    return {
      ...publicUser(u), followers: fl.n, following: fg.n,
      stats: { parties: Number(stats.parties), wins: Number(stats.wins), bestRank: stats.bestRank === null ? null : Number(stats.bestRank) },
      viewer: relations.get(u.id)!, headToHead: h2h, recent, hosting,
    };
  });

  for (const [list, { listed, owner }] of Object.entries(FOLLOW_LISTS)) {
    /** People the viewer follows come first, then newest follow first. */
    app.get(`/users/:handle/${list}`, async (req, reply) => {
      const u = await userByHandle(req, reply);
      if (!u) return reply;
      const rows = await db.select(personColumns).from(follows).innerJoin(users, eq(users.id, listed))
        .where(eq(owner, u.id)).orderBy(desc(follows.createdAt), asc(users.handle)).limit(FOLLOW_LIST_LIMIT);
      const relations = await viewerRelations(req.auth?.user?.id, rows.map((r) => r.id));
      const entries = rows.map((r) => ({ ...r, viewer: relations.get(r.id)! }));
      return [...entries.filter((e) => e.viewer.following), ...entries.filter((e) => !e.viewer.following)];
    });
  }

  app.post("/users/:id/follow", async (req, reply) => {
    const me = requireUser(req);
    const id = uuidParam(req);
    if (id === me.id) return reply.code(400).send({ error: "cannot_follow_self" });
    const [them] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, id), eq(users.isSystem, false)));
    if (!them) return reply.code(404).send({ error: "not_found" });
    await db.insert(follows).values({ followerId: me.id, followeeId: id }).onConflictDoNothing();
    const [row] = await db.select().from(follows).where(and(eq(follows.followerId, me.id), eq(follows.followeeId, id)));
    return { following: true, notify: row.notify };
  });
  app.delete("/users/:id/follow", async (req) => {
    const me = requireUser(req);
    const id = uuidParam(req);
    await db.delete(follows).where(and(eq(follows.followerId, me.id), eq(follows.followeeId, id)));
    return { following: false, notify: false };
  });
  /** Per-follow party alerts toggle. */
  app.patch("/users/:id/follow", async (req, reply) => {
    const me = requireUser(req);
    const id = uuidParam(req);
    const { notify } = followAlertSchema.parse(req.body);
    const [row] = await db.update(follows).set({ notify }).where(and(eq(follows.followerId, me.id), eq(follows.followeeId, id))).returning();
    if (!row) return reply.code(404).send({ error: "not_following" });
    return { following: true, notify: row.notify };
  });
}

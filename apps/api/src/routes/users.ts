import type { FastifyInstance } from "fastify";
import { and, eq, sql, count, inArray, desc } from "drizzle-orm";
import { db, users, follows, partyPlayers, ledger, partiesHostedBy } from "@contestly/db";
import { upsertMeSchema, kobo } from "@contestly/shared";
import { Unauthorized } from "@contestly/auth";
import { requireUser, uuidParam } from "../auth.js";

const publicUser = (u: typeof users.$inferSelect) => ({ id: u.id, handle: u.handle, displayName: u.displayName, avatarEmoji: u.avatarEmoji, bio: u.bio, interests: u.interests, isBrand: u.isBrand, isVerified: u.isVerified, streakDays: u.streakDays });

export async function usersRoutes(app: FastifyInstance) {
  app.get("/me", async (req) => {
    const u = requireUser(req);
    return { ...publicUser(u), wallet: await ledger.balances(u.id) };
  });

  /** Onboarding: create or update the signed-in user's profile. Grants the welcome bonus exactly once. */
  app.post("/me", async (req) => {
    if (!req.auth) throw new Unauthorized();
    const body = upsertMeSchema.parse(req.body);
    const existing = req.auth.user;
    const [u] = existing
      ? await db.update(users).set(body).where(eq(users.id, existing.id)).returning()
      : await db.insert(users).values({ ...body, firebaseUid: req.auth.firebaseUid, phone: req.auth.phone }).returning();
    await db.transaction((tx) => ledger.post(tx, { userId: u.id, kind: "bonus", amountKobo: kobo(500), type: "welcome_bonus", idempotencyKey: `welcome:${u.id}` }));
    return { ...publicUser(u), wallet: await ledger.balances(u.id) };
  });

  app.get("/users/:handle", async (req, reply) => {
    const { handle } = req.params as { handle: string };
    const [u] = await db.select().from(users).where(eq(users.handle, handle));
    if (!u) return reply.code(404).send({ error: "not_found" });
    const me = req.auth?.user;
    const [[fl], [fg], [stats], rel] = await Promise.all([
      db.select({ n: count() }).from(follows).where(eq(follows.followeeId, u.id)),
      db.select({ n: count() }).from(follows).where(eq(follows.followerId, u.id)),
      db.select({ parties: count(), wins: sql<number>`count(*) filter (where ${partyPlayers.rank} = 1)`, best: sql<number>`coalesce(max(${partyPlayers.prizeKobo}), 0)` }).from(partyPlayers).where(eq(partyPlayers.userId, u.id)),
      me ? db.select().from(follows).where(and(eq(follows.followerId, me.id), eq(follows.followeeId, u.id))) : Promise.resolve([]),
    ]);
    const hosting = (await partiesHostedBy(u.id)).filter((p) => p.status === "open" || p.status === "live").sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    return { ...publicUser(u), followers: fl.n, following: fg.n, stats: { parties: Number(stats.parties), wins: Number(stats.wins), bestPrizeKobo: Number(stats.best) }, viewer: { following: rel.length > 0, notify: rel[0]?.notify ?? false }, hosting };
  });

  app.get("/users/:handle/followers", async (req, reply) => {
    const { handle } = req.params as { handle: string };
    const [u] = await db.select().from(users).where(eq(users.handle, handle));
    if (!u) return reply.code(404).send({ error: "not_found" });
    const rows = await db.select({ u: users }).from(follows).innerJoin(users, eq(users.id, follows.followerId)).where(eq(follows.followeeId, u.id)).orderBy(desc(follows.createdAt)).limit(100);
    return rows.map((r) => publicUser(r.u));
  });
  app.get("/users/:handle/following", async (req, reply) => {
    const { handle } = req.params as { handle: string };
    const [u] = await db.select().from(users).where(eq(users.handle, handle));
    if (!u) return reply.code(404).send({ error: "not_found" });
    const rows = await db.select({ u: users, notify: follows.notify }).from(follows).innerJoin(users, eq(users.id, follows.followeeId)).where(eq(follows.followerId, u.id)).orderBy(desc(follows.createdAt)).limit(100);
    return rows.map((r) => ({ ...publicUser(r.u), notify: r.notify }));
  });

  app.post("/users/:id/follow", async (req, reply) => {
    const me = requireUser(req);
    const id = uuidParam(req);
    if (id === me.id) return reply.code(400).send({ error: "cannot_follow_self" });
    await db.insert(follows).values({ followerId: me.id, followeeId: id }).onConflictDoNothing();
    return { following: true, notify: true };
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
    const { notify } = (req.body ?? {}) as { notify?: boolean };
    const [row] = await db.update(follows).set({ notify: !!notify }).where(and(eq(follows.followerId, me.id), eq(follows.followeeId, id))).returning();
    if (!row) return reply.code(404).send({ error: "not_following" });
    return { following: true, notify: row.notify };
  });
}

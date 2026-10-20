import type { FastifyInstance } from "fastify";
import { and, count, desc, eq, max, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, follows, parties, partyPlayers, users, ledger } from "@contestly/db";
import { upsertMeSchema } from "@contestly/shared";
import { Unauthorized } from "@contestly/auth";
import { requireUser } from "../auth.js";
import { myParties } from "../myParties.js";
import { personColumns } from "../people.js";
import { publicUser } from "./users.js";

/** People you've played with, at most this many. */
const PLAYED_WITH_LIMIT = 20;

export async function meRoutes(app: FastifyInstance) {
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
    await db.transaction((tx) => ledger.grantWelcome(tx, u.id));
    return { ...publicUser(u), wallet: await ledger.balances(u.id) };
  });

  /** Parties I host, play or am invited to, grouped invited / live / upcoming / recent, each with its last chat line. */
  app.get("/me/parties", async (req) => myParties(requireUser(req)));

  /** People from finished parties I played, whom I don't follow yet: most parties together, then most recent. No ranking beyond that. */
  app.get("/me/played-with", async (req) => {
    const me = requireUser(req);
    const mine = alias(partyPlayers, "mine");
    const ended = sql<Date>`coalesce(${parties.endedAt}, ${parties.startsAt})`;
    const rows = await db.select({ ...personColumns, partiesTogether: count(), lastPlayedAt: max(ended) })
      .from(mine)
      .innerJoin(parties, and(eq(parties.id, mine.partyId), eq(parties.status, "finished")))
      .innerJoin(partyPlayers, and(eq(partyPlayers.partyId, mine.partyId), ne(partyPlayers.userId, me.id)))
      .innerJoin(users, eq(users.id, partyPlayers.userId))
      .where(and(eq(mine.userId, me.id), eq(users.isSystem, false),
        sql`not exists (select 1 from ${follows} f where f.follower_id = ${me.id} and f.followee_id = ${users.id})`))
      .groupBy(users.id)
      .orderBy(desc(count()), desc(max(ended)))
      .limit(PLAYED_WITH_LIMIT);
    return rows.map((r) => ({ ...r, partiesTogether: Number(r.partiesTogether), lastPlayedAt: new Date(r.lastPlayedAt as unknown as string).toISOString() }));
  });
}

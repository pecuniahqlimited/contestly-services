import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { db, dmPermissionBetween, follows, getPartyConfig, getSocialConfig, openDm, partyCardLine, users } from "@contestly/db";
import { CATEGORIES, boardQuerySchema, challengeBrief, createPartySchema, feedQuerySchema, lagosDay, type Category } from "@contestly/shared";
import { requireUser, uuidParam } from "../auth.js";
import { httpError } from "../httpError.js";
import { limit } from "../redis.js";
import { publishLine } from "../chats.js";
import { createParty } from "../partyCreate.js";
import { feedPage } from "../feed.js";
import { friendsBoard } from "../socialBoards.js";

const DAY_SECONDS = 86_400;

export async function socialRoutes(app: FastifyInstance) {
  /** What the people you follow did: finished parties, Climb bests, streaks. Newest first. */
  app.get("/feed", async (req) => {
    const me = requireUser(req);
    const followed = await db.select({ id: follows.followeeId }).from(follows).where(eq(follows.followerId, me.id));
    return feedPage(followed.map((f) => f.id), me.id, feedQuerySchema.parse(req.query ?? {}));
  });

  /** Friends-first: you and the people you follow, Climb plus party points, this week or all time. */
  app.get("/leaderboards/friends", async (req) => friendsBoard(requireUser(req).id, boardQuerySchema.parse(req.query ?? {}).period));

  /**
   * One-tap Challenge: a private, free party for the two of you on the lanes you share, starting at the
   * default time; they're invited and it lands in your messages as a card. Allowed wherever a DM would be
   * (as a request for strangers), a few a day.
   */
  app.post("/users/:id/challenge", async (req, reply) => {
    const me = requireUser(req);
    const [them] = await db.select().from(users).where(and(eq(users.id, uuidParam(req)), eq(users.isGuest, false), eq(users.isSystem, false)));
    if (!them) throw httpError(404, "not_found");
    if ((await dmPermissionBetween(db, me, them)) === "refused") throw httpError(403, "cannot_challenge");
    const [{ challengesPerDay }, { limits }] = await Promise.all([getSocialConfig(), getPartyConfig()]);
    await limit(`challenge:${me.id}:${lagosDay()}`, challengesPerDay, DAY_SECONDS, "too_many_challenges");
    const { brief, lanes } = challengeBrief(me.interests, them.interests);
    const category = lanes.find((l): l is Category => (CATEGORIES as readonly string[]).includes(l));
    const body = createPartySchema.parse({
      title: `${me.displayName} vs ${them.displayName}`.slice(0, 60), brief, category,
      entryKobo: 0, maxPlayers: Math.max(2, limits.seatsMin), funding: "pooled", split: limits.splits[0], visibility: "private",
    });
    const { party } = await createParty(me, body, { challenged: them.id });
    const { threadId } = await openDm(me, them);
    await publishLine(await partyCardLine(db, threadId, party.id, me.id, `${me.displayName} challenged you: ${party.title}`));
    return reply.code(201).send({ partyId: party.id, threadId });
  });
}

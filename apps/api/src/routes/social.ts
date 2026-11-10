import type { FastifyInstance } from "fastify";
import { yourPeople } from "@contestly/db";
import { boardQuerySchema, feedQuerySchema } from "@contestly/shared";
import { requireUser } from "../auth.js";
import { feedPage } from "../feed.js";
import { friendsBoard } from "../socialBoards.js";
import { followedCornerIds } from "../corners.js";

export async function socialRoutes(app: FastifyInstance) {
  /** What your people did (finished parties, Climb bests, streaks) and posts from the corners you follow. Newest first. */
  app.get("/feed", async (req) => {
    const me = requireUser(req);
    const [people, corners] = await Promise.all([yourPeople(me.id), followedCornerIds(me.id)]);
    return feedPage([...people], me.id, { ...feedQuerySchema.parse(req.query ?? {}), cornerIds: corners.map((c) => c.id) });
  });

  /** Friends-first: you and your people (crew, contacts, played with lately), Climb plus party points, this week or all time. */
  app.get("/leaderboards/friends", async (req) => friendsBoard(requireUser(req).id, boardQuerySchema.parse(req.query ?? {}).period));
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  cornerFollowAlertSchema, cornerFollowersQuerySchema, cornerMuteBodySchema, cornerPageQuerySchema, cornerPostBodySchema, cornerPostDetailSchema, cornerReactionBodySchema, cornerReplyBodySchema,
  cornerUpdateSchema, followerInviteOptionsSchema, followerInviteQuerySchema, followerInviteResultSchema, followerInviteSchema, suggestedCornersQuerySchema,
} from "@contestly/shared";
import { askToFollow, followAskOptions } from "@contestly/db";
import { countSearch } from "../peopleSearch.js";
import { requireUser, uuidParam } from "../auth.js";
import { actor } from "../acting.js";
import {
  cornerPage, createPost, deletePost, deleteReply, follow, followersPage, mute, mutesOf, myFollows, postDetail, postsPage, progressOf, react, reply, repliesPage, setAlerts, shownCorner,
  unfollow, unmute, unreact, updateMyCorner, celebrationSeen, suggestedCorners,
} from "../corners.js";

const userIdParam = (params: unknown) => z.object({ userId: z.string().uuid() }).parse(params).userId;

/** Corners (ADR 0012): a host's page, follows, the public follower list, posts, reactions, replies and mutes. */
export async function cornersRoutes(app: FastifyInstance) {
  /** Corners to follow, for onboarding and Home (interim until row 7): your lanes first, then the most followed. Public. */
  app.get("/corners/suggested", async (req) => suggestedCorners(req.auth?.user, suggestedCornersQuerySchema.parse(req.query ?? {}).limit));

  /** Up next, winners, this week's Regulars, followers and posts. Public. */
  app.get("/corners/:id", async (req) => cornerPage(uuidParam(req), req.auth?.user));

  /** Public, newest first, a page at a time, with "N of your people follow this" on top. */
  app.get("/corners/:id/followers", async (req) => followersPage(uuidParam(req), req.auth?.user?.id, cornerFollowersQuerySchema.parse(req.query ?? {})));

  app.post("/corners/:id/follow", async (req) => follow(requireUser(req), uuidParam(req)));
  app.delete("/corners/:id/follow", async (req) => unfollow(requireUser(req), uuidParam(req)));
  /** Party alerts for this corner, on by default. */
  app.patch("/corners/:id/follow", async (req) => setAlerts(requireUser(req), uuidParam(req), cornerFollowAlertSchema.parse(req.body).notify));

  app.get("/corners/:id/posts", async (req) => {
    const id = uuidParam(req);
    await shownCorner(id);
    return postsPage(id, req.auth?.user?.id, cornerPageQuerySchema.parse(req.query ?? {}));
  });
  /** The owner posts text (capped in social config). */
  app.post("/corners/:id/posts", { config: { actAs: "corner.manage" } }, async (req, res) => res.code(201).send(await createPost((await actor(req)).as, uuidParam(req), cornerPostBodySchema.parse(req.body).text)));
  app.get("/corner-posts/:id", async (req) => cornerPostDetailSchema.parse(await postDetail(uuidParam(req), req.auth?.user?.id)));
  app.delete("/corner-posts/:id", { config: { actAs: "corner.manage" } }, async (req) => deletePost((await actor(req)).as, uuidParam(req)));

  /** One reaction per person per post, from the fixed set; a new one replaces it. */
  app.put("/corner-posts/:id/reaction", async (req) => react(requireUser(req), uuidParam(req), cornerReactionBodySchema.parse(req.body).emoji));
  app.delete("/corner-posts/:id/reaction", async (req) => unreact(requireUser(req), uuidParam(req)));

  app.get("/corner-posts/:id/replies", async (req) => repliesPage(uuidParam(req), req.auth?.user?.id, cornerPageQuerySchema.parse(req.query ?? {})));
  /** A reply (one level), through the chat pipeline. A repeat of the client message id returns the first. */
  app.post("/corner-posts/:id/replies", async (req, res) => {
    const { text, clientMsgId } = cornerReplyBodySchema.parse(req.body);
    const out = await reply(requireUser(req), uuidParam(req), text, clientMsgId);
    return res.code(out.duplicate ? 200 : 201).send(out);
  });
  app.delete("/corner-replies/:id", { config: { actAs: "corner.manage" } }, async (req) => deleteReply((await actor(req)).as, uuidParam(req)));

  /** The owner mutes a follower in their corner. The follower isn't told. */
  app.get("/corners/:id/mutes", { config: { actAs: "corner.manage" } }, async (req) => mutesOf((await actor(req)).as, uuidParam(req)));
  app.post("/corners/:id/mutes", { config: { actAs: "corner.manage" } }, async (req) => mute((await actor(req)).as, uuidParam(req), cornerMuteBodySchema.parse(req.body).userId));
  app.delete("/corners/:id/mutes/:userId", { config: { actAs: "corner.manage" } }, async (req) => unmute((await actor(req)).as, z.object({ id: z.string().uuid() }).parse(req.params).id, userIdParam(req.params)));

  /** The corners you follow. */
  app.get("/me/follows", async (req) => myFollows(requireUser(req)));
  /** How close you are to unlocking your corner, and what counted. */
  app.get("/me/corner/progress", { config: { actAs: "view" } }, async (req) => progressOf((await actor(req)).as.id));
  /** Name and bio, once it's unlocked. */
  app.patch("/me/corner", { config: { actAs: "corner.manage" } }, async (req) => updateMyCorner((await actor(req)).as, cornerUpdateSchema.parse(req.body)));
  /** The unlock celebration has been shown; the progress view's celebrationSeenAt is set from then on. */
  app.post("/me/corner/celebration-seen", { config: { actAs: "corner.manage" } }, async (req) => celebrationSeen((await actor(req)).as));

  /**
   * Ask people to follow your corner: with q, anyone signed up you can ask (people search, so its per-user
   * limit applies); without, your recent players. Then ask the chosen ones.
   */
  app.get("/me/corner/invite-followers", { config: { actAs: "corner.manage" } }, async (req) => {
    const me = (await actor(req)).as;
    const { q, limit } = followerInviteQuerySchema.parse(req.query);
    if (q) await countSearch(me.id, app.limits.peopleSearchPerMinute);
    return followerInviteOptionsSchema.parse(await followAskOptions(me, { q, limit }));
  });
  app.post("/me/corner/invite-followers", { config: { actAs: "corner.manage" } }, async (req) =>
    followerInviteResultSchema.parse(await askToFollow((await actor(req)).as, followerInviteSchema.parse(req.body).userIds)));
}

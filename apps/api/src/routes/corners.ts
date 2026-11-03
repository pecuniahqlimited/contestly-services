import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  cornerFollowAlertSchema, cornerFollowersQuerySchema, cornerMuteBodySchema, cornerPageQuerySchema, cornerPostBodySchema, cornerReactionBodySchema, cornerReplyBodySchema,
  cornerReportBodySchema, cornerUpdateSchema,
} from "@contestly/shared";
import { requireUser, uuidParam } from "../auth.js";
import {
  cornerPage, createPost, deletePost, deleteReply, follow, followersPage, mute, mutesOf, myFollows, postsPage, progressOf, react, reply, repliesPage, reportReply, setAlerts, shownCorner,
  unfollow, unmute, unreact, updateMyCorner,
} from "../corners.js";

const userIdParam = (params: unknown) => z.object({ userId: z.string().uuid() }).parse(params).userId;

/** Corners (ADR 0012): a host's page, follows, the public follower list, posts, reactions, replies and mutes. */
export async function cornersRoutes(app: FastifyInstance) {
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
  app.post("/corners/:id/posts", async (req, res) => res.code(201).send(await createPost(requireUser(req), uuidParam(req), cornerPostBodySchema.parse(req.body).text)));
  app.delete("/corner-posts/:id", async (req) => deletePost(requireUser(req), uuidParam(req)));

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
  app.delete("/corner-replies/:id", async (req) => deleteReply(requireUser(req), uuidParam(req)));
  app.post("/corner-replies/:id/report", async (req) => reportReply(requireUser(req), uuidParam(req), cornerReportBodySchema.parse(req.body ?? {}).reason));

  /** The owner mutes a follower in their corner. The follower isn't told. */
  app.get("/corners/:id/mutes", async (req) => mutesOf(requireUser(req), uuidParam(req)));
  app.post("/corners/:id/mutes", async (req) => mute(requireUser(req), uuidParam(req), cornerMuteBodySchema.parse(req.body).userId));
  app.delete("/corners/:id/mutes/:userId", async (req) => unmute(requireUser(req), z.object({ id: z.string().uuid() }).parse(req.params).id, userIdParam(req.params)));

  /** The corners you follow. */
  app.get("/me/follows", async (req) => myFollows(requireUser(req)));
  /** How close you are to unlocking your corner, and what counted. */
  app.get("/me/corner/progress", async (req) => progressOf(requireUser(req).id));
  /** Name and bio, once it's unlocked. */
  app.patch("/me/corner", async (req) => updateMyCorner(requireUser(req), cornerUpdateSchema.parse(req.body)));
}

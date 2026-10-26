import type { FastifyInstance } from "fastify";
import { db } from "@contestly/db";
import { boardQuerySchema, createCrewSchema, crewInviteSchema, crewRoleSchema, updateCrewSchema, type ChatMessage } from "@contestly/shared";
import { requireUser, uuidParam } from "../auth.js";
import { publishLine } from "../chats.js";
import {
  answerCrewInvite, championOf, createCrew, crewDetail, crewMemberIds, inviteToCrew, leaveCrew, membership, myCrewInvites, myCrews,
  removeFromCrew, setCrewRole, updateCrew,
} from "../crews.js";
import { socialBoard } from "../socialBoards.js";

const publishAll = async (lines: ChatMessage[]) => { for (const l of lines) await publishLine(l); };

/** Crews: private and invite-only. Guests can't be in one (requireUser everywhere). */
export async function crewsRoutes(app: FastifyInstance) {
  /** Chats › Crews. */
  app.get("/crews", async (req) => myCrews(requireUser(req)));

  /** Start a crew and ask people to join it. */
  app.post("/crews", async (req, reply) => {
    const me = requireUser(req);
    const { crewId, invited, lines } = await createCrew(me, createCrewSchema.parse(req.body));
    await publishAll(lines);
    return reply.code(201).send({ ...(await crewDetail(me, crewId)), invited });
  });

  /** Members only: who's in it, roles, the champion, records, and (for the creator and admins) pending invites. */
  app.get("/crews/:id", async (req) => crewDetail(requireUser(req), uuidParam(req)));

  /** Rename or re-face: the creator and admins. */
  app.patch("/crews/:id", async (req) => {
    const me = requireUser(req);
    await updateCrew(me, uuidParam(req), updateCrewSchema.parse(req.body));
    return crewDetail(me, uuidParam(req));
  });

  /** The crew board: every member, Climb plus party points, this week or all time; last week's champion crowned. */
  app.get("/crews/:id/board", async (req) => {
    const me = requireUser(req);
    const crewId = uuidParam(req);
    await membership(db, crewId, me.id);
    const { period } = boardQuerySchema.parse(req.query ?? {});
    return socialBoard(await crewMemberIds(crewId), period, me.id, { everyone: true, champion: await championOf(crewId) });
  });

  /** The creator and admins ask people they're connected to. */
  app.post("/crews/:id/invites", async (req, reply) => {
    const me = requireUser(req);
    return reply.code(201).send(await inviteToCrew(me, uuidParam(req), crewInviteSchema.parse(req.body).userIds));
  });

  for (const [answer, accept] of [["accept", true], ["decline", false]] as const) {
    app.post(`/crews/:id/invite/${answer}`, async (req) => {
      const { joined, lines } = await answerCrewInvite(requireUser(req), uuidParam(req), accept);
      await publishAll(lines);
      return { joined };
    });
  }

  /** Creator only: promote to admin or back to member. */
  app.patch("/crews/:id/members/:userId", async (req) => setCrewRole(requireUser(req), uuidParam(req), uuidParam(req, "userId"), crewRoleSchema.parse(req.body).role));

  /** Creator only: remove someone. */
  app.delete("/crews/:id/members/:userId", async (req) => {
    const { lines } = await removeFromCrew(requireUser(req), uuidParam(req), uuidParam(req, "userId"));
    await publishAll(lines);
    return { removed: true };
  });

  /** Leave. The creator's leaving hands the crew over; the last one out archives it. */
  app.post("/crews/:id/leave", async (req) => {
    const { archived, lines } = await leaveCrew(requireUser(req), uuidParam(req));
    await publishAll(lines);
    return { left: true, archived };
  });

  /** Crews I've been asked to join. */
  app.get("/me/crew-invites", async (req) => myCrewInvites(requireUser(req)));
}

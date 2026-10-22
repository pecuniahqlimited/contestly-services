import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, getClimbSettings, prizesForWeek } from "@contestly/db";
import { CLIMB_BOARD_VIEWS, challengeAnswerBodySchema, climbAnswerBodySchema, lagosDay, weekEndsAt, weekOf, type ClimbBoard } from "@contestly/shared";
import { requireSession, uuidParam } from "../auth.js";
import { climbHome } from "../climb/home.js";
import { answerRound, getRun, startRun } from "../climb/runs.js";
import { everyoneBoard, friendsBoard, prizeLine } from "../climb/boards.js";
import { answerChallenge, challengeState, startChallenge } from "../climb/challenge.js";

const boardQuerySchema = z.object({ board: z.enum(CLIMB_BOARD_VIEWS).default("friends") });

export async function climbRoutes(app: FastifyInstance) {
  // Guests can play The Climb; their points are kept and reach the boards when they sign up (boards.ts).

  /** The Climb home: today's best, the ladder, Today's challenge, the week, records. */
  app.get("/climb", async (req) => climbHome(requireSession(req)));

  /** Start a run (free, unlimited). Any run still going is ended first, keeping what it banked. */
  app.post("/climb/runs", async (req, reply) => reply.code(201).send(await startRun(requireSession(req))));

  /** The run now: the open round, or when the next one opens. */
  app.get("/climb/runs/:id", async (req) => getRun(requireSession(req), uuidParam(req)));

  /** Answer the open round. One answer per round; it decides the round and maybe the stage. */
  app.post("/climb/runs/:id/answer", async (req) => {
    const { roundId, answer } = climbAnswerBodySchema.parse(req.body);
    return answerRound(requireSession(req), uuidParam(req), roundId, answer);
  });

  /** This week's board: friends (the people you follow, and you) or everyone. */
  app.get("/climb/leaderboard", async (req): Promise<ClimbBoard> => {
    const me = requireSession(req);
    const { board } = boardQuerySchema.parse(req.query);
    const week = weekOf(lagosDay());
    const [settings, { prizes }] = await Promise.all([getClimbSettings(), prizesForWeek(db, week)]);
    const [b, line] = await Promise.all([
      board === "everyone" ? everyoneBoard(week, me.id, settings.boardLimit) : friendsBoard(week, me.id),
      prizeLine(week, prizes.winners),
    ]);
    return { board, week, endsAt: weekEndsAt(week).toISOString(), prizeLine: line, ...b };
  });

  /** Today's challenge, as far as the player has got (404 when none is scheduled today). */
  app.get("/climb/challenge", async (req) => challengeState(requireSession(req)));

  /** Start today's challenge, or pick up the one go already started. */
  app.post("/climb/challenge/start", async (req) => startChallenge(requireSession(req)));

  app.post("/climb/challenge/answer", async (req) => {
    const { idx, index } = challengeAnswerBodySchema.parse(req.body);
    return answerChallenge(requireSession(req), idx, index);
  });
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, count, desc, eq, gte, inArray } from "drizzle-orm";
import {
  approveAward, canBePaidCash, climbAwards, climbChallengeAttempts, climbChallenges, currentLadder, db, getClimbSettings, rejectAward, saveLadder, setClimbSettings, users,
  type ClimbAwardRow, type ClimbChallengeRow,
} from "@contestly/db";
import { generateRound, pickRoundType, roundReveal, roundView, stageLevel } from "@contestly/game";
import {
  CLIMB_AWARD_STATUSES, CLIMB_GAME_LABELS, CLIMB_GAME_TYPES, adminClimbSettingsSchema, adminLadderBodySchema, addDays, ladderSummary, lagosDay, upsertChallengeSchema,
  type AdminLadderResponse, type ClimbAward, type ClimbLadder,
} from "@contestly/shared";
import { dayParam, requireAdmin, uuidParam } from "../auth.js";
import { personColumns } from "../people.js";
import { freshRng } from "../climb/rng.js";

/** How far back the challenge list goes by default. */
const CHALLENGE_LIST_PAST_DAYS = 7;

const gameTypes = CLIMB_GAME_TYPES.map((type) => ({ type, ...CLIMB_GAME_LABELS[type] }));
const ladderResponse = (version: number, ladder: ClimbLadder): AdminLadderResponse => ({ version, ladder, summary: ladderSummary(ladder), gameTypes });

const refused = (message: string, statusCode = 409) => Object.assign(new Error(message), { statusCode });

async function attemptsBy(ids: string[]) {
  if (!ids.length) return new Map<string, number>();
  const rows = await db.select({ id: climbChallengeAttempts.challengeId, n: count() }).from(climbChallengeAttempts).where(inArray(climbChallengeAttempts.challengeId, ids)).groupBy(climbChallengeAttempts.challengeId);
  return new Map(rows.map((r) => [r.id, Number(r.n)]));
}
const adminChallenge = (c: ClimbChallengeRow, attempts: number) => ({ id: c.id, day: c.day, title: c.title, questions: c.questions, seconds: c.seconds, maxPoints: c.maxPoints, attempts });

async function awardsView(rows: ClimbAwardRow[]): Promise<ClimbAward[]> {
  if (!rows.length) return [];
  const people = await db.select({ ...personColumns, phone: users.phone, isSystem: users.isSystem }).from(users).where(inArray(users.id, rows.map((r) => r.userId)));
  const byId = new Map(people.map((p) => [p.id, p]));
  return rows.map((a) => {
    const { phone, isSystem, ...person } = byId.get(a.userId)!;
    return {
      id: a.id, week: a.week, place: a.place, points: a.points, amountKobo: a.amountKobo, status: a.status, person,
      canBePaid: canBePaidCash({ phone, isSystem }), decidedAt: a.decidedAt?.toISOString() ?? null, paidAt: a.paidAt?.toISOString() ?? null,
    };
  });
}

const awardsQuerySchema = z.object({ week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), status: z.enum(CLIMB_AWARD_STATUSES).optional() });
const challengesQuerySchema = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

export async function adminClimbRoutes(app: FastifyInstance) {
  /** The current ladder, the game-type catalogue, and what a full run means for players. */
  app.get("/admin/climb/ladder", async (req) => {
    requireAdmin(req);
    const { version, ladder } = await currentLadder();
    return ladderResponse(version, ladder);
  });

  /** Save the ladder as a new version. Runs already going keep the version they started on. */
  app.put("/admin/climb/ladder", async (req) => {
    const admin = requireAdmin(req);
    const { ladder } = adminLadderBodySchema.parse(req.body);
    const saved = await saveLadder(ladder, admin.id);
    return ladderResponse(saved.version, saved.ladder);
  });

  /** "Preview a run": one sample round per stage of a ladder (saved or not), answers shown. */
  app.post("/admin/climb/ladder/preview", async (req) => {
    requireAdmin(req);
    const { ladder } = adminLadderBodySchema.parse(req.body);
    const rng = freshRng();
    const stages = ladder.stages.map((s, i) => {
      const type = pickRoundType(ladder, i, rng);
      const payload = generateRound(type, { rng, level: stageLevel(i, ladder.stages.length), seconds: s.seconds });
      return { stage: i + 1, type, view: roundView(type, payload), answer: roundReveal(type, payload) };
    });
    return { summary: ladderSummary(ladder), stages };
  });

  /** Weekly winners and prizes, pauses, and Today's challenge defaults. */
  app.get("/admin/climb/settings", async (req) => {
    requireAdmin(req);
    return { settings: await getClimbSettings() };
  });

  app.put("/admin/climb/settings", async (req) => {
    requireAdmin(req);
    const { settings } = adminClimbSettingsSchema.parse(req.body);
    return { settings: await setClimbSettings(settings) };
  });

  /** Today's challenges from `from` (default a week ago) onwards, answers included. */
  app.get("/admin/climb/challenges", async (req) => {
    requireAdmin(req);
    const { from = addDays(lagosDay(), -CHALLENGE_LIST_PAST_DAYS) } = challengesQuerySchema.parse(req.query);
    const rows = await db.select().from(climbChallenges).where(gte(climbChallenges.day, from)).orderBy(asc(climbChallenges.day));
    const attempts = await attemptsBy(rows.map((r) => r.id));
    return rows.map((r) => adminChallenge(r, attempts.get(r.id) ?? 0));
  });

  /** Write the challenge for a day (today or later). Refused once anyone has played it. */
  app.put("/admin/climb/challenges/:day", async (req) => {
    const admin = requireAdmin(req);
    const day = dayParam(req);
    if (day < lagosDay()) throw refused("day_passed", 422);
    const body = upsertChallengeSchema.parse(req.body);
    const settings = await getClimbSettings();
    return db.transaction(async (tx) => {
      const [existing] = await tx.select().from(climbChallenges).where(eq(climbChallenges.day, day)).for("update");
      if (existing && (await attemptsBy([existing.id])).get(existing.id)) throw refused("challenge_played");
      const [row] = existing
        ? await tx.update(climbChallenges).set({ ...body, updatedAt: new Date() }).where(eq(climbChallenges.id, existing.id)).returning()
        : await tx.insert(climbChallenges).values({ ...body, day, seconds: settings.challengeSeconds, maxPoints: settings.challengeMaxPoints, createdByUserId: admin.id }).returning();
      return adminChallenge(row, 0);
    });
  });

  /** Take a day's challenge off. Refused once anyone has played it. */
  app.delete("/admin/climb/challenges/:day", async (req, reply) => {
    requireAdmin(req);
    const day = dayParam(req);
    await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(climbChallenges).where(eq(climbChallenges.day, day)).for("update");
      if (!existing) throw refused("not_found", 404);
      if ((await attemptsBy([existing.id])).get(existing.id)) throw refused("challenge_played");
      await tx.delete(climbChallenges).where(eq(climbChallenges.id, existing.id));
    });
    return reply.code(204).send();
  });

  /** Weekly prizes, newest week first, best place first. */
  app.get("/admin/climb/awards", async (req) => {
    requireAdmin(req);
    const { week, status } = awardsQuerySchema.parse(req.query);
    const rows = await db.select().from(climbAwards)
      .where(and(week ? eq(climbAwards.week, week) : undefined, status ? eq(climbAwards.status, status) : undefined))
      .orderBy(desc(climbAwards.week), asc(climbAwards.place));
    return awardsView(rows);
  });

  /** Approve: paid now if the winner's account can be paid, otherwise approved and waiting. Approving again retries the payment. */
  app.post("/admin/climb/awards/:id/approve", async (req) => {
    const admin = requireAdmin(req);
    const award = await db.transaction((tx) => approveAward(tx, uuidParam(req), admin.id));
    return (await awardsView([award]))[0];
  });

  app.post("/admin/climb/awards/:id/reject", async (req) => {
    const admin = requireAdmin(req);
    const award = await db.transaction((tx) => rejectAward(tx, uuidParam(req), admin.id));
    return (await awardsView([award]))[0];
  });
}

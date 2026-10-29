import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, count, desc, eq, gte, inArray } from "drizzle-orm";
import {
  approveAward, canBePaidCash, recordAdminAction, climbAwards, climbChallengeAttempts, climbChallenges, currentLadder, currentPrizes, db, getClimbSettings, prizesForWeek, rejectAward, saveLadder, savePrizes, setClimbSettings, users,
  type ClimbAwardRow, type ClimbChallengeRow,
} from "@contestly/db";
import { generateRound, pickRoundType, roundReveal, roundView, stageLevel } from "@contestly/game";
import {
  CLIMB_AWARD_STATUSES, CLIMB_GAME_LABELS, CLIMB_GAME_TYPES, adminClimbSettingsSchema, adminReasonBodySchema, adminLadderBodySchema, adminPrizesBodySchema, addDays, ladderSummary, lagosDay, upsertChallengeSchema, weekOf, weeklyPrizeTotalKobo,
  type AdminLadderResponse, type AdminPrizesResponse, type ClimbAward, type ClimbLadder,
} from "@contestly/shared";
import { dayParam, requireAdmin, uuidParam } from "../auth.js";
import { personColumns } from "../people.js";
import { freshRng } from "../climb/rng.js";

/** How far back the challenge list goes by default. */
const CHALLENGE_LIST_PAST_DAYS = 7;

const gameTypes = CLIMB_GAME_TYPES.map((type) => ({ type, ...CLIMB_GAME_LABELS[type] }));
const ladderResponse = (version: number, ladder: ClimbLadder): AdminLadderResponse => ({ version, ladder, summary: ladderSummary(ladder), gameTypes });

async function prizesResponse(): Promise<AdminPrizesResponse> {
  const week = weekOf(lagosDay());
  const [current, thisWeek] = await Promise.all([currentPrizes(), prizesForWeek(db, week)]);
  return {
    current: current && { version: current.version, prizes: current.prizes, totalKobo: weeklyPrizeTotalKobo(current.prizes), createdAt: current.createdAt.toISOString() },
    thisWeek: { week, ...thisWeek, totalKobo: weeklyPrizeTotalKobo(thisWeek.prizes) },
  };
}

const refused = (message: string, statusCode = 409) => Object.assign(new Error(message), { statusCode });

async function attemptsBy(ids: string[]) {
  if (!ids.length) return new Map<string, number>();
  const rows = await db.select({ id: climbChallengeAttempts.challengeId, n: count() }).from(climbChallengeAttempts).where(inArray(climbChallengeAttempts.challengeId, ids)).groupBy(climbChallengeAttempts.challengeId);
  return new Map(rows.map((r) => [r.id, Number(r.n)]));
}
const adminChallenge = (c: ClimbChallengeRow, attempts: number) => ({ id: c.id, day: c.day, title: c.title, questions: c.questions, seconds: c.seconds, maxPoints: c.maxPoints, attempts });

async function awardsView(rows: ClimbAwardRow[]): Promise<ClimbAward[]> {
  if (!rows.length) return [];
  const people = await db.select({ ...personColumns, isSystem: users.isSystem, isGuest: users.isGuest, emailVerifiedAt: users.emailVerifiedAt, deletedAt: users.deletedAt }).from(users).where(inArray(users.id, rows.map((r) => r.userId)));
  const byId = new Map(people.map((p) => [p.id, p]));
  return rows.map((a) => {
    const { isSystem, isGuest, emailVerifiedAt, deletedAt, ...person } = byId.get(a.userId)!;
    return {
      id: a.id, week: a.week, place: a.place, points: a.points, amountKobo: a.amountKobo, status: a.status, person,
      canBePaid: canBePaidCash({ isSystem, isGuest, emailVerifiedAt, deletedAt }), decidedAt: a.decidedAt?.toISOString() ?? null, paidAt: a.paidAt?.toISOString() ?? null,
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
    const before = await currentLadder();
    const saved = await saveLadder(ladder, admin.id);
    await recordAdminAction(db, { adminUserId: admin.id, action: "config.climb_ladder", targetType: "config", targetId: "climb_ladder", before: { version: before.version }, after: { version: saved.version, ladder: saved.ladder } });
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

  /** Weekly winners and the cash per place: the newest version, and the one this week closes with. */
  app.get("/admin/climb/prizes", async (req) => {
    requireAdmin(req);
    return prizesResponse();
  });

  /** Save winners and amounts as a new version. The week being played keeps its version; the next week to begin uses this. */
  app.put("/admin/climb/prizes", async (req) => {
    const admin = requireAdmin(req);
    const { prizes } = adminPrizesBodySchema.parse(req.body);
    const before = await currentPrizes();
    const saved = await savePrizes(prizes, admin.id);
    await recordAdminAction(db, { adminUserId: admin.id, action: "config.climb_prizes", targetType: "config", targetId: "climb_prizes", before: before && { version: before.version, prizes: before.prizes }, after: { version: saved.version, prizes: saved.prizes } });
    return prizesResponse();
  });

  /** Pauses, the network allowance, Today's challenge defaults and the board size. */
  app.get("/admin/climb/settings", async (req) => {
    requireAdmin(req);
    return { settings: await getClimbSettings() };
  });

  app.put("/admin/climb/settings", async (req) => {
    const admin = requireAdmin(req);
    const { settings } = adminClimbSettingsSchema.parse(req.body);
    const before = await getClimbSettings();
    const saved = await setClimbSettings(settings);
    await recordAdminAction(db, { adminUserId: admin.id, action: "config.climb_settings", targetType: "config", targetId: "climb_settings", before, after: saved });
    return { settings: saved };
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
      await recordAdminAction(tx, { adminUserId: admin.id, action: "climb.challenge_save", targetType: "config", targetId: `climb_challenge:${day}`, before: existing ? { title: existing.title, questions: existing.questions } : null, after: { title: row.title, questions: row.questions } });
      return adminChallenge(row, 0);
    });
  });

  /** Take a day's challenge off. Refused once anyone has played it. */
  app.delete("/admin/climb/challenges/:day", async (req, reply) => {
    const admin = requireAdmin(req);
    const { reason } = adminReasonBodySchema.parse(req.body);
    const day = dayParam(req);
    await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(climbChallenges).where(eq(climbChallenges.day, day)).for("update");
      if (!existing) throw refused("not_found", 404);
      if ((await attemptsBy([existing.id])).get(existing.id)) throw refused("challenge_played");
      await tx.delete(climbChallenges).where(eq(climbChallenges.id, existing.id));
      await recordAdminAction(tx, { adminUserId: admin.id, action: "climb.challenge_delete", targetType: "config", targetId: `climb_challenge:${day}`, reason, before: { title: existing.title, questions: existing.questions }, after: null });
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
    const id = uuidParam(req);
    const award = await db.transaction(async (tx) => {
      const [before] = await tx.select({ status: climbAwards.status }).from(climbAwards).where(eq(climbAwards.id, id));
      const after = await approveAward(tx, id, admin.id);
      if (before && before.status !== after.status) await recordAdminAction(tx, { adminUserId: admin.id, action: "climb.award_approve", targetType: "user", targetId: after.userId, before: { awardId: id, status: before.status }, after: { awardId: id, status: after.status } });
      return after;
    });
    return (await awardsView([award]))[0];
  });

  app.post("/admin/climb/awards/:id/reject", async (req) => {
    const admin = requireAdmin(req);
    const { reason } = adminReasonBodySchema.parse(req.body);
    const id = uuidParam(req);
    const award = await db.transaction(async (tx) => {
      const [before] = await tx.select({ status: climbAwards.status }).from(climbAwards).where(eq(climbAwards.id, id));
      const after = await rejectAward(tx, id, admin.id);
      if (before && before.status !== after.status) await recordAdminAction(tx, { adminUserId: admin.id, action: "climb.award_reject", targetType: "user", targetId: after.userId, reason, before: { awardId: id, status: before.status }, after: { awardId: id, status: after.status } });
      return after;
    });
    return (await awardsView([award]))[0];
  });
}

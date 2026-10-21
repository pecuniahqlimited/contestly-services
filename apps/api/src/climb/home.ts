/** Everything the Climb home shows, from the record and the boards. */
import { and, eq, sql } from "drizzle-orm";
import { climbDays, climbRuns, currentLadder, db, getClimbSettings, type User } from "@contestly/db";
import { currentStreak, lagosDay, weekDays, weekEndsAt, weekOf, type ClimbHome } from "@contestly/shared";
import { everyoneRank, friendsBoard, prizeLine } from "./boards.js";
import { todayChallenge } from "./challenge.js";
import { activeRunId } from "./runs.js";

export async function climbHome(user: User): Promise<ClimbHome> {
  const today = lagosDay();
  const week = weekOf(today);
  const [{ version, ladder }, settings, days, [records], challenge, activeId] = await Promise.all([
    currentLadder(),
    getClimbSettings(),
    db.select().from(climbDays).where(and(eq(climbDays.userId, user.id), eq(climbDays.week, week))),
    db.select({
      bestRunPoints: sql<number>`coalesce(max(${climbRuns.points}), 0)::int`,
      fastestStageOneMs: sql<number | null>`min(${climbRuns.stageMs}[1])`,
    }).from(climbRuns).where(eq(climbRuns.userId, user.id)),
    todayChallenge(user),
    activeRunId(user),
  ]);
  const [rank, line, friends] = await Promise.all([everyoneRank(week, user.id), prizeLine(week, settings.weeklyWinners), friendsBoard(week, user.id)]);
  const dayOf = new Map(days.map((d) => [d.day, d]));
  const todayRow = dayOf.get(today);
  const leader = friends.rows[0];
  return {
    ladder: { version, stages: ladder.stages.map((s, i) => ({ stage: i + 1, types: s.types.filter((t) => ladder.enabledTypes.includes(t)), rounds: s.rounds, toClear: s.toClear, seconds: s.seconds, points: s.points })) },
    today: { day: today, bestPoints: todayRow?.bestRunPoints ?? 0, bestStagesCleared: todayRow?.bestRunStages ?? 0, runs: todayRow?.runs ?? 0 },
    activeRunId: activeId,
    challenge,
    week: {
      week,
      endsAt: weekEndsAt(week).toISOString(),
      daysPlayed: days.filter((d) => d.runs > 0 || d.challengePoints > 0).length,
      stagesCleared: days.reduce((n, d) => n + d.bestRunStages, 0),
      points: days.reduce((n, d) => n + d.bestRunPoints + d.challengePoints, 0),
      days: weekDays(week).map((day) => ({ day, runPoints: dayOf.get(day)?.bestRunPoints ?? 0, challengePoints: dayOf.get(day)?.challengePoints ?? 0 })),
      everyone: { rank, prizeLine: line },
      friends: {
        rank: friends.me?.rank ?? null,
        of: friends.rows.length,
        leader: leader && !leader.isMe && friends.me ? { person: leader.person, gap: leader.points - friends.me.points } : null,
      },
    },
    records: { bestRunPoints: records.bestRunPoints, fastestStageOneMs: records.fastestStageOneMs === null ? null : Number(records.fastestStageOneMs), streakDays: currentStreak(user.lastPlayedOn, user.streakDays, today) },
  };
}

/**
 * The Climb end to end against the running stack (npm run dev): admin ladder and settings, a full clear,
 * a run that misses, refusals, an abandoned run, Today's challenge, the boards, and week close with
 * admin-approved prizes through the ledger. Fresh players each run, so it's repeatable.
 * TEST-ONLY: the "perfect player" reads round answers from Postgres, which no client can.
 */
import { and, eq } from "drizzle-orm";
import { climbChallengeAttempts, climbChallenges, climbRounds, climbWeekPrizes, climbWeeks, db, ledgerAccounts, ledgerEntries, sql, users } from "@contestly/db";
import { climbQueue, closeQueues } from "@contestly/queue";
import { lagosDay, type ClimbGameType } from "@contestly/shared";
import { api, call, failureCount, ok, sleep, waitFor } from "./sim-lib.js";

const tag = Date.now().toString(36);
const ADMIN = `climb.admin.${tag}`;
const ADA = `climb.ada.${tag}`, KEMI = `climb.kemi.${tag}`, SEGUN = `climb.segun.${tag}`, ZEE = `climb.zee.${tag}`;
const userId = async (handle: string) => (await db.select({ id: users.id }).from(users).where(eq(users.handle, handle)))[0].id;

/** Every run and challenge response carries the server's clock. */
const stamped = (res: any) => typeof res.serverNow === "string" && Math.abs(Date.parse(res.serverNow) - Date.now()) < 5_000;

/** Wait until the server opens the next round, then fetch it. */
async function nextRound(handle: string, state: any) {
  while (!state.round && state.run.status === "active") {
    await sleep(Math.max(0, Date.parse(state.nextOpensAt) - Date.now()) + 50);
    state = await api(handle, "GET", `/climb/runs/${state.run.id}`);
  }
  return state;
}

/** The answer a perfect player gives, from the stored round (test-only). */
async function rightAnswer(roundId: string) {
  const [r] = await db.select().from(climbRounds).where(eq(climbRounds.id, roundId));
  const p = r.payload as any;
  const byType: Record<ClimbGameType, () => unknown> = {
    pattern: () => ({ index: p.correctIndex }),
    scramble: () => ({ word: p.word }),
    word_hunt: () => ({ words: p.placed }),
    quick_maths: () => ({ value: p.value }),
    memory: () => ({ sequence: p.sequence }),
  };
  return byType[r.gameType as ClimbGameType]();
}
const wrongAnswer = { index: -1, word: "zzzz", words: [], value: -999999, sequence: [] };

/** Play a run: `plan(stage, roundInStage)` says whether to answer right. Returns the final run. */
async function play(handle: string, plan: (stage: number, round: number) => boolean) {
  let state = await api(handle, "POST", "/climb/runs");
  let last: any;
  for (;;) {
    state = await nextRound(handle, state);
    if (state.run.status !== "active") return { run: state.run, last };
    const { round } = state;
    const view = JSON.stringify(round.view);
    if (round.type === "pattern") ok(!view.includes("correctIndex"), "an open pattern round carries no answer");
    if (round.type === "quick_maths") ok(Object.keys(round.view).join() === "expression", "an open maths round carries only the sum");
    const answer = plan(round.stage, round.round) ? await rightAnswer(round.id) : wrongAnswer;
    last = await api(handle, "POST", `/climb/runs/${state.run.id}/answer`, { roundId: round.id, answer });
    if (last.nextOpensAt === null) return { run: last.run, last };
    state = { run: last.run, round: null, nextOpensAt: last.nextOpensAt };
  }
}

console.log("==== admin: ladder, preview, settings ====");
const before = await api(ADMIN, "GET", "/admin/climb/ladder");
ok(before.gameTypes.length === 5 && before.summary.rounds > 0, "the ladder comes with the game-type catalogue and its summary");
const badLadder = await call(ADMIN, "PUT", "/admin/climb/ladder", { ladder: { ...before.ladder, enabledTypes: ["scramble"] } });
ok(badLadder.status === 400, "a ladder that leaves a stage with no game type is refused");
const preview = await api(ADMIN, "POST", "/admin/climb/ladder/preview", { ladder: before.ladder });
ok(preview.stages.length === before.ladder.stages.length && preview.stages.every((s: any) => s.answer && s.view), "preview: one sample round per stage, answers shown");
// A quick ladder for the sim (restored at the end): the default's shape with short clocks.
const testLadder = { ...before.ladder, stages: before.ladder.stages.map((s: any) => ({ ...s, seconds: 6 })), enabledTypes: before.ladder.enabledTypes };
const saved = await api(ADMIN, "PUT", "/admin/climb/ladder", { ladder: testLadder });
ok(saved.version > before.version, "saving the ladder makes a new version");
const settingsBefore = (await api(ADMIN, "GET", "/admin/climb/settings")).settings;
await api(ADMIN, "PUT", "/admin/climb/settings", { settings: { ...settingsBefore, revealSeconds: 0, stageBreakSeconds: 1 } });
const badSettings = await call(ADMIN, "PUT", "/admin/climb/settings", { settings: { ...settingsBefore, revealSeconds: -1 } });
ok(badSettings.status === 400, "settings out of range are refused");
const prizesBefore = await api(ADMIN, "GET", "/admin/climb/prizes");
/** Set when the sim writes today's challenge itself, so it can take it away again. */
let createdChallengeDay: string | null = null;

try {
  console.log("\n==== a full clear ====");
  const full = await play(ADA, () => true);
  const maxPoints = testLadder.stages.reduce((n: number, s: any) => n + s.points, 0);
  ok(full.run.status === "cleared" && full.run.stagesCleared === testLadder.stages.length, "every stage cleared ends the run as cleared");
  ok(full.run.points === maxPoints, `a full clear scores the sum of every stage (${full.run.points}/${maxPoints})`);
  ok(full.run.ladderVersion === saved.version, "the run used the ladder current when it started");

  console.log("\n==== a run that misses stage 2 ====");
  const missed = await play(KEMI, (stage) => stage === 1);
  ok(missed.run.status === "missed" && missed.run.stagesCleared === 1 && missed.run.points === testLadder.stages[0].points, "missing stage 2 ends the run with stage 1's points kept");
  ok(missed.last.correct === false && missed.last.stageOutcome === "missed", "the deciding round says the stage was missed");

  console.log("\n==== refusals, early decisions and abandoning ====");
  let s = await api(SEGUN, "POST", "/climb/runs");
  const first = s.round;
  const a1 = await api(SEGUN, "POST", `/climb/runs/${s.run.id}/answer`, { roundId: first.id, answer: await rightAnswer(first.id) });
  ok(a1.correct && a1.stageOutcome === "continue" && a1.run.stageRight === 1, "a right round in a 2-of-3 stage keeps it going");
  ok(stamped(s) && stamped(a1), "run and answer responses carry serverNow");
  const again = await call(SEGUN, "POST", `/climb/runs/${s.run.id}/answer`, { roundId: first.id, answer: await rightAnswer(first.id) });
  ok(again.status === 409 && again.body.error === "round_closed", "a round is answered once");
  const notMine = await call(ADA, "GET", `/climb/runs/${s.run.id}`);
  ok(notMine.status === 404, "nobody else can see a player's run");
  s = await nextRound(SEGUN, { run: a1.run, round: null, nextOpensAt: a1.nextOpensAt });
  const a2 = await api(SEGUN, "POST", `/climb/runs/${s.run.id}/answer`, { roundId: s.round.id, answer: await rightAnswer(s.round.id) });
  ok(a2.stageOutcome === "cleared" && a2.run.stage === 2 && a2.run.points === testLadder.stages[0].points, "two right clears a 2-of-3 stage without playing the third");
  const early = await call(SEGUN, "GET", `/climb/runs/${s.run.id}`);
  ok(early.body.round === null && !!early.body.nextOpensAt && stamped(early.body), "between rounds there's only the time the next one opens, and the server's clock");
  const restart = await api(SEGUN, "POST", "/climb/runs");
  const oldRun = await api(SEGUN, "GET", `/climb/runs/${s.run.id}`);
  ok(oldRun.run.status === "abandoned" && oldRun.run.points === testLadder.stages[0].points, "starting again abandons the run going, keeping what it banked");
  ok(restart.run.status === "active" && restart.round?.stage === 1, "the new run starts at stage 1");
  // Walk away from the open round: once its clock and the allowance have passed, it counts as a miss.
  await sleep(Date.parse(restart.round.closesAt) - Date.now() + settingsBefore.latencyAllowanceMs + 300);
  const lapsed = await api(SEGUN, "GET", `/climb/runs/${restart.run.id}`);
  ok(lapsed.run.status === "active" && lapsed.run.stagePlayed === 1 && lapsed.run.stageRight === 0, "a round left unanswered past its clock is a miss, and the run plays on");
  const tooLate = await call(SEGUN, "POST", `/climb/runs/${restart.run.id}/answer`, { roundId: restart.round.id, answer: await rightAnswer(restart.round.id) });
  ok(tooLate.status === 409 && tooLate.body.error === "round_closed", "an answer to a round that timed out is refused");

  console.log("\n==== Today's challenge ====");
  const today = lagosDay();
  const existing = await call(ADMIN, "GET", `/admin/climb/challenges?from=${today}`);
  const todays = (existing.body as any[]).find((c) => c.day === today);
  if (!todays) {
    createdChallengeDay = today;
    await api(ADMIN, "PUT", `/admin/climb/challenges/${today}`, { title: "Sim quiz", questions: [
      { prompt: "2 + 2?", options: ["3", "4", "5"], correctIndex: 1 },
      { prompt: "Capital of Nigeria?", options: ["Lagos", "Abuja", "Kano", "Ibadan"], correctIndex: 1 },
      { prompt: "Jollof is…", options: ["rice", "beans"], correctIndex: 0 },
    ] });
  }
  const past = await call(ADMIN, "PUT", "/admin/climb/challenges/2020-01-01", { title: "Too late", questions: [{ prompt: "?", options: ["a", "b"], correctIndex: 0 }] });
  ok(past.status === 422, "a challenge can't be written for a day that's gone");
  let cs = await api(ADA, "POST", "/climb/challenge/start");
  const maxChallenge = cs.challenge.maxPoints;
  const [attempt] = await db.select().from(climbChallengeAttempts).where(and(eq(climbChallengeAttempts.challengeId, cs.challenge.id), eq(climbChallengeAttempts.userId, await userId(ADA))));
  const { questions } = (await call(ADMIN, "GET", `/admin/climb/challenges?from=${today}`)).body.find((c: any) => c.day === today);
  while (cs.challenge.attempt.state !== "finished") {
    while (!cs.question) {
      await sleep(Math.max(0, Date.parse(cs.nextOpensAt) - Date.now()) + 50);
      cs = await api(ADA, "GET", "/climb/challenge");
    }
    const idx = cs.question.idx;
    const shown = attempt.optionOrder[idx].indexOf(questions[idx].correctIndex);
    ok(cs.question.options[shown] === questions[idx].options[questions[idx].correctIndex], `question ${idx + 1}: this player's option order maps back to the right answer`);
    const res = await api(ADA, "POST", "/climb/challenge/answer", { idx, index: shown });
    ok(res.correct && res.correctIndex === shown, `question ${idx + 1} graded right`);
    cs = { challenge: res.challenge, question: null, nextOpensAt: res.nextOpensAt };
  }
  ok(cs.challenge.attempt.points === maxChallenge, `all right scores the maximum (+${maxChallenge})`);
  // A player who lets every question go: an index past the options is refused, null is "no answer", graded wrong.
  let zs = await api(ZEE, "POST", "/climb/challenge/start");
  ok(stamped(zs), "challenge responses carry serverNow");
  const outOfRange = await call(ZEE, "POST", "/climb/challenge/answer", { idx: 0, index: zs.question.options.length });
  ok(outOfRange.status === 400 && outOfRange.body.error === "answer_out_of_range", "an index past the options is refused");
  const negative = await call(ZEE, "POST", "/climb/challenge/answer", { idx: 0, index: -1 });
  ok(negative.status === 400, "a negative index is refused");
  while (zs.challenge.attempt.state !== "finished") {
    while (!zs.question) {
      await sleep(Math.max(0, Date.parse(zs.nextOpensAt) - Date.now()) + 50);
      zs = await api(ZEE, "GET", "/climb/challenge");
    }
    const res = await api(ZEE, "POST", "/climb/challenge/answer", { idx: zs.question.idx, index: null });
    ok(res.correct === false && Number.isInteger(res.correctIndex) && stamped(res), `question ${zs.question.idx + 1}: no answer is graded wrong, with the right one revealed`);
    zs = { challenge: res.challenge, question: null, nextOpensAt: res.nextOpensAt };
  }
  ok(zs.challenge.attempt.correct === 0 && zs.challenge.attempt.points === 0, "no answers score nothing");
  const second = await api(ADA, "POST", "/climb/challenge/start");
  ok(second.challenge.attempt.state === "finished" && second.question === null, "one go per player: starting again just shows the result");
  const tooMany = await call(ADA, "POST", "/climb/challenge/answer", { idx: 0, index: 0 });
  ok(tooMany.status === 409, "answering after finishing is refused");
  const edit = await call(ADMIN, "PUT", `/admin/climb/challenges/${today}`, { title: "Changed", questions: [{ prompt: "?", options: ["a", "b"], correctIndex: 0 }] });
  ok(edit.status === 409, "a challenge someone has played can't be rewritten");

  console.log("\n==== home and boards ====");
  await api(ADA, "POST", `/users/${await userId(KEMI)}/follow`);
  const home = await api(ADA, "GET", "/climb");
  const fullPoints = testLadder.stages.reduce((n: number, s: any) => n + s.points, 0);
  ok(home.today.bestPoints === fullPoints && home.today.runs === 1, "home: today's best is the full clear");
  ok(home.week.points === fullPoints + maxChallenge, "home: the week is today's best plus Today's challenge");
  ok(home.week.days.length === 7 && home.week.days.find((d: any) => d.day === today).challengePoints === maxChallenge, "home: seven days, today's challenge on today");
  ok(home.records.bestRunPoints === fullPoints && home.records.fastestStageOneMs > 0 && home.records.streakDays === 1, "home: records and a one-day streak");
  ok(home.challenge.attempt.state === "finished", "home: Today's challenge shows as done");
  const friends = await api(ADA, "GET", "/climb/leaderboard?board=friends");
  ok(friends.rows.length === 2 && friends.rows[0].isMe && friends.rows[1].person.handle === KEMI, "friends: me and the person I follow, ranked");
  ok(friends.rows[0].clearedAll && friends.rows[1].bestStagesCleared === 1, "friends: each row's best run this week");
  const kemiFriends = await api(KEMI, "GET", "/climb/leaderboard?board=friends");
  ok(kemiFriends.rows.length === 1 && kemiFriends.ahead === null, "friends is who you follow, not who follows you");
  const everyone = await api(KEMI, "GET", "/climb/leaderboard?board=everyone");
  const adaRow = everyone.rows.find((r: any) => r.person.handle === ADA);
  ok(!!adaRow && everyone.me?.person.handle === KEMI && everyone.me.points === testLadder.stages[0].points, "everyone: the board has both, with my row");
  ok(everyone.ahead !== null && everyone.ahead.gap > 0, "everyone: the gap to the row above me");

  console.log("\n==== week close and weekly prizes ====");
  // A closed week in the past for two sim players, as the API would have written it.
  const week = new Date(Date.UTC(2001, 0, 1) + Math.floor(Math.random() * 1000) * 7 * 86_400_000).toISOString().slice(0, 10);
  const [ada, kemi] = [await userId(ADA), await userId(KEMI)];
  await db.insert(climbWeeks).values([
    { userId: ada, week, points: 300, reachedAt: new Date(Date.UTC(2001, 0, 2)) },
    { userId: kemi, week, points: 300, reachedAt: new Date(Date.UTC(2001, 0, 1)) },
  ]);
  // Prizes are versioned: the week closes with the version it was pinned to, not one saved afterwards.
  const badPrizes = await call(ADMIN, "PUT", "/admin/climb/prizes", { prizes: { winners: 2, prizeKobo: [700_000, 400_000, 100_000] } });
  ok(badPrizes.status === 400, "prizes need exactly one amount per winner");
  const started = await api(ADMIN, "PUT", "/admin/climb/prizes", { prizes: { winners: 2, prizeKobo: [700_000, 400_000] } });
  ok(started.current.totalKobo === 1_100_000 && started.current.prizes.winners === 2, "saving prizes makes a version with its weekly total");
  ok(started.thisWeek.version !== started.current.version || prizesBefore.current === null, "the week being played keeps the version it began with");
  await db.insert(climbWeekPrizes).values({ week, prizeVersion: started.current.version }); // as the worker pins it when the week begins
  const later = await api(ADMIN, "PUT", "/admin/climb/prizes", { prizes: { winners: 1, prizeKobo: [100_000] } });
  ok(later.current.version > started.current.version, "a later save is a newer version");
  const jobs = climbQueue();
  await jobs.add("week_close", { kind: "week_close" });
  const awards = await waitFor(async () => {
    const rows = (await call(ADMIN, "GET", `/admin/climb/awards?week=${week}`)).body as any[];
    return rows.length === 2 ? rows : null;
  }, { tries: 40 });
  ok(!!awards, "the worker closed the week into pending awards");
  if (awards) {
    ok(awards.every((a) => a.status === "pending"), "awards wait for an admin");
    ok(awards[0].person.handle === KEMI && awards[1].person.handle === ADA, "a tie goes to whoever got there first");
    ok(awards[0].amountKobo === 700_000 && awards[1].amountKobo === 400_000, "the week closed with the prizes it was pinned to, 1st gets 1st prize");
    await jobs.add("week_close", { kind: "week_close" });
    await sleep(1500);
    ok(((await call(ADMIN, "GET", `/admin/climb/awards?week=${week}`)).body as any[]).length === 2, "closing again adds nothing");
    // Dev-header users are signed up; take Kemi's verified email away so she stands for a winner who can't be paid yet.
    await db.update(users).set({ emailVerifiedAt: null }).where(eq(users.id, kemi));
    const held = await api(ADMIN, "POST", `/admin/climb/awards/${awards[0].id}/approve`);
    ok(held.status === "approved" && held.canBePaid === false && held.paidAt === null, "approved for a winner without a signed-in account: waits, unpaid");
    await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, kemi)); // payable again (the onboarding sim covers real sign-up paying held awards)
    const paid = await api(ADMIN, "POST", `/admin/climb/awards/${awards[0].id}/approve`);
    ok(paid.status === "paid" && !!paid.paidAt, "approving again once they can be paid pays it");
    await api(ADMIN, "POST", `/admin/climb/awards/${awards[0].id}/approve`);
    const credits = await db.select({ amount: ledgerEntries.amountKobo }).from(ledgerEntries).innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
      .where(and(eq(ledgerAccounts.userId, kemi), eq(ledgerEntries.type, "climb_prize")));
    ok(credits.length === 1 && credits[0].amount === awards[0].amountKobo, "paid once to cash through the ledger, however often it's approved");
    const rejected = await api(ADMIN, "POST", `/admin/climb/awards/${awards[1].id}/reject`, { reason: "sim: second place disqualified" });
    ok(rejected.status === "rejected", "an admin can turn a prize down");
    const after = await call(ADMIN, "POST", `/admin/climb/awards/${awards[1].id}/approve`);
    ok(after.status === 409, "a rejected prize can't then be approved");
    const paidReject = await call(ADMIN, "POST", `/admin/climb/awards/${awards[0].id}/reject`, { reason: "sim: try to reject a paid prize" });
    ok(paidReject.status === 409, "a paid prize can't be rejected");
  }
  await closeQueues(jobs);
} finally {
  await api(ADMIN, "PUT", "/admin/climb/ladder", { ladder: before.ladder });
  await api(ADMIN, "PUT", "/admin/climb/settings", { settings: settingsBefore });
  if (prizesBefore.current) await api(ADMIN, "PUT", "/admin/climb/prizes", { prizes: prizesBefore.current.prizes });
  if (createdChallengeDay) {
    // Played challenges can't be deleted through the API, so the sim removes its own directly (attempts' answers cascade).
    const [ch] = await db.select({ id: climbChallenges.id }).from(climbChallenges).where(eq(climbChallenges.day, createdChallengeDay));
    if (ch) {
      await db.delete(climbChallengeAttempts).where(eq(climbChallengeAttempts.challengeId, ch.id));
      await db.delete(climbChallenges).where(eq(climbChallenges.id, ch.id));
    }
  }
  console.log(`\n(ladder, settings and prizes restored${createdChallengeDay ? "; the sim's challenge for today removed" : ""})`);
}

await sql.end();
console.log(failureCount() ? `\n${failureCount()} check(s) failed` : "\nall Climb checks passed");
process.exit(failureCount() ? 1 : 0);

/**
 * Sealed-mode sim, against the live question bank (never wiped):
 *
 * 1. A party whose set can't be built: the host is told why, joins stay open, nothing is cancelled,
 *    and a retry with an edited brief makes the set ready.
 * 2. Two parties, same brief, both created (and their sets sealed) up front with only the host
 *    seated. Party 1 is played. Then ada.o and kemz join party 2: they've now seen party 1's
 *    questions, which party 2's set was built with — so the start-time re-check swaps exactly those.
 *    Asserts nothing repeats, and that a start with nothing to swap starts instantly.
 * 3. In each round: answers stay changeable until the clock ends and the final change is what's
 *    graded, at its own time (tunde changes wrong → right on Q1; ada.o right → wrong on Q2).
 *
 * TEST-ONLY. This script reads correct answers straight from Postgres to drive its personas;
 * nothing like it exists in the product, and it is never used to fake presence.
 *
 * Run with the stack up (npm run infra:up && npm run dev):  npm run sim:sealed
 */
import { Client, type Room } from "colyseus.js";
import { and, count, eq, inArray, isNotNull } from "drizzle-orm";
import { db, parties, partyQuestions, partyAnswers, partyQuestionEvents, ledgerEntries, bankQuestions, questionGenerations } from "@contestly/db";
import { notifyQueue, partyQueue } from "@contestly/queue";
import { MSG, PARTY_ROOM } from "@contestly/shared";
import { isOptionFormat, type QuestionFormat } from "@contestly/game";
import { isKnownBadQuestion } from "../apps/questions/src/providers/mock/deck.js";
import { RT, api, call, correctAnswer, failureCount, inMinutes, leaks, ok, partyNetKobo, waitFor, wrongAnswer } from "./sim-lib.js";

const HANDLES = ["tunde", "ada.o", "kemz"];
const BRIEF = "Nigerian general knowledge — cities, food, music, football";
/** The question on which kemz answers only after the clock: must score 0 and store answered_ms NULL. */
const LATE_IDX = 3;
/** tunde sends a wrong answer first, then the right one: graded right, timed from the change. */
const CHANGE_TO_RIGHT = { idx: 1, firstMs: 150, finalMs: 1_200 };
/** ada.o sends the right answer first, then changes to a wrong one: graded wrong, 0 points. */
const CHANGE_TO_WRONG = { idx: 2, firstMs: 300, finalMs: 1_500 };

type Send = { atMs: number; play: (format: QuestionFormat, payload: any) => unknown };
type Persona = { handle: string; sends: (idx: number, questionMs: number) => Send[] };
const once = (atMs: number, play: Send["play"]): Send[] => [{ atMs, play }];
const personas: Persona[] = [
  // tunde dawdles on Q0 so ada.o takes the early lead; from Q1 he's quicker and overtakes — a rank flip we assert.
  { handle: "tunde", sends: (idx, ms) =>
      idx === 0 ? once(Math.floor(ms * 0.8), correctAnswer)
      : idx === CHANGE_TO_RIGHT.idx ? [{ atMs: CHANGE_TO_RIGHT.firstMs, play: wrongAnswer }, { atMs: CHANGE_TO_RIGHT.finalMs, play: correctAnswer }]
      : once(400, correctAnswer) },
  { handle: "ada.o", sends: (idx, ms) =>
      idx === 0 ? once(400, correctAnswer)
      : idx === CHANGE_TO_WRONG.idx ? [{ atMs: CHANGE_TO_WRONG.firstMs, play: correctAnswer }, { atMs: CHANGE_TO_WRONG.finalMs, play: wrongAnswer }]
      : once(Math.floor(ms * 0.6), correctAnswer) },
  // kemz is fast and wrong — and on LATE_IDX only answers after the question closed.
  { handle: "kemz", sends: (idx, ms) => once(idx === LATE_IDX ? ms + 600 : 300, wrongAnswer) },
];

for (const h of HANDLES) await api(h, "POST", "/wallet/dev-topup", { nairaAmount: 1000 }).catch(() => ({}));
const userIds = new Map<string, string>();
for (const h of HANDLES) userIds.set(h, (await api(h, "GET", "/me")).id);

/** Every bank question any of these players has been shown, in any party so far. */
async function seenByPlayers(): Promise<Set<string>> {
  const rows = await db.selectDistinct({ ref: partyQuestions.sourceRef }).from(partyAnswers)
    .innerJoin(partyQuestions, eq(partyAnswers.questionId, partyQuestions.id))
    .where(and(inArray(partyAnswers.userId, [...userIds.values()]), isNotNull(partyQuestions.sourceRef)));
  return new Set(rows.map((r) => r.ref!));
}

const playOrderBankIds = async (partyId: string) =>
  (await db.select({ ref: partyQuestions.sourceRef }).from(partyQuestions)
    .where(and(eq(partyQuestions.partyId, partyId), eq(partyQuestions.reserve, false))).orderBy(partyQuestions.idx)).map((r) => r.ref!);

/** Create a sealed party as tunde and wait for its set; asserts the lifecycle shows and the content doesn't. */
async function createSealedParty(title: string, extra: Record<string, unknown> = {}) {
  const party = await api("tunde", "POST", "/parties", {
    title, brief: BRIEF, entryKobo: 20_000, maxPlayers: 5, funding: "pooled", split: "winner", startsAt: inMinutes(30), questionCount: 5, secondsPerQuestion: 5, ...extra,
  });
  ok(party.questions?.status === "generating", `${title}: set starts generating the moment the party is created`);
  return party as { id: string; split: number[]; category: string };
}

async function waitForSet(partyId: string, label: string, until: "ready" | "failed" = "ready") {
  const detail = await waitFor(async () => {
    const d = await api("tunde", "GET", `/parties/${partyId}`);
    return d.questions?.status === until || d.questions?.status === (until === "ready" ? "failed" : "ready") ? d : null;
  }, { tries: 120 });
  ok(detail?.questions?.status === until, `${label}: set is ${until} on party detail (${detail?.questions?.status}${detail?.questions?.error ? `: ${detail.questions.error}` : ""})`);
  return detail;
}

/** No question text, option or answer key from the set may appear anywhere in what the API returns. */
async function assertNoContentLeak(partyId: string, label: string) {
  const body = JSON.stringify(await api("ada.o", "GET", `/parties/${partyId}`));
  const rows = await db.select().from(partyQuestions).where(eq(partyQuestions.partyId, partyId));
  const leaked = rows.filter((q) => body.includes((q.payload as { question: string }).question));
  ok(rows.length > 0 && leaked.length === 0 && leaks(JSON.parse(body)).length === 0, `${label}: party detail shows the set's state but none of its content`);
}

// ---- 1. a set that fails: told, still open, retried ------------------------------------------

console.log("\n==== a set that can't be built ====");
{
  // 30 picture questions: more than the bank and the generator can supply, so the gate fails closed.
  const doomed = await createSealedParty("Sim doomed party", { formats: ["picture"], questionCount: 30 });
  const failed = await waitForSet(doomed.id, "doomed party", "failed");
  ok(!!failed?.questions?.error, `host gets a reason they can act on ("${failed?.questions?.error}")`);
  ok(failed?.status === "open", "a failed set doesn't cancel the party");
  const join = await call("ada.o", "POST", `/parties/${doomed.id}/join`);
  ok(join.status === 201, `joins stay open while the set has failed (${join.status})`);
  const notified = await waitFor(async () => {
    const jobs = await notifyQueue().getJobs(["completed", "waiting", "active", "delayed"], 0, 200);
    return jobs.find((j) => j.data.kind === "questions_failed" && j.data.partyId === doomed.id);
  }, { tries: 20 });
  ok(!!notified && (notified.data as any).hostId === userIds.get("tunde"), "the host was notified that the questions failed");
  ok((await call("ada.o", "POST", `/parties/${doomed.id}/questions/retry`, {})).status === 403, "only the host's team can retry");
  const retry = await call("tunde", "POST", `/parties/${doomed.id}/questions/retry`, { formats: ["pick_one", "pick_all", "order", "match", "picture"], brief: `${BRIEF} — any question type` });
  ok(retry.status === 202, `host retries with an edited brief and more formats (${retry.status})`);
  await waitForSet(doomed.id, "doomed party after retry");
  ok((await call("tunde", "POST", `/parties/${doomed.id}/questions/retry`, {})).status === 409, "a ready set can't be retried");
  // Don't leave it waiting 30 minutes: start it now. Nobody opens the room, so the watchdog refunds it.
  const job = await partyQueue().getJob(`start-${doomed.id}`);
  await job?.promote();
}

// ---- 2. play rounds -----------------------------------------------------------------------------

interface Played {
  texts: string[];
  bankIds: string[];
  swaps: number;
  msToFirstQuestion: number;
  /** What the host's lobby was told about the set, in order, with "first question" marking the round's start. */
  lobbyStatuses: string[];
}

async function playParty(round: number, partyId: string, party: { split: number[]; category: string }): Promise<Played> {
  console.log(`\n==== party ${round}: playing ====`);
  ok(party.split.join() === "100", "winner takes all is stored as its shares");
  ok(typeof party.category === "string" && party.category.length > 0, `category inferred from the brief (${party.category})`);

  let questionLeaks = 0;
  const seenQuestionTexts: string[] = [];
  let revealsSeen = 0;
  let distributionsSeen = 0;
  let firstStandingsPrevRanks: (number | null)[] = [];
  let laterStandingsWithPrevRank = 0;
  let standingsSeen = 0;
  let rankFlipSeen = false;
  let chatDuringQuestionRejected = false;
  let chatDuringStandingsSeen = false;
  let firstQuestionAt = 0;
  const lobbyStatuses: string[] = [];
  const errorsSeen: Record<string, string[]> = {};
  let resolveFinal!: (rows: any[]) => void;
  const finalRows = new Promise<any[]>((r) => (resolveFinal = r));

  // The sim (not the clients) knows the questions, read from Postgres.
  const questionById = async (id: string) => (await db.select().from(partyQuestions).where(eq(partyQuestions.id, id)))[0];
  const questionIds: string[] = [];

  const rooms: Room[] = [];
  for (const persona of personas) {
    const room = await new Client(RT).joinOrCreate(PARTY_ROOM, { partyId, devUser: persona.handle });
    rooms.push(room);
    const isHost = persona.handle === "tunde";

    room.onMessage(MSG.question, async (view: any) => {
      if (isHost) {
        if (!firstQuestionAt) lobbyStatuses.push("first question");
        firstQuestionAt ||= Date.now();
        questionIds[view.idx] = view.questionId;
        if (typeof view?.view?.question === "string") seenQuestionTexts.push(view.view.question);
      }
      const leaked = leaks(view);
      if (leaked.length) {
        questionLeaks++;
        console.log(`✗ LEAK in question message to ${persona.handle}: ${leaked.join(", ")}`);
      }
      const q = await questionById(view.questionId);
      // No lock-in: send every change; the last one before the clock ends is the answer.
      for (const s of persona.sends(view.idx, view.seconds * 1000)) {
        setTimeout(() => room.send(MSG.answer, s.play(q.format as QuestionFormat, q.payload)), s.atMs);
      }
      // chat must be rejected while a question is up (checked once, from ada)
      if (persona.handle === "ada.o" && view.idx === 1) room.send(MSG.chat, { text: "mid-question chat, should bounce" });
    });

    room.onMessage(MSG.error, (e: any) => {
      if (e?.error === "chat_closed") chatDuringQuestionRejected = true;
      (errorsSeen[persona.handle] ??= []).push(e?.error);
    });

    if (isHost) {
      room.onMessage(MSG.phase, (m: any) => { if (m?.questions?.status) lobbyStatuses.push(m.questions.status); });
      room.onMessage(MSG.questionsStatus, (m: any) => lobbyStatuses.push(m.status));
      room.onMessage(MSG.reveal, (reveal: any) => {
        revealsSeen++;
        if (Array.isArray(reveal.distribution)) distributionsSeen++;
      });
      room.onMessage(MSG.standings, (s: any) => {
        standingsSeen++;
        if (standingsSeen === 1) firstStandingsPrevRanks = s.rows.map((r: any) => r.prevRank);
        else if (s.rows.every((r: any) => r.prevRank !== null)) laterStandingsWithPrevRank++;
        if (standingsSeen > 1 && s.rows.some((r: any) => r.prevRank !== null && r.prevRank !== r.rank)) rankFlipSeen = true;
        if (standingsSeen === 2) rooms[1].send(MSG.chat, { text: "gg so far!" }); // chat is open on standings
      });
      room.onMessage(MSG.chatMessage, (m: any) => {
        if (m.text === "gg so far!") chatDuringStandingsSeen = true;
      });
      room.onMessage(MSG.finalStandings, (f: any) => resolveFinal(f.rows));
    } else {
      for (const t of [MSG.reveal, MSG.standings, MSG.chatMessage, MSG.finalStandings, MSG.phase, MSG.questionsStatus]) room.onMessage(t, () => {});
    }
    room.onMessage(MSG.presence, () => {});
  }

  // Players are in the lobby BEFORE the party starts, so the worker's party:events "live"
  // publish — the real product path — is what starts the round in the room.
  // Don't wait for startsAt: promote the delayed start job (same code path the worker runs).
  const startJob = await partyQueue().getJob(`start-${partyId}`);
  if (!startJob) throw new Error("start job not found — is the API running?");
  const promotedAt = Date.now();
  await startJob.promote();
  console.log("3 players in the lobby; start job promoted; playing 5 questions (~90s)…");

  const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("sim timed out after 240s")), 240_000));
  const final = (await Promise.race([finalRows, timeout])) as any[];

  // ---- the round ------------------------------------------------------------------------

  console.log("\nfinal standings:");
  for (const r of final) {
    const handle = [...userIds.entries()].find(([, id]) => id === r.userId)?.[0] ?? r.userId;
    console.log(`  #${r.rank} ${handle.padEnd(8)} score=${String(r.score).padStart(4)} time=${(r.timeMs / 1000).toFixed(1)}s prev_rank=${r.prevRank}`);
  }
  const byHandle = (h: string) => final.find((r) => r.userId === userIds.get(h))!;
  const played = await db.select().from(partyQuestions).where(and(eq(partyQuestions.partyId, partyId), eq(partyQuestions.reserve, false)));
  const optionQuestions = played.filter((q) => isOptionFormat(q.format as QuestionFormat)).length;

  ok(final.length === 3, "3 players in the final table");
  ok(byHandle("tunde").rank === 1, "tunde (quick + right) finishes 1st");
  ok(byHandle("ada.o").rank === 2, "ada.o (slower + right) finishes 2nd");
  ok(byHandle("kemz").rank === 3, "kemz (fast + wrong) finishes 3rd");
  ok(byHandle("tunde").score > byHandle("ada.o").score, "speed bonus separates the two correct players");
  ok(byHandle("kemz").score === 0, "wrong answers score 0");
  ok(questionLeaks === 0, "no correct answer ever appeared in a question message");
  ok(revealsSeen === 5, `reveal after every question (saw ${revealsSeen})`);
  ok(distributionsSeen === optionQuestions, `distributions on every option-format question (${distributionsSeen} of ${optionQuestions})`);
  ok(firstStandingsPrevRanks.every((p) => p === null), "first standings carry prev_rank=null");
  ok(laterStandingsWithPrevRank >= 4, `later standings carry prev_rank (saw ${laterStandingsWithPrevRank})`);
  ok(rankFlipSeen, "a mid-game rank flip showed prev_rank ≠ rank in a standings");
  ok(chatDuringQuestionRejected, "chat rejected while a question is open");
  ok(chatDuringStandingsSeen, "chat delivered during standings");

  const detail = await api("tunde", "GET", `/parties/${partyId}`);
  for (const h of HANDLES) {
    const persisted = detail.players.find((p: any) => p.id === userIds.get(h));
    const live = byHandle(h);
    ok(persisted?.score === live.score && persisted?.rank === live.rank, `persisted score/rank for ${h} match the room (${persisted?.score}/${persisted?.rank})`);
  }

  // ---- no lock-in: the final change counts, timed from when it arrived -----------------------

  const answerOf = async (idx: number, handle: string) =>
    (await db.select().from(partyAnswers).where(and(eq(partyAnswers.questionId, questionIds[idx]), eq(partyAnswers.userId, userIds.get(handle)!))))[0];
  const toRight = await answerOf(CHANGE_TO_RIGHT.idx, "tunde");
  const qRight = await questionById(questionIds[CHANGE_TO_RIGHT.idx]);
  ok(JSON.stringify(toRight?.answer) === JSON.stringify(correctAnswer(qRight.format as QuestionFormat, qRight.payload)) && toRight.correctness === 100,
    "answer changed wrong → right before the clock: the final (right) one is graded");
  ok((toRight?.answeredMs ?? 0) >= CHANGE_TO_RIGHT.finalMs - 50 && toRight.points > 0,
    `…and its speed bonus is timed from the change (${toRight?.answeredMs}ms, not ~${CHANGE_TO_RIGHT.firstMs}ms; ${toRight?.points} pts)`);
  const toWrong = await answerOf(CHANGE_TO_WRONG.idx, "ada.o");
  const qWrong = await questionById(questionIds[CHANGE_TO_WRONG.idx]);
  ok(JSON.stringify(toWrong?.answer) === JSON.stringify(wrongAnswer(qWrong.format as QuestionFormat, qWrong.payload)) && toWrong.points === 0 && (toWrong.answeredMs ?? 0) >= CHANGE_TO_WRONG.finalMs - 50,
    `answer changed right → wrong before the clock: the final (wrong) one scores 0 (${toWrong?.points} pts at ${toWrong?.answeredMs}ms)`);

  const [{ reserves }] = await db.select({ reserves: count() }).from(partyQuestions).where(and(eq(partyQuestions.partyId, partyId), eq(partyQuestions.reserve, true)));
  ok(Number(reserves) >= 2, `reserve questions stored with the set (${reserves})`);

  // ---- question engine: gated set, records, bank -----------------------------------------

  const allQuestions = await db.select().from(partyQuestions).where(eq(partyQuestions.partyId, partyId));
  ok(allQuestions.length > 0 && allQuestions.every((q) => !isKnownBadQuestion(q.payload)), "no planted bad question reached party_questions");
  ok(seenQuestionTexts.length === 5 && seenQuestionTexts.every((t) => !isKnownBadQuestion({ question: t })), "no planted bad question was shown in the room");
  ok(allQuestions.every((q) => q.sourceRef), "every party question cites its bank source");
  const sourceRows = await db.select({ id: bankQuestions.id, chunk: bankQuestions.sourceChunkId }).from(bankQuestions).where(inArray(bankQuestions.id, allQuestions.map((q) => q.sourceRef!)));
  ok(sourceRows.length === new Set(allQuestions.map((q) => q.sourceRef)).size, "every sourceRef resolves to a bank question");
  ok(sourceRows.every((b) => b.chunk === null), "no question from someone else's uploaded file was served");

  const gens = await db.select().from(questionGenerations).where(eq(questionGenerations.partyId, partyId));
  const generatedIds = new Set(gens.filter((g) => g.bankQuestionId).map((g) => g.bankQuestionId!));
  const fromBank = played.filter((q) => !generatedIds.has(q.sourceRef!)).length;
  console.log(`  play order: ${fromBank} from the bank, ${played.length - fromBank} newly generated (${gens.length} drafts judged)`);
  if (gens.some((g) => g.outcome === "rejected_verify" || g.outcome === "accepted")) {
    const outcomes = gens.map((g) => g.outcome);
    ok(outcomes.filter((o) => o === "rejected_verify").length >= 3, "the planted bad questions were rejected by independent verification");
    ok(gens.some((g) => (g.verify as any)?.verdict === "needs_source"), "the unverifiable claim was marked needs_source");
    ok(gens.filter((g) => g.outcome === "accepted").every((g) => g.bankQuestionId), "every accepted generation landed in the bank");
    ok(gens.every((g) => g.spec && g.draft && g.outcome), "each record carries brief, spec, draft and gate outcome");
  }

  const [partyRow] = await db.select().from(parties).where(eq(parties.id, partyId));
  ok(!!partyRow?.specSummary, `spec summary stored on the party ("${partyRow?.specSummary}")`);

  // kemz's answer after the clock: rejected by the server, scores 0, stored as no answer.
  const kemzLate = await answerOf(LATE_IDX, "kemz");
  ok(!!kemzLate && kemzLate.answeredMs === null && kemzLate.points === 0 && kemzLate.answer === null, `late answer scored 0 with answered_ms NULL (got ms=${kemzLate?.answeredMs}, pts=${kemzLate?.points})`);
  ok((errorsSeen["kemz"] ?? []).some((e) => e === "not_open" || e === "too_late"), `late answer rejected by the server (${JSON.stringify(errorsSeen["kemz"] ?? [])})`);

  // ---- settlement: rake once, split via the ledger, party → finished ------------------------

  console.log("\nwaiting for the worker to settle…");
  const settled = await waitFor(async () => { const d = await api("tunde", "GET", `/parties/${partyId}`); return d.status === "finished" ? d : null; }, { tries: 40 });
  ok(!!settled, "party flipped to finished by the settle job");
  if (settled) {
    // pot 3 × ₦200 = 60_000k; rake 10% = 6_000k; host cut 0; split [100] → winner takes 54_000k
    const winner = settled.players.find((p: any) => p.id === userIds.get("tunde"));
    ok(winner?.prizeKobo === 54_000, `winner prizeKobo persisted (${winner?.prizeKobo} = pot − rake)`);
    const [rake] = await db.select().from(ledgerEntries).where(eq(ledgerEntries.idempotencyKey, `party_rake:${partyId}`));
    ok(rake?.amountKobo === 6_000, `rake taken once into the treasury (${rake?.amountKobo})`);
    const expectedDelta: Record<string, number> = { tunde: -20_000 + 54_000, "ada.o": -20_000, kemz: -20_000 };
    for (const h of HANDLES) {
      const net = await partyNetKobo(userIds.get(h)!, partyId);
      ok(net === expectedDelta[h], `${h} net from this party ${net} kobo (expected ${expectedDelta[h]})`);
    }
    const recorded = await waitFor(async () => (await db.select({ at: parties.playStatsRecordedAt }).from(parties).where(eq(parties.id, partyId)))[0]?.at, { tries: 40 });
    ok(!!recorded, "play stats recorded for the party (play_stats_recorded_at set)");
  }

  await Promise.race([Promise.allSettled(rooms.map((r) => r.leave())), new Promise((r) => setTimeout(r, 3000))]);
  const swaps = (await db.select().from(partyQuestionEvents).where(and(eq(partyQuestionEvents.partyId, partyId), eq(partyQuestionEvents.kind, "replace"))))
    .filter((e) => (e.detail as any)?.reason === "seen_by_roster");
  return { texts: seenQuestionTexts, bankIds: played.map((q) => q.sourceRef!), swaps: swaps.length, msToFirstQuestion: firstQuestionAt - promotedAt, lobbyStatuses };
}

// ---- 3. two parties sealed up front; party 2's late joiners have seen party 1 --------------------

console.log("\n==== two parties, same brief, both sealed at creation with only the host seated ====");
const seenBeforeFirst = await seenByPlayers();
const p1 = await createSealedParty("Sim party 1");
await waitForSet(p1.id, "party 1");
const p2 = await createSealedParty("Sim party 2");
await waitForSet(p2.id, "party 2");
await assertNoContentLeak(p2.id, "party 2");
const p1Order = new Set(await playOrderBankIds(p1.id));
const p2OrderBefore = await playOrderBankIds(p2.id);
const sharedAtCreation = p2OrderBefore.filter((id) => p1Order.has(id)).length;
console.log(`  party 2 was sealed with ${sharedAtCreation} of party 1's ${p1Order.size} questions (nobody had played them yet)`);
ok(sharedAtCreation > 0, "precondition: party 2's set shares questions with party 1's (so the late-joiner swap is exercised)");

for (const h of ["ada.o", "kemz"]) await api(h, "POST", `/parties/${p1.id}/join`);
const first = await playParty(1, p1.id, p1);
ok(first.bankIds.every((id) => !seenBeforeFirst.has(id)), `party 1 served nothing these players had seen in earlier runs (${seenBeforeFirst.size} excluded)`);
if (first.swaps === 0) ok(first.msToFirstQuestion < 2_000, `with nothing to swap, the round started instantly (${first.msToFirstQuestion}ms from start to the first question)`);

// ada.o and kemz join party 2 now: they (and tunde) have just played party 1, which party 2 was sealed with.
const seenBeforeSecond = await seenByPlayers();
for (const h of ["ada.o", "kemz"]) await api(h, "POST", `/parties/${p2.id}/join`);
const second = await playParty(2, p2.id, p2);

console.log("\n==== across both parties ====");
ok(second.swaps >= sharedAtCreation, `at start, party 2 swapped the questions its players had since seen (${second.swaps} swap(s) for ${sharedAtCreation} shared)`);
const swapEvents = (await db.select().from(partyQuestionEvents).where(and(eq(partyQuestionEvents.partyId, p2.id), eq(partyQuestionEvents.kind, "replace"))))
  .map((e) => e.detail as { reason: string; source: string });
console.log(`  swap sources: ${JSON.stringify(swapEvents.map((d) => d.source))}`);
ok(swapEvents.every((d) => d.reason === "seen_by_roster"), "every swap is logged with its reason");
const beforeStart = second.lobbyStatuses.slice(0, second.lobbyStatuses.indexOf("first question"));
ok(beforeStart.includes("generating") && beforeStart.at(-1) === "ready", `the lobby saw the set being swapped, then ready, before the first question (${JSON.stringify(second.lobbyStatuses)})`);
const reserveFirst = swapEvents.findIndex((d) => d.source !== "reserve" && d.source !== "dropped_reserve");
ok(reserveFirst === -1 || swapEvents.slice(reserveFirst).every((d) => d.source !== "reserve"), "swaps use reserves before the bank or a top-up");
const untouched = p2OrderBefore.filter((id) => !p1Order.has(id));
ok(untouched.every((id) => second.bankIds.includes(id)), `questions nobody had seen were left alone (${untouched.length} kept)`);
ok(second.bankIds.every((id) => !seenBeforeSecond.has(id)), `party 2 played no question any of its players had already seen (${seenBeforeSecond.size} excluded)`);
const repeatedTexts = second.texts.filter((t) => first.texts.includes(t));
ok(repeatedTexts.length === 0, `no question repeats between the two parties${repeatedTexts.length ? `: ${JSON.stringify(repeatedTexts)}` : ""}`);

const failures = failureCount();
console.log(failures ? `\n${failures} assertion(s) FAILED` : "\nparty-sim: all assertions passed");
process.exit(failures ? 1 : 0);

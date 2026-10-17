/**
 * Sealed-mode sim: the same three players play the same brief twice in a row against the live
 * question bank (never wiped). Each party asserts scores, ranks, prev_rank, chat gating, that
 * correct answers never leave the server early, that no planted bad question reaches the room,
 * the generation record whenever the engine had to generate, and settlement. Across the two
 * parties it asserts that no question repeats for these players.
 *
 * The engine is bank-first: on a fresh database the first party is generated from scratch; on a
 * long-lived one, sets come partly or wholly from the bank, minus everything these players have
 * already seen, and generation fills the gap.
 *
 * TEST-ONLY. This script reads correct answers straight from Postgres to drive its personas;
 * nothing like it exists in the product, and it is never used to fake presence.
 *
 * Run with the stack up (npm run infra:up && npm run dev):  npm run sim:sealed
 */
import { Client, type Room } from "colyseus.js";
import { and, count, eq, inArray, isNotNull } from "drizzle-orm";
import { db, parties, partyQuestions, partyAnswers, ledgerEntries, bankQuestions, questionGenerations } from "@contestly/db";
import { partyQueue } from "@contestly/queue";
import { MSG, PARTY_ROOM } from "@contestly/shared";
import { isOptionFormat, type QuestionFormat } from "@contestly/game";
import { isKnownBadQuestion } from "../apps/questions/src/providers/mock/deck.js";
import { RT, api, correctAnswer, failureCount, leaks, ok, partyNetKobo, waitFor, wrongAnswer } from "./sim-lib.js";

const HANDLES = ["tunde", "ada.o", "kemz"];
const BRIEF = "Nigerian general knowledge — cities, food, music, football";
/** The question on which kemz answers only after the clock: must score 0 and store answered_ms NULL. */
const LATE_IDX = 3;

type Persona = { handle: string; play: (format: QuestionFormat, payload: any) => unknown; delayMs: (idx: number, questionMs: number) => number };
const personas: Persona[] = [
  // tunde dawdles on Q0 so ada.o takes the early lead; from Q1 he's fast and overtakes — a rank flip we assert.
  { handle: "tunde", play: correctAnswer, delayMs: (idx, ms) => (idx === 0 ? Math.floor(ms * 0.8) : 400) },
  { handle: "ada.o", play: correctAnswer, delayMs: (idx, ms) => (idx === 0 ? 400 : Math.floor(ms * 0.6)) },
  // kemz is fast and wrong — and on LATE_IDX only answers after the question closed.
  { handle: "kemz", play: wrongAnswer, delayMs: (idx, ms) => (idx === LATE_IDX ? ms + 600 : 300) },
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

interface Played {
  partyId: string;
  texts: string[];
  bankIds: string[];
}

async function playParty(round: number): Promise<Played> {
  console.log(`\n==== party ${round}: same brief, same players ====`);
  console.log("creating party as tunde, joining ada.o and kemz…");
  const party = await api("tunde", "POST", "/parties", {
    title: `Sim party ${round}`, brief: BRIEF, entryKobo: 20_000, maxPlayers: 5, funding: "pooled",
    startsInMinutes: 1, questionCount: 5, secondsPerQuestion: 5,
  });
  const partyId: string = party.id;
  ok(Array.isArray(party.split) && party.split.reduce((a: number, b: number) => a + b, 0) === 100, "split defaulted from party config");
  ok(typeof party.category === "string" && party.category.length > 0, `category inferred from the brief (${party.category})`);
  await api("ada.o", "POST", `/parties/${partyId}/join`);
  await api("kemz", "POST", `/parties/${partyId}/join`);

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
  const errorsSeen: Record<string, string[]> = {};
  let resolveFinal!: (rows: any[]) => void;
  const finalRows = new Promise<any[]>((r) => (resolveFinal = r));

  // The sim (not the clients) knows the questions, read from Postgres once the engine seals them.
  const questionById = async (id: string) => (await db.select().from(partyQuestions).where(eq(partyQuestions.id, id)))[0];
  const questionByIdx = async (idx: number) => (await db.select().from(partyQuestions).where(and(eq(partyQuestions.partyId, partyId), eq(partyQuestions.idx, idx))))[0];

  const rooms: Room[] = [];
  for (const persona of personas) {
    const room = await new Client(RT).joinOrCreate(PARTY_ROOM, { partyId, devUser: persona.handle });
    rooms.push(room);
    const isHost = persona.handle === "tunde";

    room.onMessage(MSG.question, async (view: any) => {
      if (isHost && typeof view?.view?.question === "string") seenQuestionTexts.push(view.view.question);
      const leaked = leaks(view);
      if (leaked.length) {
        questionLeaks++;
        console.log(`✗ LEAK in question message to ${persona.handle}: ${leaked.join(", ")}`);
      }
      const q = await questionById(view.questionId);
      const answer = persona.play(q.format as QuestionFormat, q.payload);
      setTimeout(() => {
        room.send(MSG.answer, answer);
        room.send(MSG.lock);
      }, persona.delayMs(view.idx, view.seconds * 1000));
      // chat must be rejected while a question is up (checked once, from ada)
      if (persona.handle === "ada.o" && view.idx === 1) room.send(MSG.chat, { text: "mid-question chat, should bounce" });
    });

    room.onMessage(MSG.error, (e: any) => {
      if (e?.error === "chat_closed") chatDuringQuestionRejected = true;
      (errorsSeen[persona.handle] ??= []).push(e?.error);
    });

    if (isHost) {
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
      for (const t of [MSG.reveal, MSG.standings, MSG.chatMessage, MSG.finalStandings]) room.onMessage(t, () => {});
    }
    room.onMessage(MSG.phase, () => {});
    room.onMessage(MSG.presence, () => {});
  }
  // Players are in the lobby BEFORE the party starts, so the worker's party:events "live"
  // publish — the real product path — is what starts the round in the room.
  // Don't wait the full minute: promote the delayed start job (same code path the worker runs).
  const startJob = await partyQueue().getJob(`start-${partyId}`);
  if (!startJob) throw new Error("start job not found — is the API running?");
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
  const played = (await db.select().from(partyQuestions).where(and(eq(partyQuestions.partyId, partyId), eq(partyQuestions.reserve, false))));
  const optionQuestions = played.filter((q) => isOptionFormat(q.format as QuestionFormat)).length;

  ok(final.length === 3, "3 players in the final table");
  ok(byHandle("tunde").rank === 1, "tunde (fast + right) finishes 1st");
  ok(byHandle("ada.o").rank === 2, "ada.o (slow + right) finishes 2nd");
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

  const [{ reserves }] = await db.select({ reserves: count() }).from(partyQuestions).where(and(eq(partyQuestions.partyId, partyId), eq(partyQuestions.reserve, true)));
  ok(Number(reserves) >= 2, `reserve questions stored with the set (${reserves})`);

  // ---- question engine: gated set, records, bank -----------------------------------------

  const allQuestions = await db.select().from(partyQuestions).where(eq(partyQuestions.partyId, partyId));
  ok(allQuestions.length > 0 && allQuestions.every((q) => !isKnownBadQuestion(q.payload)), "no planted bad question reached party_questions");
  ok(seenQuestionTexts.length === 5 && seenQuestionTexts.every((t) => !isKnownBadQuestion({ question: t })), "no planted bad question was shown in the room");
  ok(allQuestions.every((q) => q.sourceRef), "every party question cites its bank source");
  const sourceRows = await db.select({ id: bankQuestions.id, chunk: bankQuestions.sourceChunkId }).from(bankQuestions).where(inArray(bankQuestions.id, allQuestions.map((q) => q.sourceRef!)));
  ok(sourceRows.length === allQuestions.length, "every sourceRef resolves to a bank question");
  ok(sourceRows.every((b) => b.chunk === null), "no question from someone else's uploaded file was served");

  const gens = await db.select().from(questionGenerations).where(eq(questionGenerations.partyId, partyId));
  const generatedIds = new Set(gens.filter((g) => g.bankQuestionId).map((g) => g.bankQuestionId!));
  const fromBank = allQuestions.filter((q) => !generatedIds.has(q.sourceRef!)).length;
  console.log(`  set: ${fromBank} from the bank, ${allQuestions.length - fromBank} newly generated (${gens.length} drafts judged)`);
  if (gens.length) {
    const outcomes = gens.map((g) => g.outcome);
    ok(outcomes.filter((o) => o === "rejected_verify").length === 3, "all three planted bad questions rejected by independent verification");
    ok(gens.some((g) => (g.verify as any)?.verdict === "needs_source"), "the unverifiable claim was marked needs_source");
    ok(outcomes.filter((o) => o === "rejected_dedupe").length >= 1, "a near-duplicate was rejected by semantic dedupe");
    ok(gens.filter((g) => g.outcome === "accepted").every((g) => g.bankQuestionId), "every accepted generation landed in the bank");
    ok(gens.every((g) => g.spec && g.draft && g.outcome), "each record carries brief, spec, draft and gate outcome");
  }

  const [partyRow] = await db.select().from(parties).where(eq(parties.id, partyId));
  ok(!!partyRow?.specSummary, `spec summary stored on the party ("${partyRow?.specSummary}")`);

  // What each player submitted is stored for "Your pick", disputes and learn-from-play.
  const q0 = await questionByIdx(0);
  const [tundeQ0] = await db.select().from(partyAnswers).where(and(eq(partyAnswers.questionId, q0.id), eq(partyAnswers.userId, userIds.get("tunde")!)));
  ok(JSON.stringify(tundeQ0?.answer) === JSON.stringify(correctAnswer(q0.format as QuestionFormat, q0.payload)), "submitted answer stored verbatim in party_answers");

  // kemz's answer after the clock: rejected by the server, scores 0, stored as no answer.
  const qLate = await questionByIdx(LATE_IDX);
  const [kemzLate] = await db.select().from(partyAnswers).where(and(eq(partyAnswers.questionId, qLate.id), eq(partyAnswers.userId, userIds.get("kemz")!)));
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

    // record_play: the worker's settle enqueued it; played questions' stats land in the bank.
    const recorded = await waitFor(async () => (await db.select({ at: parties.playStatsRecordedAt }).from(parties).where(eq(parties.id, partyId)))[0]?.at, { tries: 40 });
    ok(!!recorded, "play stats recorded for the party (play_stats_recorded_at set)");
    if (recorded) {
      const [bq] = await db.select().from(bankQuestions).where(eq(bankQuestions.id, q0.sourceRef!));
      ok((bq?.timesPlayed ?? 0) >= 1 && (bq?.timesAnswered ?? 0) >= 3, `bank stats updated from play (played=${bq?.timesPlayed}, answered=${bq?.timesAnswered})`);
    }
  }

  // leave() can hang on an already-disposed room; it's best-effort cleanup, never worth blocking the verdict.
  await Promise.race([Promise.allSettled(rooms.map((r) => r.leave())), new Promise((r) => setTimeout(r, 3000))]);
  return { partyId, texts: seenQuestionTexts, bankIds: played.map((q) => q.sourceRef!) };
}

// ---- two parties, same brief, same players: nothing repeats ----------------------------------

const seenBeforeFirst = await seenByPlayers();
const first = await playParty(1);
ok(first.bankIds.every((id) => !seenBeforeFirst.has(id)), `party 1 served nothing these players had seen in earlier runs (${seenBeforeFirst.size} excluded)`);

const seenBeforeSecond = await seenByPlayers();
const second = await playParty(2);

console.log("\n==== across both parties ====");
ok(second.bankIds.every((id) => !seenBeforeSecond.has(id)), `party 2 served no bank question these players had already seen (${seenBeforeSecond.size} excluded)`);
const repeatedTexts = second.texts.filter((t) => first.texts.includes(t));
ok(repeatedTexts.length === 0, `no question repeats between the two parties${repeatedTexts.length ? `: ${JSON.stringify(repeatedTexts)}` : ""}`);
ok(new Set(second.bankIds).size === 5 && second.bankIds.every((id) => !first.bankIds.includes(id)), "party 2's five questions are all different bank questions from party 1's");

const failures = failureCount();
console.log(failures ? `\n${failures} assertion(s) FAILED` : "\nparty-sim: all assertions passed");
process.exit(failures ? 1 : 0);

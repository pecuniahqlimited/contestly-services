/**
 * Test client: connects 3 simulated players to a fresh party and plays it to the end, asserting
 * scores, ranks, prev_rank, chat gating and that correct answers never leave the server early.
 *
 * TEST-ONLY. This script reads correct answers straight from Postgres to drive its personas;
 * nothing like it exists in the product, and it is never used to fake presence.
 *
 * Run with the stack up (npm run infra:up && npm run dev):  npm run sim
 */
import { Client, type Room } from "colyseus.js";
import { and, count, eq } from "drizzle-orm";
import { db, partyQuestions, partyAnswers, ledgerEntries } from "@contestly/db";
import { partyQueue } from "@contestly/queue";
import { MSG, PARTY_ROOM } from "@contestly/shared";
import type { QuestionFormat, Payload } from "@contestly/game";

const API = process.env.API_URL ?? "http://localhost:4000";
const RT = process.env.RT_URL ?? "ws://localhost:4001";

let failures = 0;
const ok = (cond: boolean, label: string) => {
  console.log(`${cond ? "✓" : "✗ FAIL"} ${label}`);
  if (!cond) failures++;
};

async function api<T = any>(handle: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "x-dev-user": handle, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 402) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json)}`);
  return json as T;
}

/** The right answer for each format, straight from the server payload (test-only). */
function correctAnswer(format: QuestionFormat, payload: any): unknown {
  switch (format) {
    case "pick_one":
    case "picture": return { index: payload.correctIndex };
    case "pick_all": return { indexes: payload.correctIndexes };
    case "order": return { order: payload.correctOrder };
    case "match": return { pairs: payload.pairs };
  }
}
/** A deliberately wrong answer. */
function wrongAnswer(format: QuestionFormat, payload: any): unknown {
  switch (format) {
    case "pick_one":
    case "picture": return { index: (payload.correctIndex + 1) % payload.options.length };
    case "pick_all": return { indexes: [payload.correctIndexes[0] === 0 ? 1 : 0].filter((i) => !payload.correctIndexes.includes(i)) };
    case "order": return { order: [...payload.correctOrder].reverse() };
    case "match": return { pairs: payload.pairs.map((p: number) => (p + 1) % payload.right.length) };
  }
}

/** Deep-scan a payload for anything that looks like a leaked correct answer. */
function leaks(view: unknown): string[] {
  const banned = ["correctIndex", "correctIndexes", "correctOrder", "pairs"];
  const found: string[] = [];
  const walk = (o: unknown) => {
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (banned.includes(k)) found.push(k);
      walk(v);
    }
  };
  walk(view);
  return found;
}

// ---- set the party up over the API -------------------------------------------------

console.log("creating party as tunde, joining ada.o and kemz…");
for (const h of ["tunde", "ada.o", "kemz"]) await api(h, "POST", "/wallet/dev-topup", { nairaAmount: 1000 }).catch(() => ({}));
const total = (w: { cashKobo: number; bonusKobo: number }) => w.cashKobo + w.bonusKobo;
const walletsBefore = new Map<string, number>();
for (const h of ["tunde", "ada.o", "kemz"]) walletsBefore.set(h, total((await api(h, "GET", "/me")).wallet));
const party = await api("tunde", "POST", "/parties", {
  title: "Sim party",
  category: "General knowledge",
  entryKobo: 20_000,
  maxPlayers: 5,
  funding: "pooled",
  startsInMinutes: 1,
  questionCount: 5,
  secondsPerQuestion: 5,
});
const partyId: string = party.id;
console.log(`party ${partyId} created (split defaulted to ${JSON.stringify(party.split)})`);
ok(Array.isArray(party.split) && party.split.reduce((a: number, b: number) => a + b, 0) === 100, "split defaulted from party config");
await api("ada.o", "POST", `/parties/${partyId}/join`);
await api("kemz", "POST", `/parties/${partyId}/join`);

// ---- connect the three players ------------------------------------------------------

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

const userIds = new Map<string, string>();
for (const p of personas) userIds.set(p.handle, (await api(p.handle, "GET", "/me")).id);

let questionLeaks = 0;
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

// The sim (not the clients) knows the questions, read from Postgres once the room persists them.
async function questionByIdx(idx: number) {
  for (let i = 0; i < 100; i++) {
    const rows = await db.select().from(partyQuestions).where(and(eq(partyQuestions.partyId, partyId), eq(partyQuestions.idx, idx)));
    if (rows.length) return rows[0];
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`question idx ${idx} never appeared in party_questions`);
}

const rooms: Room[] = [];
for (const persona of personas) {
  const room = await new Client(RT).joinOrCreate(PARTY_ROOM, { partyId, devUser: persona.handle });
  rooms.push(room);
  const isHost = persona.handle === "tunde";

  room.onMessage(MSG.question, async (view: any) => {
    const leaked = leaks(view);
    if (leaked.length) {
      questionLeaks++;
      console.log(`✗ LEAK in question message to ${persona.handle}: ${leaked.join(", ")}`);
    }
    const q = await questionByIdx(view.idx);
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
    room.onMessage(MSG.reveal, () => {});
    room.onMessage(MSG.standings, () => {});
    room.onMessage(MSG.chatMessage, () => {});
    room.onMessage(MSG.finalStandings, () => {});
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

// ---- assertions ---------------------------------------------------------------------

console.log("\nfinal standings:");
for (const r of final) {
  const handle = [...userIds.entries()].find(([, id]) => id === r.userId)?.[0] ?? r.userId;
  console.log(`  #${r.rank} ${handle.padEnd(8)} score=${String(r.score).padStart(4)} time=${(r.timeMs / 1000).toFixed(1)}s prev_rank=${r.prevRank}`);
}

const byHandle = (h: string) => final.find((r) => r.userId === userIds.get(h))!;
ok(final.length === 3, "3 players in the final table");
ok(byHandle("tunde").rank === 1, "tunde (fast + right) finishes 1st");
ok(byHandle("ada.o").rank === 2, "ada.o (slow + right) finishes 2nd");
ok(byHandle("kemz").rank === 3, "kemz (fast + wrong) finishes 3rd");
ok(byHandle("tunde").score > byHandle("ada.o").score, "speed bonus separates the two correct players");
ok(byHandle("kemz").score === 0, "wrong answers score 0");
ok(questionLeaks === 0, "no correct answer ever appeared in a question message");
ok(revealsSeen === 5, `reveal after every question (saw ${revealsSeen})`);
ok(distributionsSeen >= 3, `distributions on option formats (saw ${distributionsSeen})`);
ok(firstStandingsPrevRanks.every((p) => p === null), "first standings carry prev_rank=null");
ok(laterStandingsWithPrevRank >= 4, `later standings carry prev_rank (saw ${laterStandingsWithPrevRank})`);
ok(rankFlipSeen, "a mid-game rank flip showed prev_rank ≠ rank in a standings");
ok(chatDuringQuestionRejected, "chat rejected while a question is open");
ok(chatDuringStandingsSeen, "chat delivered during standings");

// Persisted results must match what the room broadcast.
const detail = await api("tunde", "GET", `/parties/${partyId}`);
for (const h of ["tunde", "ada.o", "kemz"]) {
  const persisted = detail.players.find((p: any) => p.id === userIds.get(h));
  const live = byHandle(h);
  ok(persisted?.score === live.score && persisted?.rank === live.rank, `persisted score/rank for ${h} match the room (${persisted?.score}/${persisted?.rank})`);
}

const [{ reserves }] = await db.select({ reserves: count() }).from(partyQuestions).where(and(eq(partyQuestions.partyId, partyId), eq(partyQuestions.reserve, true)));
ok(Number(reserves) >= 2, `reserve questions stored with the set (${reserves})`);

// What each player submitted is stored for "Your pick", disputes and learn-from-play.
const q0 = await questionByIdx(0);
const [tundeQ0] = await db.select().from(partyAnswers).where(and(eq(partyAnswers.questionId, q0.id), eq(partyAnswers.userId, userIds.get("tunde")!)));
ok(JSON.stringify(tundeQ0?.answer) === JSON.stringify(correctAnswer(q0.format as QuestionFormat, q0.payload)), "submitted answer stored verbatim in party_answers");

// kemz's answer after the clock: rejected by the server, scores 0, stored as no answer.
const qLate = await questionByIdx(LATE_IDX);
const [kemzLate] = await db.select().from(partyAnswers).where(and(eq(partyAnswers.questionId, qLate.id), eq(partyAnswers.userId, userIds.get("kemz")!)));
ok(!!kemzLate && kemzLate.answeredMs === null && kemzLate.points === 0 && kemzLate.answer === null, `late answer scored 0 with answered_ms NULL (got ms=${kemzLate?.answeredMs}, pts=${kemzLate?.points})`);
ok((errorsSeen["kemz"] ?? []).some((e) => e === "not_open" || e === "too_late"), `late answer rejected by the server (${JSON.stringify(errorsSeen["kemz"] ?? [])})`);

// ---- settlement (1b): rake once, split via the ledger, party → finished -------------

console.log("\nwaiting for the worker to settle…");
let settled: any = null;
for (let i = 0; i < 40 && !settled; i++) {
  const d = await api("tunde", "GET", `/parties/${partyId}`);
  if (d.status === "finished") settled = d;
  else await new Promise((r) => setTimeout(r, 500));
}
ok(!!settled, "party flipped to finished by the settle job");

if (settled) {
  // pot 3 × ₦200 = 60_000k; rake 10% = 6_000k; host cut 0; split [100] → winner takes 54_000k
  const winner = settled.players.find((p: any) => p.id === userIds.get("tunde"));
  ok(winner?.prizeKobo === 54_000, `winner prizeKobo persisted (${winner?.prizeKobo} = pot − rake)`);
  const [rake] = await db.select().from(ledgerEntries).where(eq(ledgerEntries.idempotencyKey, `party_rake:${partyId}`));
  ok(rake?.amountKobo === 6_000, `rake taken once into the treasury (${rake?.amountKobo})`);

  const expectedDelta: Record<string, number> = { tunde: -20_000 + 54_000, "ada.o": -20_000, kemz: -20_000 };
  for (const h of ["tunde", "ada.o", "kemz"]) {
    const after = total((await api(h, "GET", "/me")).wallet);
    const delta = after - walletsBefore.get(h)!;
    ok(delta === expectedDelta[h], `${h} wallet delta ${delta} kobo (expected ${expectedDelta[h]})`);
  }
}

// leave() can hang on an already-disposed room; it's best-effort cleanup, never worth blocking the verdict.
await Promise.race([Promise.allSettled(rooms.map((r) => r.leave())), new Promise((r) => setTimeout(r, 3000))]);
console.log(failures ? `\n${failures} assertion(s) FAILED` : "\nparty-sim: all assertions passed");
process.exit(failures ? 1 : 0);

/**
 * LOAD TEST, DEV STACKS ONLY: many free parties full of players, driven end to end through the public API and
 * the realtime rooms, the way the app does it. Nothing here touches the database directly, so it runs from any
 * machine that can reach the stack (docs/engineering/load-testing.md); several shards split the parties between them.
 *
 *   npm run load:party -- --parties 10 --players 100              1,000 players from this machine
 *   npm run load:party -- --parties 100 --players 100 --shards 5 --shard 0 --starts-at <iso> --run ab12
 *
 * Each party is free (entry 0, no prize), sealed, pick-one only, hosted by one of its players. Every player joins
 * through POST /parties/:id/join, connects to the party room, answers each question at a random moment (some
 * change their mind once), and sometimes chats on the standings screen. Writes a JSON report (raw samples, so
 * shards merge exactly: scripts/load-report.mjs) and prints the shard's summary.
 *
 * Needs AUTH_MODE=dev on the stack (players are x-dev-user accounts, marked as sim data). Use AI_PROFILE=mock
 * there too: a real provider can't make a hundred sets at once.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Client, type Room } from "colyseus.js";
import { MSG, PARTY_ROOM } from "@contestly/shared";
import { formatSummary, summarise } from "./load-report.mjs";

// ---- settings -------------------------------------------------------------------------------------------------
const args = process.argv.slice(2);
const opt = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : (process.env[`LOAD_${name.toUpperCase().replace(/-/g, "_")}`] ?? fallback);
};
const num = (name: string, fallback: number) => {
  const v = Number(opt(name, String(fallback)));
  if (!Number.isFinite(v) || v < 0) throw new Error(`--${name} must be a number`);
  return v;
};

const API = (opt("api", process.env.API_URL ?? "http://localhost:4000") as string).replace(/\/$/, "");
const RT = (opt("rt", process.env.RT_URL ?? "ws://localhost:4001") as string).replace(/\/$/, "");
const PARTIES = num("parties", 10);
const PLAYERS = num("players", 100);
const SHARDS = Math.max(1, num("shards", 1));
const SHARD = num("shard", 0);
const QUESTIONS = num("questions", 5);
const SECONDS = num("seconds", 10);
/** Requests in flight at once while seating players and connecting them: how fast a crowd arrives. */
const JOIN_CONCURRENCY = Math.max(1, num("join-concurrency", 25));
const CONNECT_CONCURRENCY = Math.max(1, num("connect-concurrency", 50));
/** Share of players who chat on a standings screen, and who change their answer once before the clock ends. */
const CHAT_CHANCE = num("chat-chance", 0.1);
const CHANGE_CHANCE = num("change-chance", 0.3);
const RUN = (opt("run") ?? Date.now().toString(36).slice(-4)).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6);
const STARTS_AT = new Date(opt("starts-at") ?? new Date(Date.now() + num("starts-in", 6) * 60_000).toISOString());
const OUT = opt("out", `load-report-${RUN}-${SHARD}.json`) as string;

/** Per question: its clock, then the reveal and standings beats (about 6 s and 7 s), with room to spare. */
const BEATS_SECONDS = 20;
const END_SLACK_MS = 120_000;
const POLL_MS = 2_000;
const DEV_SIM_HEADER = "x-dev-sim";

if (PLAYERS < 2) throw new Error("--players must be at least 2");
if (SHARD >= SHARDS) throw new Error("--shard must be below --shards");

/** Party i belongs to shard i % SHARDS; handles are global, so shards never collide. Max 20 chars: lt<run>.<p>.<n>. */
const myParties = Array.from({ length: PARTIES }, (_, i) => i).filter((i) => i % SHARDS === SHARD);
const handleOf = (party: number, player: number) => `lt${RUN}.${party}.${player}`;

// ---- measurements ---------------------------------------------------------------------------------------------
const samples = {
  createMs: [] as number[],
  generateMs: [] as number[],
  joinMs: [] as number[],
  connectMs: [] as number[],
  /** Arrival minus the server's openedAt: network plus how long the room took to send it to everyone. */
  questionLagMs: [] as number[],
  /** Per question and party, last arrival minus first among this shard's players: the room's fan-out time. */
  fanoutSpreadMs: [] as number[],
  /** Reveal arrival minus the question's closesAt. */
  revealLagMs: [] as number[],
  chatAckMs: [] as number[],
};
const counts: Record<string, number> = {
  players: 0, partiesCreated: 0, partiesReady: 0, joined: 0, connected: 0, answersSent: 0,
  partiesSplit: 0, questionsReceived: 0, revealsReceived: 0, standingsReceived: 0, finalsReceived: 0, chatsSent: 0, chatsAcked: 0, unexpectedDisconnects: 0,
};
const errors: Record<string, number> = {};
const bump = (key: string, by = 1) => void (counts[key] = (counts[key] ?? 0) + by);
const fail = (where: string, what: string) => void (errors[`${where}: ${what}`] = (errors[`${where}: ${what}`] ?? 0) + 1);
const timeline: { at: string; what: string }[] = [];
const mark = (what: string) => {
  timeline.push({ at: new Date().toISOString(), what });
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${what}`);
};

// ---- helpers --------------------------------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(handle: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "x-dev-user": handle, [DEV_SIM_HEADER]: "1", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** Runs `fn` over `items`, `limit` at a time. */
async function eachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

async function timed<T>(into: number[], fn: () => Promise<T>): Promise<T> {
  const t = performance.now();
  const out = await fn();
  into.push(Math.round(performance.now() - t));
  return out;
}

// ---- the run --------------------------------------------------------------------------------------------------
type Party = { index: number; id: string; host: string };
type Player = { handle: string; party: Party; room?: Room; leaving?: boolean };

async function preflight() {
  const res = await call(`lt${RUN}.check`, "GET", "/me").catch((e) => ({ status: 0, body: { error: (e as Error).message } }));
  if (res.status !== 200) {
    console.error(`The stack at ${API} didn't accept a dev user (${res.status} ${JSON.stringify(res.body)}). It needs AUTH_MODE=dev for a load test.`);
    process.exit(2);
  }
  if (STARTS_AT.getTime() - Date.now() < 90_000) {
    console.error(`--starts-at is less than 90 s away (${STARTS_AT.toISOString()}): no time to seat everyone. Give it a few minutes.`);
    process.exit(2);
  }
}

async function createParties(): Promise<Party[]> {
  const made: Party[] = [];
  await eachLimit(myParties, 10, async (index) => {
    const host = handleOf(index, 0);
    const res = await timed(samples.createMs, () => call(host, "POST", "/parties", {
      title: `Load test ${RUN} #${index}`,
      brief: "Nigerian general knowledge: cities, food, music and football",
      difficulty: "mixed",
      formats: ["pick_one"],
      entryKobo: 0,
      funding: "pooled",
      maxPlayers: PLAYERS,
      split: "winner",
      questionCount: QUESTIONS,
      secondsPerQuestion: SECONDS,
      visibility: "private",
      startsAt: STARTS_AT.toISOString(),
    })).catch((e) => ({ status: 0, body: { error: (e as Error).message } }));
    if (res.status !== 201) return fail("create", `${res.status} ${res.body?.error ?? ""}`.trim());
    made.push({ index, id: res.body.id, host });
    bump("partiesCreated");
  });
  return made.sort((a, b) => a.index - b.index);
}

/** Polls each party until its sealed set is ready (or failed), to time generation; gives up 30 s before the start. */
async function waitForQuestions(list: Party[]) {
  const created = Date.now();
  const pending = new Set(list.map((p) => p.id));
  while (pending.size && Date.now() < STARTS_AT.getTime() - 30_000) {
    await eachLimit([...pending], 10, async (id) => {
      const p = list.find((x) => x.id === id)!;
      const res = await call(p.host, "GET", `/parties/${id}`).catch(() => null);
      const status = res?.body?.questions?.status;
      if (status === "ready") {
        samples.generateMs.push(Date.now() - created);
        bump("partiesReady");
        pending.delete(id);
      } else if (status === "failed") {
        fail("questions", res?.body?.questions?.error ?? "failed");
        pending.delete(id);
      }
    });
    if (pending.size) await sleep(POLL_MS);
  }
  if (pending.size) fail("questions", `not ready 30 s before the start (${pending.size} parties)`);
}

async function seatPlayers(players: Player[]) {
  await eachLimit(players.filter((p) => p.handle !== p.party.host), JOIN_CONCURRENCY, async (pl) => {
    const res = await timed(samples.joinMs, () => call(pl.handle, "POST", `/parties/${pl.party.id}/join`))
      .catch((e) => ({ status: 0, body: { error: (e as Error).message } }));
    if (res.status === 201 || res.status === 200) bump("joined");
    else fail("join", `${res.status} ${res.body?.error ?? ""}`.trim());
  });
}

/** First and last arrival of each question per party, for the fan-out spread. */
const arrivals = new Map<string, { first: number; last: number }>();
const pendingChats = new Map<string, number>();
/** One party must be one room; more than one means its players were split and play separate games. */
const roomsByParty = new Map<string, Set<string>>();
let finished = 0;
let resolveAllDone!: () => void;
const allDone = new Promise<void>((r) => (resolveAllDone = r));
let expectedFinals = 0;

function play(pl: Player, room: Room) {
  /** The open question's close time, for the reveal's lag. */
  let closesAt = 0;
  room.onMessage(MSG.question, (q: { questionId: string; openedAt: number; closesAt: number; seconds: number; view: { options: string[] } }) => {
    const now = Date.now();
    closesAt = q.closesAt;
    bump("questionsReceived");
    samples.questionLagMs.push(now - q.openedAt);
    const key = `${pl.party.id}:${q.questionId}`;
    const seen = arrivals.get(key);
    arrivals.set(key, seen ? { first: Math.min(seen.first, now), last: Math.max(seen.last, now) } : { first: now, last: now });
    const options = q.view?.options?.length ?? 4;
    const pick = () => ({ index: Math.floor(Math.random() * options) });
    const windowMs = Math.max(0, q.closesAt - now - 500);
    const first = windowMs * (0.15 + Math.random() * 0.6);
    setTimeout(() => { room.send(MSG.answer, pick()); bump("answersSent"); }, first);
    if (Math.random() < CHANGE_CHANCE) {
      setTimeout(() => { room.send(MSG.answer, pick()); bump("answersSent"); }, first + (windowMs - first) * Math.random());
    }
  });
  room.onMessage(MSG.reveal, () => {
    bump("revealsReceived");
    if (closesAt) samples.revealLagMs.push(Date.now() - closesAt);
  });
  room.onMessage(MSG.standings, () => {
    bump("standingsReceived");
    if (Math.random() >= CHAT_CHANCE) return;
    const clientMsgId = randomUUID();
    setTimeout(() => {
      pendingChats.set(clientMsgId, Date.now());
      room.send(MSG.chat, { clientMsgId, text: "gg 🔥" });
      bump("chatsSent");
    }, 500 + Math.random() * 2500);
  });
  room.onMessage(MSG.chatAck, (a: { clientMsgId?: string }) => {
    const sent = a?.clientMsgId ? pendingChats.get(a.clientMsgId) : undefined;
    if (sent === undefined) return;
    pendingChats.delete(a.clientMsgId!);
    samples.chatAckMs.push(Date.now() - sent);
    bump("chatsAcked");
  });
  room.onMessage(MSG.finalStandings, () => {
    bump("finalsReceived");
    if (++finished >= expectedFinals) resolveAllDone();
  });
  room.onMessage(MSG.phase, (p: { phase: string }) => {
    if (p.phase !== "cancelled") return;
    fail("party", "cancelled");
    if (++finished >= expectedFinals) resolveAllDone();
  });
  room.onMessage(MSG.error, (e: { error?: string }) => fail("room", e?.error ?? "error"));
  room.onMessage("*", () => {});
  room.onLeave((code) => {
    if (pl.leaving) return;
    bump("unexpectedDisconnects");
    fail("disconnect", `code ${code}`);
  });
}

async function connectPlayers(players: Player[]) {
  await eachLimit(players, CONNECT_CONCURRENCY, async (pl) => {
    try {
      const room = await timed(samples.connectMs, () => new Client(RT).joinOrCreate(PARTY_ROOM, { partyId: pl.party.id, devUser: pl.handle }));
      pl.room = room;
      (roomsByParty.get(pl.party.id) ?? roomsByParty.set(pl.party.id, new Set()).get(pl.party.id)!).add(room.roomId);
      play(pl, room);
      bump("connected");
    } catch (e) {
      fail("connect", (e as Error).message?.slice(0, 80) ?? "error");
    }
  });
}

async function main() {
  console.log(`Load test ${RUN}, shard ${SHARD + 1} of ${SHARDS}: ${myParties.length} of ${PARTIES} parties × ${PLAYERS} players against ${API} / ${RT}, starting ${STARTS_AT.toISOString()}.`);
  await preflight();

  mark("creating parties");
  const list = await createParties();
  mark(`${list.length} parties created; waiting for their questions`);
  await waitForQuestions(list);

  const players: Player[] = list.flatMap((party) => Array.from({ length: PLAYERS }, (_, n) => ({ handle: handleOf(party.index, n), party })));
  counts.players = players.length;
  mark(`seating ${players.length - list.length} players (${JOIN_CONCURRENCY} at a time)`);
  await seatPlayers(players);
  mark(`connecting ${players.length} players to their rooms (${CONNECT_CONCURRENCY} at a time)`);
  await connectPlayers(players);
  const connected = players.filter((p) => p.room);
  expectedFinals = connected.length;
  for (const [, ids] of roomsByParty) {
    if (ids.size < 2) continue;
    bump("partiesSplit");
    fail("rooms", `a party split across ${ids.size} rooms`);
  }
  mark(`${connected.length} connected; the parties start at ${STARTS_AT.toISOString().slice(11, 19)}`);

  const deadline = STARTS_AT.getTime() + QUESTIONS * (SECONDS + BEATS_SECONDS) * 1000 + END_SLACK_MS;
  const timedOut = await Promise.race([allDone.then(() => false), sleep(Math.max(0, deadline - Date.now())).then(() => true)]);
  if (timedOut) fail("run", `${expectedFinals - finished} players never saw the end`);
  mark(timedOut ? "deadline passed" : "every party ended");

  for (const [, a] of arrivals) samples.fanoutSpreadMs.push(a.last - a.first);
  for (const pl of connected) pl.leaving = true;
  await Promise.all(connected.map((pl) => pl.room!.leave().catch(() => undefined)));

  const report = {
    run: RUN, shard: SHARD, shards: SHARDS, api: API, rt: RT, startsAt: STARTS_AT.toISOString(),
    settings: { parties: PARTIES, players: PLAYERS, questions: QUESTIONS, seconds: SECONDS, joinConcurrency: JOIN_CONCURRENCY, connectConcurrency: CONNECT_CONCURRENCY },
    counts, errors, samples, timeline,
  };
  writeFileSync(OUT, JSON.stringify(report));
  console.log(`\nReport: ${OUT}\n`);
  console.log(formatSummary(summarise([report])));
  process.exit(0);
}

await main();

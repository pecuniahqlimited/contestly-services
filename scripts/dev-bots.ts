/**
 * DEV ONLY: fill a party with bot players so one person can play a full round from their phone.
 *
 *   npm run dev:bots                       new party (hosted by a bot), 3 bots, starts in 3 minutes
 *   npm run dev:bots -- <partyId>          3 bots join an existing open party
 *   npm run dev:bots -- --bots 5 --starts-in 2 --free --brief "Nollywood classics"
 *
 * Bots are real dev users, fresh each run and named "(bot)" with a 🤖, who join through the API, sit in the room and answer
 * with their own pace and accuracy. Like the sims, they read the right answers from Postgres; nothing like
 * this exists in the product. Press Enter while they wait to start the party now instead of at its time.
 *
 * Refuses unless AUTH_MODE=dev.
 */
import { createInterface } from "node:readline";
import { Client, type Room } from "colyseus.js";
import { eq } from "drizzle-orm";
import { db, partyQuestions } from "@contestly/db";
import { partyQueue } from "@contestly/queue";
import { MSG, PARTY_ROOM, kobo, type QuestionFormat } from "@contestly/shared";
import { RT, api, correctAnswer, sleep, wrongAnswer } from "./sim-lib.js";

if (process.env.AUTH_MODE !== "dev") {
  console.error("dev:bots only runs with AUTH_MODE=dev.");
  process.exit(1);
}

const BOT_NAMES = ["Bisi", "Chuks", "Funmi", "Musa", "Ngozi", "Tobi"];
/**
 * Fresh bots every run: the engine never repeats a question to anyone seated, so bots that have played before
 * would shrink the pool of questions a new party can use (with the mock generator, enough to cancel it).
 */
const RUN = Date.now().toString(36).slice(-4);
const BOTS = BOT_NAMES.map((name) => ({ handle: `bot.${name.toLowerCase()}.${RUN}`, displayName: `${name} (bot)` }));
/** A new party's brief, picked at random unless --brief is given: spreads play across the question bank. */
const BRIEFS = [
  "Nigerian general knowledge: cities, food, music and football",
  "Afrobeats: the hits, the artists and the moments",
  "Nollywood classics and the stars who made them",
  "Nigerian history since independence",
  "Football: Super Eagles, AFCON and the Premier League",
  "Geography of Nigeria and West Africa",
];
const BOT_EMOJI = "🤖";
const DEFAULT_BOTS = 3;
const DEFAULT_STARTS_IN_MINUTES = 3;
const ENTRY_KOBO = kobo(100);
/** Each bot gets its own accuracy and pace, so the standings move. */
const ACCURACY = { min: 0.35, max: 0.85 };
/** Bots answer between these shares of the question's time. */
const PACE = { min: 0.2, max: 0.85 };
/** Chance a bot drops a sticker on a standings screen. */
const STICKER_CHANCE = 0.3;
const STICKERS = ["🔥", "😤", "😂", "🙌🏾", "👀"];

/** Flags that take a value; anything else not starting with -- is the party id. */
const VALUE_FLAGS = new Set(["--bots", "--starts-in", "--brief"]);
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const count = Math.min(BOTS.length, Math.max(1, Number(flag("--bots") ?? DEFAULT_BOTS)));
const startsInMinutes = Math.max(1, Number(flag("--starts-in") ?? DEFAULT_STARTS_IN_MINUTES));
const free = args.includes("--free");
const brief = flag("--brief") ?? BRIEFS[Math.floor(Math.random() * BRIEFS.length)];
const partyArg = args.find((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(args[i - 1]));

const between = ({ min, max }: { min: number; max: number }) => min + Math.random() * (max - min);
const bots = BOTS.slice(0, count).map((b) => ({ ...b, accuracy: between(ACCURACY), id: "" }));

for (const b of bots) {
  await api(b.handle, "POST", "/me", { handle: b.handle, displayName: b.displayName, avatarEmoji: BOT_EMOJI });
  b.id = (await api(b.handle, "GET", "/me")).id;
  if (!free) await api(b.handle, "POST", "/wallet/dev-topup", { nairaAmount: 1000 });
}

let partyId = partyArg;
if (!partyId) {
  const host = bots[0];
  const party = await api(host.handle, "POST", "/parties", {
    title: "Quiz night with the bots",
    brief,
    startsInMinutes,
    maxPlayers: 10,
    ...(free
      ? { entryKobo: 0, funding: "host", prizeKind: "noncash", prizeText: "Bragging rights" }
      : { entryKobo: ENTRY_KOBO, funding: "pooled" }),
  });
  partyId = party.id as string;
  console.log(`Created "${party.title}" (${partyId}) about "${brief}", hosted by ${host.displayName}, starting in ${startsInMinutes} min.`);
}

const detail = await api(bots[0].handle, "GET", `/parties/${partyId}`);
if (detail.status !== "open") {
  console.error(`That party is ${detail.status}; bots can only join an open party.`);
  process.exit(1);
}
for (const b of bots) {
  const res = await api(b.handle, "POST", `/parties/${partyId}/join`);
  if (!res.joined) throw new Error(`${b.handle} couldn't join: ${JSON.stringify(res)}`);
}
console.log(`${bots.map((b) => b.displayName).join(", ")} joined "${detail.title}".`);

const answerKey = async (questionId: string) => (await db.select().from(partyQuestions).where(eq(partyQuestions.id, questionId)))[0];

let resolveDone!: () => void;
const done = new Promise<void>((r) => (resolveDone = r));
const rooms: Room[] = [];
for (const b of bots) {
  const room = await new Client(RT).joinOrCreate(PARTY_ROOM, { partyId, devUser: b.handle });
  rooms.push(room);
  room.onMessage(MSG.question, async (q: { questionId: string; seconds: number }) => {
    const row = await answerKey(q.questionId);
    if (!row) return;
    const right = Math.random() < b.accuracy;
    const answer = (right ? correctAnswer : wrongAnswer)(row.format as QuestionFormat, row.payload);
    await sleep(q.seconds * 1000 * between(PACE));
    room.send(MSG.answer, answer);
    room.send(MSG.lock);
  });
  room.onMessage(MSG.standings, async () => {
    if (Math.random() >= STICKER_CHANCE) return;
    await sleep(between({ min: 500, max: 2500 }));
    room.send(MSG.chat, { sticker: STICKERS[Math.floor(Math.random() * STICKERS.length)] });
  });
  room.onMessage(MSG.finalStandings, (f: { rows: { userId: string; rank: number; score: number }[] }) => {
    if (b !== bots[0]) return;
    console.log("\nFinal standings:");
    for (const r of f.rows) console.log(`  ${r.rank}. ${bots.find((x) => x.id === r.userId)?.displayName ?? r.userId}  ${r.score}`);
    resolveDone();
  });
  room.onMessage(MSG.phase, (p: { phase: string }) => {
    if (b !== bots[0]) return;
    if (p.phase === "generating") console.log("Party started; the questions are being generated…");
    if (p.phase === "cancelled") {
      console.log("The party was cancelled (not enough players, or no questions). Entries are refunded.");
      resolveDone();
    }
  });
  for (const t of [MSG.reveal, MSG.chatMessage, MSG.presence, MSG.questionVoided, MSG.error]) room.onMessage(t, () => {});
}

const startsAt = new Date(detail.startsAt);
console.log(`Bots are in the room. The party starts at ${startsAt.toLocaleTimeString()}.`);
if (process.stdin.isTTY) {
  console.log("Press Enter to start it now.");
  const rl = createInterface({ input: process.stdin });
  rl.once("line", async () => {
    rl.close();
    const job = await partyQueue().getJob(`start-${partyId}`);
    if (job && (await job.isDelayed())) {
      await job.promote();
      console.log("Starting now.");
    } else console.log("It's already starting.");
  });
}

await done;
await Promise.all(rooms.map((room) => room.leave().catch(() => undefined)));
console.log("Bots left the room.");
process.exit(0);

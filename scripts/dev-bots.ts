/**
 * DEV ONLY: fill a party with bot players so one person can play a full round from their phone.
 *
 *   npm run dev:bots                       new party (hosted by a bot), 3 bots, starts in 3 minutes
 *   npm run dev:bots -- <partyId>          3 bots join an existing open party
 *   npm run dev:bots -- --latest tunde     3 bots join tunde's newest open party
 *   npm run dev:bots -- --bots 5 --starts-in 2 --free --brief "Nollywood classics"
 *   npm run dev:bots -- --regulars --latest tunde   the same bots every run (@bot.bisi, @bot.chuks, …), to follow and play again
 *   npm run dev:bots -- --regulars --invite tunde   a new party hosted by @bot.bisi, who invites @tunde to it
 *
 * Bots are real dev users, named "(bot)" with a 🤖, who join through the API, sit in the room and answer
 * with their own pace and accuracy. Like the sims, they read the right answers from Postgres; nothing like
 * this exists in the product. Press Enter while they wait to start the party now instead of at its time.
 *
 * Refuses unless AUTH_MODE=dev.
 */
import { createInterface } from "node:readline";
import { Client, type Room } from "colyseus.js";
import { and, desc, eq } from "drizzle-orm";
import { db, parties, partyQuestions, users } from "@contestly/db";
import { partyQueue } from "@contestly/queue";
import { MSG, PARTY_ROOM, kobo, type QuestionFormat } from "@contestly/shared";
import { RT, api, call, correctAnswer, inMinutes, sleep, wrongAnswer } from "./sim-lib.js";

if (process.env.AUTH_MODE !== "dev") {
  console.error("dev:bots only runs with AUTH_MODE=dev.");
  process.exit(1);
}

const BOT_NAMES = ["Bisi", "Chuks", "Funmi", "Musa", "Ngozi", "Tobi"];
/**
 * Fresh bots every run unless --regulars: the engine never repeats a question to anyone seated, so bots that
 * have played before shrink the pool of questions a new party can use (with the mock generator, enough to
 * cancel it after many runs). Regulars trade that for people you can follow, invite and play again.
 */
const regulars = process.argv.includes("--regulars");
const RUN = Date.now().toString(36).slice(-4);
const BOTS = BOT_NAMES.map((name) => ({ handle: regulars ? `bot.${name.toLowerCase()}` : `bot.${name.toLowerCase()}.${RUN}`, displayName: `${name} (bot)` }));
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
/** --free: the host bot puts up the smallest cash prize the default limits allow; only verified brands offer goods. */
const FREE_PRIZE_KOBO = kobo(500);
/** Each bot gets its own accuracy and pace, so the standings move. */
const ACCURACY = { min: 0.35, max: 0.85 };
/** Bots answer between these shares of the question's time. */
const PACE = { min: 0.2, max: 0.85 };
/** Chance a bot drops a sticker on a standings screen. */
const STICKER_CHANCE = 0.3;
const STICKERS = ["🔥", "😤", "😂", "🙌🏾", "👀"];

/** Flags that take a value; anything else not starting with -- is the party id. */
const VALUE_FLAGS = new Set(["--bots", "--starts-in", "--brief", "--latest", "--invite"]);
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
const latestOf = flag("--latest")?.trim().toLowerCase();
const inviteHandle = flag("--invite")?.trim().toLowerCase();
if (inviteHandle && (partyArg || latestOf)) {
  console.error("--invite makes a new party; leave out the party id and --latest.");
  process.exit(1);
}

/** The newest open party this handle created, so you needn't copy its id off the phone. */
async function latestOpenParty(handle: string): Promise<string> {
  const [host] = await db.select({ id: users.id }).from(users).where(eq(users.handle, handle));
  if (!host) throw new Error(`No user @${handle}.`);
  const [p] = await db.select({ id: parties.id, title: parties.title }).from(parties)
    .where(and(eq(parties.createdByUserId, host.id), eq(parties.status, "open")))
    .orderBy(desc(parties.createdAt)).limit(1);
  if (!p) throw new Error(`@${handle} has no open party.`);
  console.log(`@${handle}'s newest open party: "${p.title}" (${p.id}).`);
  return p.id;
}

/** The host bot invites someone through the API, so the same guards apply: they must follow, be followed by, or have played with the bot. */
async function inviteFrom(hostHandle: string, partyId: string, handle: string) {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.handle, handle));
  if (!u) throw new Error(`No user @${handle}.`);
  const { status, body } = await call<{ error?: string }>(hostHandle, "POST", `/parties/${partyId}/invites`, { userIds: [u.id] });
  if (status !== 201) {
    console.error(`@${hostHandle} couldn't invite @${handle} (${body.error}). Play a round with --regulars first, or follow @${hostHandle}.`);
    process.exit(1);
  }
  console.log(`@${hostHandle} invited @${handle}; it's in their Chats › Parties.`);
}

const between = ({ min, max }: { min: number; max: number }) => min + Math.random() * (max - min);
const bots = BOTS.slice(0, count).map((b) => ({ ...b, accuracy: between(ACCURACY), id: "" }));

for (const b of bots) {
  await api(b.handle, "POST", "/me", { handle: b.handle, displayName: b.displayName, avatarEmoji: BOT_EMOJI });
  b.id = (await api(b.handle, "GET", "/me")).id;
  await api(b.handle, "POST", "/wallet/dev-topup", { nairaAmount: 1000 });
}

let partyId = partyArg ?? (latestOf ? await latestOpenParty(latestOf) : undefined);
if (!partyId) {
  const host = bots[0];
  const party = await api(host.handle, "POST", "/parties", {
    title: "Quiz night with the bots",
    brief,
    startsAt: inMinutes(startsInMinutes),
    maxPlayers: 10,
    split: "winner",
    ...(free
      ? { entryKobo: 0, funding: "host", prizeKind: "cash", hostPoolKobo: FREE_PRIZE_KOBO }
      : { entryKobo: ENTRY_KOBO, funding: "pooled" }),
  });
  partyId = party.id as string;
  console.log(`Created "${party.title}" (${partyId}) about "${brief}", hosted by ${host.displayName}, starting in ${startsInMinutes} min.`);
  if (inviteHandle) await inviteFrom(host.handle, partyId, inviteHandle);
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

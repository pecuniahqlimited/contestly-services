/**
 * Admin essentials end to end, against the running stack (roadmap 5a):
 *
 * 1. A live party where players flag a question until the room voids it; then an admin bans the player
 *    who's winning. They're dropped from the room, can't rejoin or use the API, and settlement skips them
 *    for the prize.
 * 2. The voided question shows up in the queue with its flags; the admin restores it (back in retrieval,
 *    flags cleared), then edits it: one edit passes re-verification and replaces the bank row, one fails
 *    the safety check and changes nothing.
 * 3. An admin cancels a live party: asked twice, cancelled once, everyone refunded through the worker.
 * Every action is in the admin log with its reason.
 *
 * TEST-ONLY: reads correct answers from Postgres to drive its players. Run with the stack up: npm run sim:admin
 */
import { randomBytes } from "node:crypto";
import { Client, type Room } from "colyseus.js";
import { eq } from "drizzle-orm";
import { bankQuestions, db, partyQuestions, sql } from "@contestly/db";
import { closeQueues, partyQueue } from "@contestly/queue";
import { MSG, PARTY_ROOM, kobo, type QuestionFormat } from "@contestly/shared";
import { RT, api, call, correctAnswer, failureCount, inMinutes, ok, partyNetKobo, sleep, waitFor, wrongAnswer } from "./sim-lib.js";

const tag = randomBytes(3).toString("hex");
const ADMIN = "tunde"; // any dev user passes requireAdmin in AUTH_MODE=dev
const h = (name: string) => `adm.${tag}.${name}`;
const [HOST, WINNER, P3, P4, HOST2, P5] = ["host", "win", "p3", "p4", "host2", "p5"].map(h);
const BRIEF = "Nigerian general knowledge — cities, food, music, football";
const partyJobs = partyQueue();

const userId = async (handle: string) => (await api(handle, "GET", "/me")).id as string;
const ids = new Map<string, string>();
for (const p of [HOST, WINNER, P3, P4, HOST2, P5]) ids.set(p, await userId(p));

async function createReadyParty(host: string, title: string) {
  const p = await api(host, "POST", "/parties", { title, brief: BRIEF, startsAt: inMinutes(30), questionCount: 3, secondsPerQuestion: 5, funding: "pooled", entryKobo: kobo(100), maxPlayers: 6, split: "winner" });
  const ready = await waitFor(async () => (await api(host, "GET", `/parties/${p.id}`)).questions.status === "ready", { tries: 80 });
  if (!ready) throw new Error(`${title}: question set never got ready`);
  return p.id as string;
}
const startNow = async (partyId: string) => (await partyJobs.getJob(`start-${partyId}`))!.promote();
const partyQuestion = async (id: string) => (await db.select().from(partyQuestions).where(eq(partyQuestions.id, id)))[0];
/** A room the server already closed never resolves leave(); don't wait on it. */
const leave = (r: Room) => Promise.race([r.leave().catch(() => {}), sleep(500)]);
const partyStatus = async (partyId: string) => (await api(ADMIN, "GET", `/admin/parties/${partyId}`)).party.status as string;

try {
  // ================================================================ 1. flag → void, then ban mid-party
  console.log("\n==== a live party: a question voided by flags, then the leader banned ====");
  const partyA = await createReadyParty(HOST, `Admin sim ban ${tag}`);
  for (const p of [WINNER, P3, P4]) await api(p, "POST", `/parties/${partyA}/join`);

  let voidedQuestionId = "";
  let winnerClosedWith = 0;
  let bannedNoticeSeen = false;
  let resolveFinal!: (rows: any[]) => void;
  const final = new Promise<any[]>((r) => (resolveFinal = r));
  let bannedAt = 0;
  const rooms = new Map<string, Room>();
  for (const p of [HOST, WINNER, P3, P4]) {
    const room = await new Client(RT).joinOrCreate(PARTY_ROOM, { partyId: partyA, devUser: p });
    rooms.set(p, room);
    for (const t of [MSG.reveal, MSG.standings, MSG.chatMessage, MSG.phase, MSG.questionsStatus, MSG.presence, MSG.questionVoided]) room.onMessage(t, () => {});
    room.onMessage(MSG.error, (e: any) => { if (p === WINNER && e?.error === "account_banned") bannedNoticeSeen = true; });
    if (p === WINNER) room.onLeave((code) => { winnerClosedWith = code; });
    room.onMessage(MSG.finalStandings, (f: any) => { if (p === HOST) resolveFinal(f.rows); });
    room.onMessage(MSG.question, async (view: any) => {
      const q = await partyQuestion(view.questionId);
      const format = q.format as QuestionFormat;
      if (view.idx === 0 && p !== WINNER) {
        // Three of four players flag the first question: past the threshold (30%, at least 3), the room voids it.
        room.send(MSG.flag, { questionId: view.questionId, reason: "wrong_answer" });
        voidedQuestionId = view.questionId;
        return;
      }
      // The winner answers right and fast; everyone else wrong.
      setTimeout(() => room.send(MSG.answer, p === WINNER ? correctAnswer(format, q.payload) : wrongAnswer(format, q.payload)), 300);
      // Once the winner has points on the board (the second question), the admin bans them.
      if (p === HOST && view.idx === 2 && !bannedAt) {
        await sleep(800);
        bannedAt = Date.now();
        const missing = await call(ADMIN, "POST", `/admin/users/${ids.get(WINNER)}/ban`, {});
        ok(missing.status === 400, "a ban needs a reason");
        const ban = await api(ADMIN, "POST", `/admin/users/${ids.get(WINNER)}/ban`, { reason: "sim: cheating reported" });
        ok(!!ban.user.bannedAt && ban.user.banReason === "sim: cheating reported", "the admin bans the leader, with a reason");
      }
    });
  }
  await startNow(partyA);
  console.log("4 players in the room; playing (~60s)…");
  const rows = await Promise.race([final, sleep(180_000).then(() => { throw new Error("party A timed out"); })]);

  ok(!!voidedQuestionId && (await partyQuestion(voidedQuestionId)).status === "voided", "the flagged question was voided for the room");
  ok(bannedNoticeSeen && winnerClosedWith === 4403, `the banned player was told and dropped from the room (close ${winnerClosedWith})`);
  const rejoin = await new Client(RT).joinOrCreate(PARTY_ROOM, { partyId: partyA, devUser: WINNER }).then(() => "joined", (e: Error) => e.message);
  ok(rejoin.includes("account_banned"), `and can't get back in (${rejoin})`);
  const me = await call(WINNER, "GET", "/me");
  ok(me.status === 403 && me.body.error === "account_banned", "nor use the API");
  const create = await call(WINNER, "POST", "/parties", {});
  ok(create.status === 403 && create.body.error === "account_banned", "nor host");

  await waitFor(async () => (await partyStatus(partyA)) === "finished", { tries: 40 });
  const detailA = await api(ADMIN, "GET", `/admin/parties/${partyA}`);
  const winnerRow = detailA.players.find((x: any) => x.person.id === ids.get(WINNER));
  const paid = detailA.players.filter((x: any) => (x.prizeKobo ?? 0) > 0);
  ok(rows.find((r: any) => r.userId === ids.get(WINNER))?.rank === 1 && winnerRow.banned, "the banned player still tops the board…");
  ok(!winnerRow.prizeKobo && paid.length === 1 && paid[0].person.id !== ids.get(WINNER), `…but the prize went to the best player in good standing (${paid[0]?.person.handle})`);
  ok(detailA.questions.voided >= 1 && detailA.questions.flags >= 3, "the party detail shows the void and its flags (never the questions)");
  for (const r of rooms.values()) await leave(r);

  // ================================================================ 2. the question queue
  console.log("\n==== the voided question: queue, restore, edit and re-verify ====");
  const bankId = (await partyQuestion(voidedQuestionId)).sourceRef!;
  const queued = await waitFor(async () => {
    const { questions } = await api(ADMIN, "GET", "/admin/questions?view=pending_review&limit=200");
    return questions.find((q: any) => q.id === bankId);
  });
  ok(!!queued && queued.flags.wrong_answer >= 3 && queued.voids >= 1, `it's in the queue, pending review, with its flags (${JSON.stringify(queued?.flags)})`);
  const detail = await api(ADMIN, "GET", `/admin/questions/${bankId}`);
  ok(detail.generation.length >= 1 && detail.generation[0].approvedBy.kind === "gate" && !!detail.generation[0].spec, "its generation record: brief, spec, checks, approved by the automated gate");
  ok(detail.voidEvents[0]?.partyId === partyA, "and the room that voided it, with the tally");
  const restored = await api(ADMIN, "POST", `/admin/questions/${bankId}/restore`, { reason: "sim: the answer was right after all" });
  ok(restored.question.status === "active" && restored.question.flagCount === 0, "restored: back in retrieval, flags cleared");

  const original = (await db.select().from(bankQuestions).where(eq(bankQuestions.id, bankId)))[0];
  const editedPayload = { ...(original.payload as any), question: `${(original.payload as any).question} (checked ${tag})` };
  const good = await api(ADMIN, "POST", `/admin/questions/${bankId}/edit`, { payload: editedPayload, claim: "the marked option is correct", reason: "sim: clearer wording" });
  const judged = await waitFor(async () => (await api(ADMIN, "GET", `/admin/questions/${bankId}`)).reviews.find((r: any) => r.id === good.reviewId && r.status !== "pending"));
  ok(judged?.status === "accepted", `an edit is re-verified and accepted (${judged?.status})`);
  const afterGood = (await db.select().from(bankQuestions).where(eq(bankQuestions.id, bankId)))[0];
  ok((afterGood.payload as any).question === editedPayload.question, "and replaced the bank question");
  const badPayload = { ...editedPayload, question: `${editedPayload.question} bet9ja odds` };
  const bad = await api(ADMIN, "POST", `/admin/questions/${bankId}/edit`, { payload: badPayload, claim: "the marked option is correct", reason: "sim: an edit that shouldn't pass" });
  const rejected = await waitFor(async () => (await api(ADMIN, "GET", `/admin/questions/${bankId}`)).reviews.find((r: any) => r.id === bad.reviewId && r.status !== "pending"));
  ok(rejected?.status === "rejected_safety", `an edit that fails a check is rejected (${rejected?.status})`);
  ok(((await db.select().from(bankQuestions).where(eq(bankQuestions.id, bankId)))[0].payload as any).question === editedPayload.question, "and the bank question is unchanged");

  // ================================================================ 3. cancel a live party
  console.log("\n==== cancel a live party: refunds through the worker, once ====");
  const partyB = await createReadyParty(HOST2, `Admin sim cancel ${tag}`);
  await api(P5, "POST", `/parties/${partyB}/join`);
  let cancelledSeen = false;
  let firstQuestion!: () => void;
  const started = new Promise<void>((r) => (firstQuestion = r));
  const roomsB: Room[] = [];
  for (const p of [HOST2, P5]) {
    const room = await new Client(RT).joinOrCreate(PARTY_ROOM, { partyId: partyB, devUser: p });
    roomsB.push(room);
    for (const t of [MSG.reveal, MSG.standings, MSG.chatMessage, MSG.questionsStatus, MSG.presence, MSG.error]) room.onMessage(t, () => {});
    room.onMessage(MSG.phase, (m: any) => { if (m?.phase === "cancelled") cancelledSeen = true; });
    room.onMessage(MSG.question, () => firstQuestion());
  }
  await startNow(partyB);
  await started;
  ok((await partyStatus(partyB)) === "live", "the party is live");
  const noReason = await call(ADMIN, "POST", `/admin/parties/${partyB}/cancel`, {});
  ok(noReason.status === 400, "a cancel needs a reason");
  const [c1, c2] = await Promise.all([
    api(ADMIN, "POST", `/admin/parties/${partyB}/cancel`, { reason: "sim: broken questions" }),
    api(ADMIN, "POST", `/admin/parties/${partyB}/cancel`, { reason: "sim: broken questions" }),
  ]);
  ok([c1.replayed, c2.replayed].filter((r) => !r).length === 1, "asked twice at once: one cancel, one replay");
  ok(!!(await waitFor(async () => (await partyStatus(partyB)) === "cancelled")), "the worker cancelled it");
  ok(!!(await waitFor(async () => cancelledSeen)), "the room was told");
  for (const p of [HOST2, P5]) ok((await partyNetKobo(ids.get(p)!, partyB)) === 0, `${p.split(".").pop()} was refunded in full`);
  const detailB = await api(ADMIN, "GET", `/admin/parties/${partyB}`);
  const refunds = detailB.settlement.byType.find((t: any) => t.type === "party_refund");
  ok(refunds?.entries === 2 && detailB.actions.filter((a: any) => a.action === "party.cancel").length === 1, "two refunds, one logged cancel");
  ok((await api(ADMIN, "POST", `/admin/parties/${partyB}/cancel`, { reason: "again" })).status === "cancelled", "asking again later is a no-op");
  for (const r of roomsB) await leave(r);

  // ================================================================ the log
  const log = await api(ADMIN, "GET", `/admin/actions?targetId=${ids.get(WINNER)}`);
  ok(log.actions[0]?.action === "user.ban" && log.actions[0].reason === "sim: cheating reported", "the ban is in the admin log with its reason");
  const unban = await api(ADMIN, "POST", `/admin/users/${ids.get(WINNER)}/unban`, { reason: "sim: tidy up" });
  ok(unban.user.bannedAt === null && (await call(WINNER, "GET", "/me")).status === 200, "unban lets them back in");
} finally {
  await closeQueues(partyJobs);
  await sql.end();
}

console.log(failureCount() ? `\n${failureCount()} check(s) failed` : "\nall admin checks passed");
process.exit(failureCount() ? 1 : 0);

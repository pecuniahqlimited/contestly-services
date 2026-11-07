/**
 * Row 13 sim (ADR 0015): a party from the Bridal shower template with host-written questions, end to end on the
 * running stack. The builder reads the templates, asks the questions service for distractors, is refused when
 * unsafe, free or over a cap, and makes the party; the set is forced to curate, the engine drafts around the
 * host's questions (never banking them) and the host approves; three players play while the host watches. The
 * host's friend aces the host's questions and wins: the prize is credited but held (withdrawals refused, an alert
 * raised); an admin rejects it, it passes to second place, and a replay moves nothing. Then a new template config
 * version is saved and put back.
 *
 * TEST-ONLY. Reads correct answers straight from Postgres to drive its personas, writes a contact match and a
 * verified phone for the friend, and saves admin config (put back before exit, even on failure).
 *
 * Run with the stack up (npm run infra:up && npm run dev):  npm run sim:templates
 */
import { Client, type Room } from "colyseus.js";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { adminAlerts, bankQuestions, db, heldPrizes, ledgerAccounts, ledgerEntries, partyQuestions, users } from "@contestly/db";
import { partyQueue } from "@contestly/queue";
import { MSG, PARTY_ROOM, hostSlots } from "@contestly/shared";
import type { QuestionFormat } from "@contestly/game";
import { RT, api, call, correctAnswer, failureCount, inMinutes, makeContacts, ok, partyNetKobo, putBack, putBackLater, sleep, waitFor, wrongAnswer } from "./sim-lib.js";

const ADMIN = "tunde"; // a dev admin (DEV_ADMIN_HANDLES)
// Fresh accounts each run: the repeat-winner check (ADR 0015) would otherwise hold whoever won this host's earlier runs.
const RUN = Date.now().toString(36).slice(-5);
const HOST = `tpl.host.${RUN}`;
const FRIEND = `tpl.friend.${RUN}`;
/** Every held-prize decision takes two admins (ADR 0015): ADMIN asks, ADMIN2 confirms. */
const ADMIN2 = `tpl.admin2.${RUN}`;
const PLAYERS = [FRIEND, `tpl.ada.${RUN}`, `tpl.kemi.${RUN}`];
const ENTRY = 20_000;

const topUp = (h: string) => api(h, "POST", "/wallet/dev-topup", { nairaAmount: 1000 }).catch(() => ({}));
for (const h of [HOST, ...PLAYERS]) await topUp(h);
const userIds = new Map<string, string>();
for (const h of [HOST, ...PLAYERS]) userIds.set(h, (await api(h, "GET", "/me")).id);
const handleOf = (id: string) => [...userIds.entries()].find(([, v]) => v === id)?.[0] ?? id;

try {
  // ---- the builder's first scene ---------------------------------------------------------------
  console.log("templates and distractors…");
  const offered = await api(HOST, "GET", "/party-templates");
  ok(offered.templates.map((t: any) => t.id).join() === "birthday,bridal-shower,couples,game-night,office-party,reunion", `six templates offered (${offered.templates.length})`);
  const bridal = offered.templates.find((t: any) => t.id === "bridal-shower");
  ok(bridal.hostPrompts.length >= 4 && bridal.cover.emoji === "💍", `Bridal shower: ${bridal.hostPrompts.length} host prompts, its cover`);

  const ask = async (question: string, answer: string) => call(HOST, "POST", "/parties/host-questions/distractors", { question, answer, brief: bridal.brief });
  const meet = await ask("Where did Tolu and Femi first meet?", "Church");
  ok(meet.status === 200 && meet.body.distractors.length === 3 && !meet.body.distractors.some((d: string) => d.toLowerCase() === "church"), `three distractors from the questions service (${meet.body.distractors?.join(", ")})`);
  const years = await ask("How many years have Tolu and Femi been together?", "6");
  ok(years.status === 200 && years.body.distractors.every((d: string) => /^\d+$/.test(d)), `numbers for a number (${years.body.distractors?.join(", ")})`);
  const unsafe = await ask("Which casino did they meet in?", "Eko casino");
  ok(unsafe.status === 422 && unsafe.body.error === "host_text_unsafe", `the host's own unsafe words are refused (${unsafe.status} ${unsafe.body.error})`);

  const hostQuestions = [
    { question: "Where did Tolu and Femi first meet?", answer: "Church", distractors: meet.body.distractors },
    { question: "How many years have Tolu and Femi been together?", answer: "6", distractors: years.body.distractors },
  ];
  const base = { template: { id: "bridal-shower", version: offered.version }, funding: "pooled", entryKobo: ENTRY, maxPlayers: 6, split: "winner", startsAt: inMinutes(30), questionCount: 4, secondsPerQuestion: 6, formats: ["pick_one"], hostQuestions };
  ok((await call(HOST, "POST", "/parties", { ...base, entryKobo: 0 })).body.error === "template_party_cannot_be_free", "a free template party is refused");
  ok((await call(HOST, "POST", "/parties", { ...base, entryKobo: offered.rules.maxEntryKobo + 10_000 })).body.error === "curate_entry_above_cap", "an entry above the cap is refused");
  const tooMany = [...hostQuestions, { question: "Who said I love you first?", answer: "Femi", distractors: ["Tolu", "Neither", "Both"] }];
  ok((await call(HOST, "POST", "/parties", { ...base, hostQuestions: tooMany })).body.error === "host_written_share_above_cap", "more than half the set host-written is refused");

  // ---- the party: forced curate, drafted around the host's questions ------------------------------
  console.log("\nthe party…");
  const made = await call(HOST, "POST", "/parties", { ...base, mode: "sealed" });
  ok(made.status === 201, `created (${made.status} ${made.body.error ?? ""})`);
  const partyId: string = made.body.id;
  ok(made.body.mode === "curate" && made.body.title === "Bridal shower quiz" && made.body.coverEmoji === "💍", "forced to curate, title and cover from the template");
  ok(made.body.questions.hostWritten === true && made.body.questions.review === "host_reviewed", "discloses host-written questions, host-reviewed");
  ok(made.body.playerCount === 0, "the host isn't seated");

  await api(HOST, "POST", `/parties/${partyId}/drafts`);
  const drafted = await waitFor(async () => { const d = await api(HOST, "GET", `/parties/${partyId}/drafts`); return d.questions.some((q: any) => !q.hostWritten) ? d : null; });
  const order = (drafted?.questions ?? []).filter((q: any) => !q.reserve).sort((a: any, b: any) => a.idx - b.idx);
  ok(order.length === 4, `play order of 4 (${order.length})`);
  ok(order.map((q: any, i: number) => (q.hostWritten ? i : -1)).filter((i: number) => i >= 0).join() === hostSlots(4, 2).join(), `host-written questions spread through it (${order.map((q: any) => (q.hostWritten ? "H" : "t")).join("")})`);
  for (const q of drafted!.questions.filter((d: any) => d.status === "draft")) await api(HOST, "POST", `/parties/${partyId}/drafts/${q.id}/approve`);
  const [{ banked }] = await db.select({ banked: sql<number>`count(*)::int` }).from(bankQuestions).where(inArray(sql`${bankQuestions.payload}->>'question'`, hostQuestions.map((q) => q.question)));
  ok(banked === 0, "the host's questions are nowhere in the bank");

  const hostJoin = await call(HOST, "POST", `/parties/${partyId}/join`);
  ok(hostJoin.status === 403 && hostJoin.body.error === "seen_the_questions_cannot_play", "the host can't play");
  for (const h of PLAYERS) ok((await call(h, "POST", `/parties/${partyId}/join`)).status === 201, `${h} joins`);
  const lobby = await api(PLAYERS[1], "GET", `/parties/${partyId}`);
  ok(lobby.questions.hostWritten === true, "the lobby says it includes host-written questions");

  // The friend is one of the host's people.
  await makeContacts(HOST, FRIEND);

  // ---- play: the friend aces the host's questions --------------------------------------------------
  const questionRow = async (id: string) => (await db.select().from(partyQuestions).where(eq(partyQuestions.id, id)))[0];
  let resolveFinal!: (rows: any[]) => void;
  const finalRows = new Promise<any[]>((r) => (resolveFinal = r));
  let roomDisclosure: any = null;
  const rooms: Room[] = [];
  const hostRoom = await new Client(RT).joinOrCreate(PARTY_ROOM, { partyId, devUser: HOST });
  rooms.push(hostRoom);
  hostRoom.onMessage(MSG.phase, (m: any) => { if (m?.questions) roomDisclosure = m.questions; });
  for (const t of [MSG.question, MSG.reveal, MSG.standings, MSG.chatMessage, MSG.presence, MSG.questionVoided, MSG.error, MSG.finalStandings, MSG.seats, MSG.questionsStatus]) hostRoom.onMessage(t, () => {});
  for (const h of PLAYERS) {
    const room = await new Client(RT).joinOrCreate(PARTY_ROOM, { partyId, devUser: h });
    rooms.push(room);
    room.onMessage(MSG.question, async (view: any) => {
      const q = await questionRow(view.questionId);
      // The friend knows the host's answers; everyone else gets those wrong and the themed ones right (a little slower).
      const answer = h === FRIEND || !q.hostWritten ? correctAnswer(q.format as QuestionFormat, q.payload) : wrongAnswer(q.format as QuestionFormat, q.payload);
      setTimeout(() => room.send(MSG.answer, answer), h === FRIEND ? 300 : 900);
    });
    if (h === FRIEND) room.onMessage(MSG.finalStandings, (f: any) => resolveFinal(f.rows));
    for (const t of [MSG.reveal, MSG.standings, MSG.chatMessage, MSG.presence, MSG.phase, MSG.error, MSG.finalStandings, MSG.seats, MSG.questionVoided, MSG.questionsStatus]) if (!(h === FRIEND && t === MSG.finalStandings)) room.onMessage(t, () => {});
  }
  const start = await partyQueue().getJob(`start-${partyId}`);
  if (!start) throw new Error("start job not found — is the API running?");
  await start.promote();
  console.log("\n3 players + the watching host; playing 4 questions (~80s)…");
  const final = await Promise.race([finalRows, sleep(240_000).then(() => { throw new Error("templates sim timed out after 240s"); })]);
  for (const r of final) console.log(`  #${r.rank} ${handleOf(r.userId).padEnd(10)} score=${r.score}`);
  ok(roomDisclosure?.hostWritten === true, "the room discloses host-written questions");
  ok(final[0]?.userId === userIds.get(FRIEND), "the friend won");

  // ---- settlement: credited, held, alerted ---------------------------------------------------------
  const held = await waitFor(async () => (await db.select().from(heldPrizes).where(eq(heldPrizes.partyId, partyId)))[0]);
  ok(!!held && held.userId === userIds.get(FRIEND) && held.status === "held", "the friend's prize is held");
  ok(held?.evidence.links.join() === "contact" && held.evidence.winnerAccuracyPct === 100 && held.evidence.roomAccuracyPct === 0 && held.evidence.flaggedOn.join() === "host_written,all", `with the evidence (${JSON.stringify(held?.evidence)})`);
  const holdOf = async (userId: string) => (await db.select().from(ledgerAccounts).where(and(eq(ledgerAccounts.kind, "prize_hold"), eq(ledgerAccounts.scope, userId))))[0]?.balanceKobo ?? 0;
  ok((await partyNetKobo(userIds.get(FRIEND)!, partyId)) === -ENTRY && (await holdOf(userIds.get(FRIEND)!)) >= held!.amountKobo, "won into their prize hold, not their cash");
  const [alert] = await db.select().from(adminAlerts).where(eq(adminAlerts.dedupeKey, `prize_held:${held!.id}`));
  ok(alert?.kind === "templates.prize_held" && alert.severity === "warning", "a warning alert raised");
  // TEST-ONLY: give the friend a verified phone, so a withdrawal is refused only for a reason that applies to anyone.
  await db.update(users).set({ phone: `+2348${String(Date.now()).slice(-9)}`, phoneVerifiedAt: new Date() }).where(eq(users.id, userIds.get(FRIEND)!));
  const withdraw = await call(FRIEND, "POST", "/wallet/withdrawals", { amountKobo: 10_000, bankAccountId: "00000000-0000-4000-8000-000000000000", clientRequestId: crypto.randomUUID() });
  ok(withdraw.body.details?.reason === undefined && withdraw.status !== 403, `nothing blocks their withdrawals; the prize just isn't in their cash (${withdraw.status} ${withdraw.body.error})`);

  // ---- the admin's queue: reject, passed to second place ---------------------------------------------
  const queue = await api(ADMIN, "GET", "/admin/party-templates/held-prizes?status=held");
  ok(queue.prizes.some((x: any) => x.id === held!.id && x.party.id === partyId), "on the admin's held-prize queue");
  const secondId = final[1].userId;
  const before = await partyNetKobo(secondId, partyId);
  await api(ADMIN2, "GET", "/me");
  await db.update(users).set({ isAdmin: true }).where(eq(users.handle, ADMIN2));
  const asked = await call(ADMIN, "POST", `/admin/party-templates/held-prizes/${held!.id}/reject`, { reason: "Sim: the host fed the answers" });
  ok(asked.body.awaitingSecondAdmin === true && asked.body.prize.status === "held" && (await partyNetKobo(secondId, partyId)) === before, "one admin's reject only asks: nothing moves");
  const rejected = await call(ADMIN2, "POST", `/admin/party-templates/held-prizes/${held!.id}/reject`, { reason: "Sim: agreed, the host fed the answers" });
  ok(rejected.status === 200 && rejected.body.prize.outcome?.kind === "passed_on" && rejected.body.prize.outcome.to[0].userId === secondId, `a second admin confirms: rejected and passed to ${handleOf(secondId)}`);
  ok((await partyNetKobo(secondId, partyId)) === before + held!.amountKobo, "second place has the prize");
  ok((await partyNetKobo(userIds.get(FRIEND)!, partyId)) === -ENTRY, "the friend is back to their entry spent");
  const again = await call(ADMIN, "POST", `/admin/party-templates/held-prizes/${held!.id}/reject`, { reason: "again" });
  const keyed = await db.select().from(ledgerEntries).where(like(ledgerEntries.idempotencyKey, `held_prize_reject:${held!.id}%`));
  ok(again.body.replayed === true && keyed.length === 2, "a second reject is a replay; nothing moves twice");

  await Promise.race([Promise.allSettled(rooms.map((r) => r.leave())), sleep(3000)]);

  // ---- admin config: a new version, then put back ------------------------------------------------
  console.log("\ntemplate config…");
  const current = await api(ADMIN, "GET", "/admin/party-templates");
  putBackLater("the party template config", () => api(ADMIN, "PUT", "/admin/party-templates", { config: current.config, reason: "sim:templates put back" }));
  const hidden = { ...current.config, templates: current.config.templates.map((t: any) => (t.id === "reunion" ? { ...t, hidden: true } : t)) };
  const saved = await call(ADMIN, "PUT", "/admin/party-templates", { config: hidden, reason: "sim:templates hides Reunion" });
  ok(saved.status === 200 && saved.body.version === current.version + 1, `saved as version ${saved.body.version}`);
  ok(!(await api(HOST, "GET", "/party-templates")).templates.some((t: any) => t.id === "reunion"), "a hidden template isn't offered");
  const preview = await api(ADMIN, "POST", "/admin/party-templates/preview", { templateId: "office-party" });
  ok(preview.prefill.title === "Office party quiz" && preview.problems.length === 0, "the preview shows what a party would start as");
} finally {
  await putBack();
}

const failures = failureCount();
console.log(failures ? `\n${failures} assertion(s) FAILED` : "\ntemplates-sim: all assertions passed");
process.exit(failures ? 1 : 0);

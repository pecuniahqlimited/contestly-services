/**
 * Step 2b sim: a curate-mode party built from an uploaded PDF, reviewed by its host, then played
 * by three players who flag two questions until they're voided (one while open, one during its
 * reveal). Asserts the send → read in memory → chunk → embed → cite path (the file itself is never
 * stored, and a new one replaces the old), the curate review actions
 * and lockout, flag → void → replace with its log, scores after voids, settlement, bank updates
 * and retirement.
 *
 * TEST-ONLY. Reads correct answers straight from Postgres to drive its personas, and briefly
 * changes the retirement threshold in app_config (restored before exit).
 *
 * Run with the stack up (npm run infra:up && npm run dev):  npm run sim:curate
 */
import { Client, type Room } from "colyseus.js";
import { and, eq, inArray } from "drizzle-orm";
import {
  db, parties, partyQuestions, partyAnswers, partyQuestionEvents, partyDraftViews, partyFiles, fileChunks, bankQuestions, ledgerEntries,
  getQuestionsConfig, setQuestionsConfig,
} from "@contestly/db";
import { partyQueue, questionsQueue } from "@contestly/queue";
import { MAX_UPLOAD_BYTES, MSG, PARTY_ROOM } from "@contestly/shared";
import type { QuestionFormat } from "@contestly/game";
import { RT, api, call, correctAnswer, failureCount, inMinutes, ok, partyNetKobo, sendFile, sleep, waitFor, wrongAnswer } from "./sim-lib.js";
import { minimalPdf } from "./sim-pdf.js";

const HOST = "tunde";
const PLAYERS = ["ada.o", "kemz", "zee"];
const FACTS = [
  "The Third Mainland Bridge crosses the lagoon and was opened in 1990.",
  "Carter Bridge first linked Lagos Island to the mainland in 1901.",
  "Eko Bridge was completed in 1975 to ease traffic on older crossings.",
  "The Lekki toll bridge opened in 2013 and links Lekki with Ikoyi.",
  "Ferries from the Falomo jetty carry commuters across towards Ikorodu.",
  "The National Theatre stands beside the lagoon at Iganmu.",
  "Tin Can Island port handles many of the containers for Apapa.",
  "The Ogun River flows south before draining into the lagoon near Epe.",
  "Bar Beach lost much of its sand before the Eko Atlantic project began in 2009.",
  "Lagos stopped being the federal capital when the seat moved to Abuja in 1991.",
  "The Makoko community lives in houses built on stilts over the water near Yaba.",
  "Badagry, west of the city, was a busy port on the coast long before 1850.",
];
/** Flagged while open: nobody scores it. */
const VOID_OPEN_IDX = 0;
/** Flagged during its reveal: its points come back off. */
const VOID_REVEAL_IDX = 3;

const topUp = async (h: string) => api(h, "POST", "/wallet/dev-topup", { nairaAmount: 1000 }).catch(() => ({}));
const promoteStart = async (partyId: string) => {
  const job = await partyQueue().getJob(`start-${partyId}`);
  if (!job) throw new Error("start job not found — is the API running?");
  await job.promote();
};
const curateParty = (title: string) => ({
  title, brief: "Lagos bridges, ports and waterways", mode: "curate",
  entryKobo: 20_000, maxPlayers: 6, funding: "pooled", startsAt: inMinutes(30), questionCount: 4, secondsPerQuestion: 5,
});

for (const h of [HOST, ...PLAYERS]) await topUp(h);
const userIds = new Map<string, string>();
for (const h of [HOST, ...PLAYERS]) userIds.set(h, (await api(h, "GET", "/me")).id);

// ---- fail closed: a curate party whose host never approved the set doesn't start ----------

console.log("curate party with an unreviewed set: start must cancel and refund…");
{
  const p = await api(HOST, "POST", "/parties", curateParty("Unreviewed curate party"));
  for (const h of PLAYERS.slice(0, 2)) await api(h, "POST", `/parties/${p.id}/join`);
  await promoteStart(p.id);
  const done = await waitFor(async () => { const d = await api(HOST, "GET", `/parties/${p.id}`); return d.status === "cancelled" ? d : null; }, { tries: 30 });
  ok(!!done && done.chat.some((c: any) => c.system && /didn't finish reviewing/.test(c.text)), "unreviewed curate party cancelled at start with the reason");
  for (const h of PLAYERS.slice(0, 2)) {
    const net = await partyNetKobo(userIds.get(h)!, p.id);
    ok(net === 0, `${h} refunded in full (net ${net} from that party)`);
  }
}

// ---- create + send a source file -----------------------------------------------------------

console.log("\ncurate party from a PDF sent to the API…");
const party = await api(HOST, "POST", "/parties", curateParty("Curate sim party"));
const partyId: string = party.id;
ok(party.playerCount === 0 && party.questions?.review === "host_reviewed" && party.questions?.aiGenerated === true, "curate host isn't seated; party discloses AI-generated, host-reviewed questions");
ok((await partyNetKobo(userIds.get(HOST)!, partyId)) === 0, "curate host isn't charged an entry");

const PDF = "application/pdf";
const pdf = minimalPdf(FACTS);
const notHost = await sendFile(PLAYERS[0], partyId, { filename: "x.pdf", contentType: PDF, bytes: pdf });
ok(notHost.status === 403, `only the host's team can send a file (got ${notHost.status})`);
const wrongType = await sendFile(HOST, partyId, { filename: "notes.png", contentType: "image/png", bytes: pdf });
ok(wrongType.status === 415, `a type we can't read is refused before reading (got ${wrongType.status})`);
const tooBig = await sendFile(HOST, partyId, { filename: "huge.pdf", contentType: PDF, bytes: new Uint8Array(MAX_UPLOAD_BYTES + 1) });
ok(tooBig.status === 413, `a file over ${MAX_UPLOAD_BYTES} bytes is refused (got ${tooBig.status})`);

const unreadable = await sendFile(HOST, partyId, { filename: "scan.pdf", contentType: PDF, bytes: minimalPdf(["Lagos."]) });
ok(unreadable.status === 201 && unreadable.body.status === "failed" && /enough readable text/.test(unreadable.body.error ?? ""), `a file without enough text fails with a reason for the host ("${unreadable.body.error}")`);
ok((await db.select().from(fileChunks).where(eq(fileChunks.fileId, unreadable.body.id))).length === 0, "a failed read keeps no text");

const sent = await sendFile(HOST, partyId, { filename: "Lagos bridges.pdf", contentType: PDF, bytes: pdf });
ok(sent.status === 201 && sent.body.status === "parsing", `the text is read in the request and kept as chunks (${sent.status} ${sent.body.status})`);
const fileId: string = sent.body.id;
const parsed = await waitFor(async () => (await api(HOST, "GET", `/parties/${partyId}/files`)).find((f: any) => f.id === fileId && f.status !== "parsing"));
ok(parsed?.status === "parsed", `chunks indexed by the questions service (${parsed?.status}${parsed?.error ? `: ${parsed.error}` : ""})`);
const listed = await api(HOST, "GET", `/parties/${partyId}/files`);
ok(listed.length === 1 && listed[0].id === fileId, "the new file replaced the failed one");
const chunks = await db.select().from(fileChunks).where(eq(fileChunks.fileId, fileId));
ok(chunks.length >= 1 && chunks.every((c) => c.text.length > 0 && c.embedding !== null), `file chunked and embedded (${chunks.length} chunk(s))`);

// ---- curate review --------------------------------------------------------------------------

await api(HOST, "POST", `/parties/${partyId}/drafts`);
const drafted = await waitFor(async () => { const d = await api(HOST, "GET", `/parties/${partyId}/drafts`); return d.questions.length ? d : null; });
const drafts: any[] = drafted?.questions ?? [];
ok(drafts.length === 6 && drafts.every((q) => q.status === "draft"), `4 questions + 2 reserves drafted for review (${drafts.length})`);
ok(/only from your file/.test(drafted?.specSummary ?? ""), `spec summary says the set comes from the file ("${drafted?.specSummary}")`);
const draftRows = await db.select().from(partyQuestions).where(eq(partyQuestions.partyId, partyId));
const bankRows = await db.select().from(bankQuestions).where(inArray(bankQuestions.id, draftRows.map((r) => r.sourceRef!).filter(Boolean)));
const chunkIds = new Set(chunks.map((c) => c.id));
ok(bankRows.length === draftRows.length && bankRows.every((b) => b.sourceChunkId && chunkIds.has(b.sourceChunkId)), "every drafted question cites a chunk of the uploaded file");
/** Put the correct option back into the gap: the result must be a sentence from the file. */
const filledIn = (p: any) => (/"(.*)"$/.exec(p.question)?.[1] ?? "").split("____").join(p.options[p.correctIndex]);
ok(drafts.every((q) => FACTS.includes(filledIn(q.payload))), "every draft is answerable from a sentence in the file");

ok((await call(PLAYERS[0], "GET", `/parties/${partyId}/drafts`)).status === 403, "drafts are visible to the host's team only");
const late = await sendFile(HOST, partyId, { filename: "Other.pdf", contentType: PDF, bytes: pdf });
ok(late.status === 409, `the file can't be swapped once questions are made from it (got ${late.status})`);
const [hostView] = await db.select().from(partyDraftViews).where(and(eq(partyDraftViews.partyId, partyId)));
ok(!!hostView, "viewing the drafts was recorded");

const slot = (idx: number) => drafts.find((q) => q.idx === idx && !q.reserve)!;

// approve
const approveRes = await call(HOST, "POST", `/parties/${partyId}/drafts/${slot(0).id}/approve`);
ok(approveRes.status === 204, "approve a draft");

// edit: invalid, unsafe, then a real edit
const q1 = slot(1);
ok((await call(HOST, "PATCH", `/parties/${partyId}/drafts/${q1.id}`, { payload: { ...q1.payload, correctIndex: 9 } })).status === 400, "an edit whose answer points outside the options is refused");
ok((await call(HOST, "PATCH", `/parties/${partyId}/drafts/${q1.id}`, { payload: { ...q1.payload, question: `${q1.payload.question} Bet at the casino!` } })).status === 422, "an edit that fails the safety filter is refused");
const editedQuestion = q1.payload.question.replace("Fill the gap, from the file", "Host's version — fill the gap");
ok((await call(HOST, "PATCH", `/parties/${partyId}/drafts/${q1.id}`, { payload: { ...q1.payload, question: editedQuestion }, explanation: "Edited by the host." })).status === 204, "edit a draft");
const [q1row] = await db.select().from(partyQuestions).where(eq(partyQuestions.id, q1.id));
ok(q1row.hostAuthored && q1row.sourceRef === null && q1row.status === "draft", "edited question is host-authored, out of the bank, back to draft");

// swap
const q2 = slot(2);
ok((await call(HOST, "POST", `/parties/${partyId}/drafts/${q2.id}/swap`)).status === 204, "swap a draft for a reserve");
const [swappedOut] = await db.select().from(partyQuestions).where(eq(partyQuestions.id, q2.id));
const [swappedIn] = await db.select().from(partyQuestions).where(and(eq(partyQuestions.partyId, partyId), eq(partyQuestions.idx, 2)));
ok(swappedOut.reserve && swappedOut.status === "voided" && swappedIn.id !== q2.id && !swappedIn.reserve, "swapped-out question parked as a voided reserve; a reserve took the slot");

// regenerate
const q3 = slot(3);
ok((await call(HOST, "POST", `/parties/${partyId}/drafts/${q3.id}/regenerate`)).status === 202, "ask the engine to regenerate a draft");
const regenerated = await waitFor(async () => {
  const [r] = await db.select().from(partyQuestions).where(eq(partyQuestions.id, q3.id));
  return JSON.stringify(r.payload) !== JSON.stringify(q3.payload) ? r : null;
});
ok(!!regenerated && regenerated.status === "draft" && !!regenerated.sourceRef, "regenerated draft replaced in place, from the bank-gated pipeline");

// approve everything still in draft (play order and the remaining reserve)
const toApprove = (await api(HOST, "GET", `/parties/${partyId}/drafts`)).questions.filter((q: any) => q.status === "draft");
for (const q of toApprove) await api(HOST, "POST", `/parties/${partyId}/drafts/${q.id}/approve`);
const events = await db.select().from(partyQuestionEvents).where(eq(partyQuestionEvents.partyId, partyId));
const kinds = (k: string) => events.filter((e) => e.kind === k);
ok(kinds("approve").length === 1 + toApprove.length && kinds("edit").length === 1 && kinds("swap").length === 1 && kinds("regenerate").length === 1,
  `review actions logged per party (approve ${kinds("approve").length}, edit ${kinds("edit").length}, swap ${kinds("swap").length}, regenerate ${kinds("regenerate").length})`);
ok(kinds("approve").every((e) => e.userId), "every approval records who approved");

// ---- joins: the host saw the questions, so the host can't play --------------------------------

const hostJoin = await call(HOST, "POST", `/parties/${partyId}/join`);
ok(hostJoin.status === 403, `curate host can't join as a player (${hostJoin.status} ${JSON.stringify(hostJoin.body)})`);

// A team member who opened the drafts. Brand teams arrive in step 4 (until then isHostTeam() is the
// creator alone), so record the view GET /drafts would write for them, then try to join.
const TEAM_MEMBER = "segunola";
await topUp(TEAM_MEMBER);
const teamMemberId: string = (await api(TEAM_MEMBER, "GET", "/me")).id;
await db.insert(partyDraftViews).values({ partyId, userId: teamMemberId }).onConflictDoNothing();
const teamJoin = await call(TEAM_MEMBER, "POST", `/parties/${partyId}/join`);
ok(teamJoin.status === 403 && teamJoin.body?.error === "seen_the_questions_cannot_play", `a team member who opened the drafts gets 403 on join (${teamJoin.status} ${JSON.stringify(teamJoin.body)})`);
ok((await partyNetKobo(teamMemberId, partyId)) === 0, "and is never charged an entry");
for (const h of PLAYERS) await api(h, "POST", `/parties/${partyId}/join`);

// ---- play: three players, the host watching ------------------------------------------------

const questionById = async (id: string) => (await db.select().from(partyQuestions).where(eq(partyQuestions.id, id)))[0];

type Persona = { handle: string; play: (f: QuestionFormat, p: any) => unknown; delayMs: (questionMs: number) => number };
const personas: Persona[] = [
  { handle: "ada.o", play: correctAnswer, delayMs: () => 400 },
  { handle: "kemz", play: correctAnswer, delayMs: (ms) => Math.floor(ms * 0.6) },
  { handle: "zee", play: wrongAnswer, delayMs: () => 300 },
];

const viewsSeen: { idx: number; total: number; questionId: string }[] = [];
const voidedMsgs: any[] = [];
const adaReveals: { idx: number; voided: boolean; points: number }[] = [];
let hostDisclosure: any = null;
let resolveFinal!: (rows: any[]) => void;
const finalRows = new Promise<any[]>((r) => (resolveFinal = r));

const rooms: Room[] = [];
const hostRoom = await new Client(RT).joinOrCreate(PARTY_ROOM, { partyId, devUser: HOST });
rooms.push(hostRoom);
hostRoom.onMessage(MSG.phase, (m: any) => { if (m?.questions) hostDisclosure = m.questions; });
for (const t of [MSG.question, MSG.reveal, MSG.standings, MSG.chatMessage, MSG.presence, MSG.questionVoided, MSG.error]) hostRoom.onMessage(t, () => {});
hostRoom.onMessage(MSG.finalStandings, () => {});

for (const persona of personas) {
  const room = await new Client(RT).joinOrCreate(PARTY_ROOM, { partyId, devUser: persona.handle });
  rooms.push(room);
  const isAda = persona.handle === "ada.o";

  room.onMessage(MSG.question, async (view: any) => {
    if (isAda) viewsSeen.push({ idx: view.idx, total: view.total, questionId: view.questionId });
    if (view.idx === VOID_OPEN_IDX) {
      setTimeout(() => room.send(MSG.flag, { questionId: view.questionId, reason: "wrong_answer" }), 200);
      return;
    }
    const q = await questionById(view.questionId);
    const answer = persona.play(q.format as QuestionFormat, q.payload);
    setTimeout(() => room.send(MSG.answer, answer), persona.delayMs(view.seconds * 1000));
  });
  room.onMessage(MSG.reveal, (r: any) => {
    if (isAda) adaReveals.push({ idx: r.idx, voided: r.voided, points: r.verdicts.find((v: any) => v.userId === userIds.get("ada.o"))?.points ?? 0 });
    if (r.idx === VOID_REVEAL_IDX && !r.voided) room.send(MSG.flag, { questionId: r.questionId, reason: "multiple_correct" });
  });
  room.onMessage(MSG.questionVoided, (m: any) => { if (isAda) voidedMsgs.push(m); });
  room.onMessage(MSG.finalStandings, (f: any) => { if (isAda) resolveFinal(f.rows); });
  for (const t of [MSG.standings, MSG.chatMessage, MSG.presence, MSG.phase, MSG.error]) room.onMessage(t, () => {});
}

await promoteStart(partyId);
console.log("3 players + watching host in the room; start promoted; playing with two voids (~100s)…");
const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("curate sim timed out after 240s")), 240_000));
const final = (await Promise.race([finalRows, timeout])) as any[];

// ---- assertions: the game ------------------------------------------------------------------

console.log("\nfinal standings:");
for (const r of final) {
  const handle = [...userIds.entries()].find(([, id]) => id === r.userId)?.[0] ?? r.userId;
  console.log(`  #${r.rank} ${handle.padEnd(8)} score=${String(r.score).padStart(4)}`);
}
ok(hostDisclosure?.review === "host_reviewed" && hostDisclosure?.aiGenerated === true, "room discloses AI-generated, host-reviewed questions");
ok(final.length === 3 && !final.some((r) => r.userId === userIds.get(HOST)), "the curate host watched but was never in the match");
ok(viewsSeen.map((v) => v.idx).join(",") === "0,1,2,3,4", `four questions plus one replacement were played (${viewsSeen.map((v) => v.idx).join(",")})`);
ok(voidedMsgs.length === 2, `room told twice that a question was voided (${voidedMsgs.length})`);
ok(voidedMsgs[0]?.idx === VOID_OPEN_IDX && voidedMsgs[0]?.replacementAdded === true && voidedMsgs[0]?.total === 5, "first void (while open) appended the remaining reserve");
ok(voidedMsgs[1]?.idx === VOID_REVEAL_IDX && voidedMsgs[1]?.replacementAdded === false, "second void (during reveal) had no reserve left, and said so");
const r0 = adaReveals.filter((r) => r.idx === VOID_OPEN_IDX);
ok(r0.length === 1 && r0[0].voided && r0[0].points === 0, "voided-while-open question scored nothing");
const r3 = adaReveals.filter((r) => r.idx === VOID_REVEAL_IDX);
ok(r3.length === 2 && !r3[0].voided && r3[0].points > 0 && r3[1].voided && r3[1].points === 0, `voided-in-reveal question: scored ${r3[0]?.points}, then voided to 0`);

const answers = await db.select().from(partyAnswers).where(eq(partyAnswers.partyId, partyId));
for (const h of PLAYERS) {
  const sum = answers.filter((a) => a.userId === userIds.get(h)).reduce((s, a) => s + a.points, 0);
  const row = final.find((r) => r.userId === userIds.get(h));
  ok(row?.score === sum, `${h}'s final score equals their non-voided points (${row?.score} = ${sum})`);
}
const voidedId = (idx: number) => viewsSeen.find((v) => v.idx === idx)!.questionId;
ok(answers.filter((a) => a.questionId === voidedId(VOID_REVEAL_IDX)).every((a) => a.points === 0), "stored points for the voided question were zeroed");

const evs = await db.select().from(partyQuestionEvents).where(eq(partyQuestionEvents.partyId, partyId));
const flagsOn = (id: string) => evs.filter((e) => e.kind === "flag" && e.questionId === id);
ok(flagsOn(voidedId(VOID_OPEN_IDX)).length === 3 && flagsOn(voidedId(VOID_REVEAL_IDX)).length === 3, "every flag logged with who flagged and why");
const voids = evs.filter((e) => e.kind === "void");
ok(voids.length === 2 && voids.every((v) => (v.detail as any).flaggers === 3 && (v.detail as any).threshold === 3 && (v.detail as any).playerCount === 3),
  `void logged with tally and threshold (${JSON.stringify(voids.map((v) => v.detail))})`);
const replaces = evs.filter((e) => e.kind === "replace");
ok(replaces.length === 1 && (replaces[0].detail as any).replacedQuestionId === voidedId(VOID_OPEN_IDX) && replaces[0].questionId === voidedId(4), "the swap-in is logged against the question it replaced");
const statuses = await db.select({ id: partyQuestions.id, status: partyQuestions.status }).from(partyQuestions).where(inArray(partyQuestions.id, [voidedId(VOID_OPEN_IDX), voidedId(VOID_REVEAL_IDX)]));
ok(statuses.every((s) => s.status === "voided"), "both voided questions are marked voided");

// ---- settlement, bank, retirement ------------------------------------------------------------

const settled = await waitFor(async () => { const d = await api(HOST, "GET", `/parties/${partyId}`); return d.status === "finished" ? d : null; }, { tries: 40 });
ok(!!settled, "party settled");
if (settled) {
  const [rake] = await db.select().from(ledgerEntries).where(eq(ledgerEntries.idempotencyKey, `party_rake:${partyId}`));
  ok(rake?.amountKobo === 6_000, `rake on 3 entries only — the host never paid in (${rake?.amountKobo})`);
  const winner = final.find((r) => r.rank === 1)!;
  const winnerHandle = [...userIds.entries()].find(([, id]) => id === winner.userId)![0];
  for (const h of PLAYERS) {
    const net = await partyNetKobo(userIds.get(h)!, partyId);
    const expected = h === winnerHandle ? -20_000 + 54_000 : -20_000;
    ok(net === expected, `${h} net from this party ${net} (expected ${expected})`);
  }
  ok((await partyNetKobo(userIds.get(HOST)!, partyId)) === 0, "curate host neither paid in nor won anything");
}

const voidedBankIds = (await db.select({ ref: partyQuestions.sourceRef }).from(partyQuestions).where(inArray(partyQuestions.id, [voidedId(VOID_OPEN_IDX), voidedId(VOID_REVEAL_IDX)]))).map((r) => r.ref!).filter(Boolean);
const pulled = await waitFor(async () => {
  const rows = await db.select().from(bankQuestions).where(inArray(bankQuestions.id, voidedBankIds));
  return rows.length === voidedBankIds.length && rows.every((b) => b.status === "pending_review" && b.flagCount === 3) ? rows : null;
}, { tries: 30 });
ok(voidedBankIds.length === 2 && !!pulled, "voided questions left retrieval (pending review) with their flags counted");
const playedStats = await waitFor(async () => {
  const [b] = await db.select().from(bankQuestions).where(eq(bankQuestions.id, swappedIn.sourceRef!));
  return b && b.timesPlayed >= 1 ? b : null;
}, { tries: 30 });
ok(!!playedStats && pulled?.every((b) => b.timesPlayed === 0) === true, "play stats count played questions and skip voided ones");

const schedulers = await questionsQueue().getJobSchedulers();
ok(schedulers.some((s) => s.key === "retire-sweep" || s.id === "retire-sweep"), "daily retirement sweep is scheduled");
const cfg = await getQuestionsConfig();
try {
  await setQuestionsConfig({ ...cfg, retireFlagCount: 3 }); // test-only: make 3 flags enough to retire
  await questionsQueue().add("retire_sweep", { kind: "retire_sweep" });
  const retired = await waitFor(async () => {
    const rows = await db.select().from(bankQuestions).where(inArray(bankQuestions.id, voidedBankIds));
    return rows.every((b) => b.status === "retired" && b.retiredReason === "flagged") ? rows : null;
  }, { tries: 30 });
  ok(!!retired, "retirement sweep retired the flagged questions, with the reason");
} finally {
  await setQuestionsConfig(cfg);
}

const files = await db.select().from(partyFiles).where(eq(partyFiles.partyId, partyId));
ok(files.length === 1 && files[0].status === "parsed", "one parsed source file on record for the party");

// ---- source retention -------------------------------------------------------------------------

ok(schedulers.some((s) => s.key === "source-sweep" || s.id === "source-sweep"), "daily source sweep is scheduled");
const [ended] = await db.select({ endedAt: parties.endedAt }).from(parties).where(eq(parties.id, partyId));
ok(!!ended?.endedAt, "the finished party records when it ended");
const retentionDays = (await getQuestionsConfig()).sourceRetentionDays;
await questionsQueue().add("source_sweep", { kind: "source_sweep" });
await sleep(1500);
ok((await db.select().from(fileChunks).where(eq(fileChunks.fileId, fileId))).length > 0, `chunks are kept inside the ${retentionDays}-day retention window`);
// TEST-ONLY: age the party past its window, then sweep.
await db.update(parties).set({ endedAt: new Date(Date.now() - (retentionDays + 1) * 24 * 60 * 60 * 1000) }).where(eq(parties.id, partyId));
await questionsQueue().add("source_sweep", { kind: "source_sweep" });
const swept = await waitFor(async () => ((await db.select().from(partyFiles).where(eq(partyFiles.partyId, partyId))).length === 0 ? true : null), { tries: 20 });
ok(!!swept && (await db.select().from(fileChunks).where(eq(fileChunks.fileId, fileId))).length === 0, "past the window, the sweep deletes the file record and its chunks");

await Promise.race([Promise.allSettled(rooms.map((r) => r.leave())), sleep(3000)]);
const failures = failureCount();
console.log(failures ? `\n${failures} assertion(s) FAILED` : "\nparty-sim-curate: all assertions passed");
process.exit(failures ? 1 : 0);

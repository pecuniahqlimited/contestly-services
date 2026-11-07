/**
 * Party templates and host-written questions (ADR 0015): templates prefill and edit down to empty, distractor
 * suggestions (through the real questions queue too), the safety filter failing closed on the host's words,
 * host-written questions never in the bank, forced curate and its lockout, free refused, each cap, the link check
 * (crew, contacts, played with, a recent block, install id, IP; never yourPeople()), the outlier flag on the host's
 * questions and on the whole set, newcomers and the unlinked threshold, a held prize that can't be withdrawn or
 * spent, clear and reject (two admins each, never the host or the winner; idempotent).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Worker } from "bullmq";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import {
  adminActions, adminAlerts, bankQuestions, ledgerAccounts, blocks, contactMatches, cornerNewPlayers, partyInvites, crewMembers, crews, db, getPaymentsConfig, playedWith, heldPrizes, ledger, ledgerEntries, parties, partyAnswers, partyPlayers, partyQuestions, recordSignals,
  savePartyTemplates, currentPartyTemplates, takeSeat, HoldOverdrawn, userSignals, users, blockedEitherWay, liftedBlocks, withdrawBlockReason, type Party, type User,
} from "@contestly/db";
import { makeRedis, questionsQueue, QUEUE_PREFIX } from "@contestly/queue";
import { ProviderUnavailable } from "@contestly/ai";
import {
  DEFAULT_HOST_WRITTEN_RULES, DEFAULT_PARTY_TEMPLATES, QUEUES, hostSlots, kobo, partyTemplatesResponseSchema, type DistractorRequest, type HostQuestion, type QuestionsJob,
} from "@contestly/shared";
import { addBankAccount, checkPayout, findBreaches, mockControlsOrNull, requestPayout, resetProviders, resolveAccount, submitPayout, withdrawContext, type KeyValue } from "@contestly/payments";
import { getSocialConfig } from "@contestly/db";
import { settle } from "../../worker/src/partySettle.js";
import { generateSet } from "../../questions/src/pipeline/generateSet.js";
import { recordPlay } from "../../questions/src/pipeline/recordPlay.js";
import { suggestDistractors } from "../../questions/src/pipeline/distractors.js";
import { mockProviders, selectProviders } from "../../questions/src/providers/index.js";
import { checkHostEdit } from "../../questions/src/pipeline/checkHostEdit.js";
import type { SafetyReviewer } from "../../questions/src/providers/types.js";
import { queueDistractors } from "../src/distractors.js";
import { as, makeUser, tag, testApp } from "./harness.js";

let app: Awaited<ReturnType<typeof testApp>>["app"];
const asked: DistractorRequest[] = [];
let host: User, admin: User, admin2: User;
let version: number;
let n = 0;
const name = (p: string) => `${p}${++n}`;

const ENTRY = kobo(500);
const q = (question: string, answer = "Church"): HostQuestion => ({ question, answer, distractors: ["Office", "Gym", "Wedding"] });
const pooled = (over: Record<string, unknown> = {}) => ({
  title: "Ada's 25th", brief: "Ada's birthday quiz, light and fun", funding: "pooled", entryKobo: ENTRY, maxPlayers: 8, split: "winner", mode: "curate", questionCount: 6, ...over,
});
const fund = (u: User, amountKobo: number) => db.transaction((tx) => ledger.post(tx, { userId: u.id, kind: "cash", amountKobo, type: "topup", idempotencyKey: `t:tpl:${tag}:${u.id}:${randomUUID()}` }));
const cash = async (u: User) => (await ledger.balances(u.id)).cashKobo;
/** What's in their prize hold (ADR 0015): the platform's prize_hold account for them. */
const hold = async (u: User) => (await db.select().from(ledgerAccounts).where(and(eq(ledgerAccounts.kind, "prize_hold"), eq(ledgerAccounts.scope, u.id))))[0]?.balanceKobo ?? 0;
/** The hold-account invariant: every prize hold equals that person's open held prizes. */
const holdBreaches = async () => (await findBreaches(db)).filter((b) => b.kind === "prize_hold");
const partyRow = async (id: string) => (await db.select().from(parties).where(eq(parties.id, id)))[0];
const create = (u: User, body: Record<string, unknown>) => app.inject({ method: "POST", url: "/parties", headers: as(u), payload: body });
const decide = (kind: "clear" | "reject", id: string, u: User, reason: string) => app.inject({ method: "POST", url: `/admin/party-templates/held-prizes/${id}/${kind}`, headers: as(u), payload: { reason } });
/** Every held-prize decision takes two admins (ADR 0015): `admin` asks, `admin2` confirms. The confirmation's reply. */
async function decided(kind: "clear" | "reject", id: string, reason: string) {
  expect((await decide(kind, id, admin, reason)).json()).toMatchObject({ awaitingSecondAdmin: true, prize: { status: "held" } });
  return decide(kind, id, admin2, reason);
}

beforeAll(async () => {
  ({ app } = await testApp({ distractors: async (req) => { asked.push(req); return { distractors: ["Office", "Gym", "Wedding"] }; } }));
  host = await makeUser("tplhost");
  admin = await makeUser("tpladmin", { isAdmin: true });
  admin2 = await makeUser("tpladmin2", { isAdmin: true });
  version = (await currentPartyTemplates()).version;
});
afterAll(async () => { await app.close(); });

describe("templates", () => {
  it("GET /party-templates: the seeded six in order, and the caps", async () => {
    const res = await app.inject({ method: "GET", url: "/party-templates" });
    expect(res.statusCode).toBe(200);
    const body = partyTemplatesResponseSchema.parse(res.json());
    expect(body.templates.map((t) => t.id)).toEqual(["birthday", "bridal-shower", "couples", "game-night", "office-party", "reunion"]);
    expect(body.rules).toEqual({ maxEntryKobo: DEFAULT_HOST_WRITTEN_RULES.maxEntryKobo, maxHostPrizeKobo: DEFAULT_HOST_WRITTEN_RULES.maxHostPrizeKobo, maxPotKobo: DEFAULT_HOST_WRITTEN_RULES.maxPotKobo, maxHostShareBps: 5000 });
  });

  it("a template prefills what the host left out, and the party keeps its own copy", async () => {
    await fund(host, ENTRY * 3); // no host-written questions: sealed, so the host plays and pays their entry
    const res = await create(host, { template: { id: "birthday", version }, funding: "pooled", entryKobo: ENTRY, maxPlayers: 6, split: "winner" });
    expect(res.statusCode).toBe(201);
    const p = await partyRow(res.json().id);
    const t = DEFAULT_PARTY_TEMPLATES.templates[0];
    expect(p).toMatchObject({ title: t.title, brief: t.brief, coverEmoji: t.cover.emoji, coverColor: t.cover.color, questionCount: t.dials.questionCount, questionSeconds: t.dials.secondsPerQuestion, difficulty: t.dials.difficulty, formats: t.dials.formats, hostQuestionCount: 0 });
    expect(p.template).toMatchObject({ id: "birthday", version, occasion: "birthday", themed: t.themed });
    expect(p.hostRules).toEqual(DEFAULT_HOST_WRITTEN_RULES);
    // What the host sends wins.
    const mine = await create(host, { template: { id: "birthday", version }, title: "Ada turns 25", coverEmoji: "🥳", funding: "pooled", entryKobo: ENTRY, maxPlayers: 6, split: "winner" });
    expect(await partyRow(mine.json().id)).toMatchObject({ title: "Ada turns 25", coverEmoji: "🥳", brief: t.brief });
    // A version that doesn't have it is refused.
    expect((await create(host, { template: { id: "nope", version }, funding: "pooled", entryKobo: ENTRY, maxPlayers: 6, split: "winner" })).json().error).toBe("template_not_found");
  });

  it("everything stays editable: host questions written at creation, edited, and removed down to an empty set", async () => {
    const res = await create(host, pooled({ template: { id: "bridal-shower", version }, hostQuestions: [q("Where did Tolu and Femi first meet?"), q("Who said I love you first?", "Femi")] }));
    expect(res.statusCode).toBe(201);
    const id = res.json().id;
    expect(res.json().questions).toMatchObject({ hostWritten: true, review: "host_reviewed" });
    const rows = await db.select().from(partyQuestions).where(eq(partyQuestions.partyId, id));
    expect(rows).toHaveLength(2);
    // Drafts until the model safety check passes them (below), then approved: the host wrote them.
    expect(rows.every((r) => r.hostWritten && r.hostAuthored && r.sourceRef === null && r.format === "pick_one" && r.status === "draft" && (r.editCheck as { status: string }).status === "checking")).toBe(true);
    const first = rows.find((r) => (r.payload as { question: string }).question.startsWith("Where"))!;
    const put = await app.inject({ method: "PUT", url: `/parties/${id}/host-questions/${first.id}`, headers: as(host), payload: { ...q("Where did Tolu and Femi meet?", "Choir practice"), distractors: ["Bible study", "A wedding", "Work"] } });
    expect(put.statusCode).toBe(204);
    const edited = (await db.select().from(partyQuestions).where(eq(partyQuestions.id, first.id)))[0].payload as { options: string[]; correctIndex: number };
    expect(edited.options[edited.correctIndex]).toBe("Choir practice");
    expect(edited.correctIndex).toBe((first.payload as { correctIndex: number }).correctIndex); // the right answer didn't move
    for (const r of rows) expect((await app.inject({ method: "DELETE", url: `/parties/${id}/host-questions/${r.id}`, headers: as(host) })).statusCode).toBe(204);
    const p = await partyRow(id);
    expect(p.hostQuestionCount).toBe(0);
    expect((await app.inject({ method: "GET", url: `/parties/${id}` })).json().questions.hostWritten).toBe(false);
    // And added back to the same party.
    const add = await app.inject({ method: "POST", url: `/parties/${id}/host-questions`, headers: as(host), payload: q("What is Tolu's pet name for Femi?", "Baby") });
    expect(add.statusCode).toBe(201);
    expect((await partyRow(id)).hostQuestionCount).toBe(1);
    // Only the host's team.
    const other = await makeUser(name("tplother"));
    expect((await app.inject({ method: "POST", url: `/parties/${id}/host-questions`, headers: as(other), payload: q("Anything?") })).statusCode).toBe(403);
  });

  it("an admin saves a new version (logged, with a reason): hide, reorder, preview", async () => {
    const before = await currentPartyTemplates();
    const [birthday, ...rest] = before.config.templates;
    const config = { ...before.config, templates: [...rest, { ...birthday, hidden: true }] };
    expect((await app.inject({ method: "PUT", url: "/admin/party-templates", headers: as(host), payload: { config, reason: "test" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: "/admin/party-templates", headers: as(admin), payload: { config } })).statusCode).toBe(400); // a reason is required
    const saved = await app.inject({ method: "PUT", url: "/admin/party-templates", headers: as(admin), payload: { config, reason: "Birthday rests for a week" } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().version).toBe(before.version + 1);
    const offered = (await app.inject({ method: "GET", url: "/party-templates" })).json();
    expect(offered.templates.map((t: { id: string }) => t.id)).toEqual(["bridal-shower", "couples", "game-night", "office-party", "reunion"]);
    const [log] = await db.select().from(adminActions).where(and(eq(adminActions.action, "config.party_templates"), eq(adminActions.adminUserId, admin.id)));
    expect(log.reason).toBe("Birthday rests for a week");
    const preview = await app.inject({ method: "POST", url: "/admin/party-templates/preview", headers: as(admin), payload: { templateId: "bridal-shower" } });
    expect(preview.json()).toMatchObject({ hostQuestionsAllowed: 6, problems: [], prefill: { title: "Bridal shower quiz" } });
    const tooMany = { ...config, templates: config.templates.map((t) => (t.id === "couples" ? { ...t, dials: { ...t.dials, questionCount: 4 } } : t)) };
    expect((await app.inject({ method: "POST", url: "/admin/party-templates/preview", headers: as(admin), payload: { templateId: "couples", config: tooMany } })).json().problems).toHaveLength(1);
    // Put it back as it was (a new version, as every save is).
    await db.transaction((tx) => savePartyTemplates(tx, before.config, admin.id));
  });
});

describe("distractors", () => {
  it("suggests three through the questions service's suggester", async () => {
    const res = await app.inject({ method: "POST", url: "/parties/host-questions/distractors", headers: as(host), payload: { question: "Where did Tolu and Femi first meet?", answer: "Church", brief: "a bridal shower" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ distractors: ["Office", "Gym", "Wedding"] });
    expect(asked.at(-1)).toMatchObject({ question: "Where did Tolu and Femi first meet?", answer: "Church" });
  });

  it("over the real questions queue: the generation call, then the safety filter", async () => {
    const providers = selectProviders();
    const worker = new Worker<QuestionsJob>(QUEUES.questions, async (job) => (job.data.kind === "suggest_distractors" ? suggestDistractors(job.data, { generator: providers.generator, safety: providers.safety }) : undefined), { connection: makeRedis(), prefix: QUEUE_PREFIX });
    try {
      const out = await queueDistractors({ question: "What year did we graduate?", answer: "2009", brief: "" });
      expect(out.distractors).toHaveLength(3);
      expect(out.distractors).not.toContain("2009");
      // The service refuses unsafe host words too (the route checks first; this is the service's own check).
      await expect(queueDistractors({ question: "Which casino did they meet in?", answer: "The casino", brief: "" })).rejects.toMatchObject({ statusCode: 422, message: "host_text_unsafe" });
    } finally {
      await worker.close();
    }
  });
});

describe("the safety filter fails closed on the host's own words", () => {
  it("refuses at creation, on add, on edit and before any suggestion, naming which question", async () => {
    const before = asked.length;
    const sug = await app.inject({ method: "POST", url: "/parties/host-questions/distractors", headers: as(host), payload: { question: "Who did they vote for in the election?", answer: "Nobody" } });
    expect(sug.statusCode).toBe(422);
    expect(sug.json()).toMatchObject({ error: "host_text_unsafe", details: { reasons: ["politics"] } });
    expect(asked.length).toBe(before); // never reached the questions service

    const made = await create(host, pooled({ hostQuestions: [q("Where did they meet?"), q("Their favourite bar for a free beer?", "Spot")] }));
    expect(made.statusCode).toBe(422);
    expect(made.json()).toMatchObject({ error: "host_text_unsafe", details: { index: 1, reasons: ["alcohol_promo"] } });

    const ok = await create(host, pooled({ hostQuestions: [q("Where did they meet?")] }));
    const id = ok.json().id;
    expect((await app.inject({ method: "POST", url: `/parties/${id}/host-questions`, headers: as(host), payload: q("Best casino in town?", "Eko") })).json().error).toBe("host_text_unsafe");
    // The brief's own exclusions hold for the host's words too.
    const strict = await create(host, pooled({ brief: "A wedding quiz, nothing about exes", hostQuestions: [q("Which of the exes came to the wedding?", "Tunde")] }));
    expect(strict.json()).toMatchObject({ error: "host_text_unsafe", details: { reasons: ["excluded:exes"] } });
    const [row] = await db.select().from(partyQuestions).where(eq(partyQuestions.partyId, id));
    expect((await app.inject({ method: "PUT", url: `/parties/${id}/host-questions/${row.id}`, headers: as(host), payload: q("Where did they shit?") })).json().error).toBe("host_text_unsafe");
  });
});

describe("the model safety check on the host's own words", () => {
  type Check = { id: string; status: string; reasons: string[] };
  const rowsOf = (partyId: string) => db.select().from(partyQuestions).where(and(eq(partyQuestions.partyId, partyId), eq(partyQuestions.hostWritten, true)));
  const checkOf = (r: { editCheck: unknown }) => r.editCheck as Check;
  /** The questions service's check_host_edit, run here with this reviewer. */
  const runCheck = (r: { partyId: string; id: string; editCheck: unknown }, safety: SafetyReviewer) => checkHostEdit({ partyId: r.partyId, partyQuestionId: r.id, checkId: checkOf(r).id }, { providers: { ...mockProviders(), safety } });
  const passing: SafetyReviewer = { name: "pass", review: async (_b, items) => items.map(() => ({ passed: true, reasons: [] })) };
  const failing: SafetyReviewer = { name: "fail", review: async (_b, items) => items.map(() => ({ passed: false, reasons: ["model:private_individual"] })) };

  it("queued at creation, on add and on edit; a pass approves, a fail leaves a draft, told it's host-written", async () => {
    const made = await create(host, pooled({ hostQuestions: [q("Where did Tolu and Femi first meet?"), q("Who proposed?", "Femi")] }));
    const [a, b] = await rowsOf(made.json().id);
    for (const r of [a, b]) expect(await questionsQueue().getJob(`check-edit-${checkOf(r).id}`)).toBeTruthy();
    let told: { hostWritten?: boolean } = {};
    await runCheck(a, { name: "spy", review: async (brief, items) => { told = brief; return items.map(() => ({ passed: true, reasons: [] })); } });
    await runCheck(b, failing);
    expect(told.hostWritten).toBe(true);
    const [a2, b2] = [(await rowsOf(a.partyId)).find((r) => r.id === a.id)!, (await rowsOf(a.partyId)).find((r) => r.id === b.id)!];
    expect([a2.status, checkOf(a2).status]).toEqual(["pending", "passed"]);
    expect([b2.status, checkOf(b2).status, checkOf(b2).reasons]).toEqual(["draft", "failed", ["model:private_individual"]]);
    // The drafts view shows the host which one failed, and why.
    const drafts = (await app.inject({ method: "GET", url: `/parties/${a.partyId}/drafts`, headers: as(host) })).json();
    expect(drafts.questions.find((d: { id: string }) => d.id === b.id)?.editCheck).toEqual({ status: "failed", reasons: ["model:private_individual"] });

    // Rewriting it: a draft again with a new check, and the old check's late answer changes nothing.
    expect((await app.inject({ method: "PUT", url: `/parties/${a.partyId}/host-questions/${b.id}`, headers: as(host), payload: q("Who proposed to whom?", "Femi") })).statusCode).toBe(204);
    const b3 = (await rowsOf(a.partyId)).find((r) => r.id === b.id)!;
    expect([b3.status, checkOf(b3).status]).toEqual(["draft", "checking"]);
    expect(checkOf(b3).id).not.toBe(checkOf(b).id);
    await runCheck(b2, passing); // the superseded check
    expect((await rowsOf(a.partyId)).find((r) => r.id === b.id)!.status).toBe("draft");
    await runCheck(b3, passing);
    expect((await rowsOf(a.partyId)).find((r) => r.id === b.id)!.status).toBe("pending");

    // Added later: the same.
    const added = await app.inject({ method: "POST", url: `/parties/${a.partyId}/host-questions`, headers: as(host), payload: q("Where was the engagement?", "Lekki") });
    const c = (await rowsOf(a.partyId)).find((r) => r.id === added.json().id)!;
    expect([c.status, checkOf(c).status]).toEqual(["draft", "checking"]);
    expect(await questionsQueue().getJob(`check-edit-${checkOf(c).id}`)).toBeTruthy();
  });

  it("fails closed: a check that can't run leaves the question a draft (failed, safety_unavailable), so the party can't start on it", async () => {
    const made = await create(host, pooled({ hostQuestions: [q("Where did they first meet?")] }));
    const [r] = await rowsOf(made.json().id);
    await runCheck(r, { name: "down", review: async () => { throw new ProviderUnavailable("timeout", "fake", "safety", "timed out"); } });
    const [after] = await rowsOf(r.partyId);
    expect([after.status, checkOf(after).status, checkOf(after).reasons]).toEqual(["draft", "failed", ["safety_unavailable"]]);
  });
});

describe("curate is forced, with its lockout", () => {
  it("a sealed request with host-written questions is made curate: the host isn't seated and can't join", async () => {
    const res = await create(host, pooled({ mode: "sealed", hostQuestions: [q("Where did they meet?")] }));
    expect(res.statusCode).toBe(201);
    const id = res.json().id;
    expect((await partyRow(id)).mode).toBe("curate");
    expect(await db.select().from(partyPlayers).where(eq(partyPlayers.partyId, id))).toHaveLength(0);
    await fund(host, ENTRY);
    expect((await app.inject({ method: "POST", url: `/parties/${id}/join`, headers: as(host) })).json().error).toBe("seen_the_questions_cannot_play");
    const player = await makeUser(name("tplplayer"));
    await fund(player, ENTRY);
    expect((await app.inject({ method: "POST", url: `/parties/${id}/join`, headers: as(player) })).statusCode).toBe(201);
    const detail = (await app.inject({ method: "GET", url: `/parties/${id}`, headers: as(player) })).json();
    expect(detail.questions).toMatchObject({ hostWritten: true, review: "host_reviewed", aiGenerated: true });
  });

  it("a sealed party can't take host-written questions later", async () => {
    await fund(host, ENTRY);
    const res = await create(host, pooled({ mode: "sealed" }));
    expect((await app.inject({ method: "POST", url: `/parties/${res.json().id}/host-questions`, headers: as(host), payload: q("Where did they meet?") })).json().error).toBe("sealed_party_no_host_questions");
  });
});

describe("stakes", () => {
  it("never free: a template party, or one with host-written questions (at creation and when added)", async () => {
    expect((await create(host, pooled({ template: { id: "game-night", version }, entryKobo: 0 }))).json().error).toBe("template_party_cannot_be_free");
    expect((await create(host, pooled({ entryKobo: 0, hostQuestions: [q("Who won last time?", "Ada")] }))).json().error).toBe("host_written_party_cannot_be_free");
    const free = await create(host, pooled({ entryKobo: 0 }));
    expect(free.statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `/parties/${free.json().id}/host-questions`, headers: as(host), payload: q("Who won last time?", "Ada") })).json().error).toBe("host_written_party_cannot_be_free");
  });

  it("each cap: the entry, the host's cash prize, and the host's share", async () => {
    const rules = DEFAULT_HOST_WRITTEN_RULES;
    expect((await create(host, pooled({ entryKobo: rules.maxEntryKobo + kobo(100), hostQuestions: [q("Who won last time?", "Ada")] }))).json().error).toBe("curate_entry_above_cap");
    // A sealed party isn't capped (a plain curate one is: below).
    await fund(host, rules.maxEntryKobo + kobo(100));
    expect((await create(host, pooled({ mode: "sealed", entryKobo: rules.maxEntryKobo + kobo(100) }))).statusCode).toBe(201);
    const prize = { funding: "host", entryKobo: 0, hostPoolKobo: rules.maxHostPrizeKobo + kobo(100) };
    await fund(host, rules.maxHostPrizeKobo + kobo(100));
    expect((await create(host, pooled({ ...prize, hostQuestions: [q("Who won last time?", "Ada")] }))).json().error).toBe("curate_prize_above_cap");
    // The pot: ₦1,000 entry is under its cap, but 60 seats of it is over the pot's.
    expect((await create(host, pooled({ entryKobo: rules.maxEntryKobo, maxPlayers: 60, hostQuestions: [q("Who won last time?", "Ada")] }))).json().error).toBe("curate_pot_above_cap");
    expect((await create(host, pooled({ entryKobo: rules.maxEntryKobo, maxPlayers: Math.floor(rules.maxPotKobo / rules.maxEntryKobo), hostQuestions: [q("Who won last time?", "Ada")] }))).statusCode).toBe(201);
    // (A curate party over the pot cap can't be made, with host-written questions or without, so none takes one later.)
    // Four questions: at most two host-written.
    const share = [q("Who won last time?", "Ada"), q("Who lost?", "Bayo"), q("Who cheated?", "Chi")];
    expect((await create(host, pooled({ questionCount: 4, hostQuestions: share }))).json().error).toBe("host_written_share_above_cap");
    const two = await create(host, pooled({ questionCount: 4, hostQuestions: share.slice(0, 2) }));
    expect(two.statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `/parties/${two.json().id}/host-questions`, headers: as(host), payload: share[2] })).json().error).toBe("host_written_share_above_cap");
  });
});

describe("host-written questions never enter the bank", () => {
  it("the engine drafts around them, spread through the play order; nothing of theirs is banked or counted in play stats", async () => {
    const texts = ["What is Ada's go-to order?", "Which city was Ada born in?"];
    const res = await create(host, pooled({ questionCount: 6, formats: ["pick_one"], hostQuestions: texts.map((t) => q(t, "Ibadan")) }));
    const id = res.json().id;
    expect((await app.inject({ method: "POST", url: `/parties/${id}/drafts`, headers: as(host) })).statusCode).toBe(202);
    await generateSet(id, { providers: selectProviders(), publish: async () => undefined });
    const order = await db.select().from(partyQuestions).where(and(eq(partyQuestions.partyId, id), eq(partyQuestions.reserve, false))).orderBy(partyQuestions.idx);
    expect(order).toHaveLength(6);
    expect(order.map((r, i) => (r.hostWritten ? i : -1)).filter((i) => i >= 0)).toEqual(hostSlots(6, 2));
    expect(order.filter((r) => !r.hostWritten).every((r) => r.sourceRef && r.status === "draft")).toBe(true);
    for (const t of texts) {
      const [{ c }] = await db.select({ c: sql<number>`count(*)::int` }).from(bankQuestions).where(sql`${bankQuestions.payload}->>'question' = ${t}`);
      expect(c).toBe(0);
    }
    // The drafts carry the flag for the host's review.
    const drafts = (await app.inject({ method: "GET", url: `/parties/${id}/drafts`, headers: as(host) })).json();
    expect(drafts.questions.filter((d: { hostWritten: boolean }) => d.hostWritten)).toHaveLength(2);
    // Play stats after a finish: only the bank questions move.
    const banked = order.filter((r) => !r.hostWritten);
    const player = await makeUser(name("tplstats"));
    await db.update(partyQuestions).set({ status: "played" }).where(eq(partyQuestions.partyId, id));
    await db.insert(partyAnswers).values(order.map((r) => ({ partyId: id, questionId: r.id, userId: player.id, correctness: 100, points: 100 })));
    const before = await db.select({ id: bankQuestions.id, timesPlayed: bankQuestions.timesPlayed }).from(bankQuestions).where(inArray(bankQuestions.id, banked.map((b) => b.sourceRef!)));
    await db.update(parties).set({ status: "finished" }).where(eq(parties.id, id));
    await recordPlay(id);
    const after = await db.select({ id: bankQuestions.id, timesPlayed: bankQuestions.timesPlayed }).from(bankQuestions).where(inArray(bankQuestions.id, banked.map((b) => b.sourceRef!)));
    expect(after.reduce((a, b) => a + b.timesPlayed, 0)).toBe(before.reduce((a, b) => a + b.timesPlayed, 0) + banked.length);
  });
});

// ---- settlement: the link check, the outlier flag, the hold, clear and reject -------------------------------------

const settled: string[] = [];
const settleDeps = { emit: async () => undefined, publishLine: async () => undefined, queueRecordPlay: async () => undefined, queueRecordProgress: async () => undefined };

/**
 * A live party with host-written questions as the room leaves it: every seat paid and ranked in the order given,
 * two host-written and two themed questions played, with each seat's correctness on them ([host, host, themed, themed]).
 */
async function playedParty(opts: { hostUser: User; seats: { u: User; correct: number[] }[]; funding?: "pooled" | "host"; hostPoolKobo?: number; split?: number[]; hostWritten?: boolean; beforeSettle?: (p: Party) => Promise<unknown> }): Promise<Party> {
  const hostWritten = opts.hostWritten ?? true;
  const funding = opts.funding ?? "pooled";
  const [p] = await db.insert(parties).values({
    createdByUserId: opts.hostUser.id, title: `Held ${randomUUID().slice(0, 6)}`, category: "General knowledge", entryKobo: funding === "pooled" ? ENTRY : 0, maxPlayers: 10,
    funding, hostPoolKobo: opts.hostPoolKobo ?? 0, split: opts.split ?? [100], mode: "curate", status: "live", startsAt: new Date(), liveAt: new Date(), questionsStatus: "ready",
    hostRules: DEFAULT_HOST_WRITTEN_RULES, hostQuestionCount: hostWritten ? 2 : 0,
  }).returning();
  if (funding === "host") {
    await fund(opts.hostUser, opts.hostPoolKobo!);
    await db.transaction((tx) => ledger.hold(tx, { userId: opts.hostUser.id, amountKobo: opts.hostPoolKobo!, type: "party_fund", refType: "party", refId: p.id, idempotencyKey: `party_fund:${p.id}` }));
  }
  for (const [i, s] of opts.seats.entries()) {
    if (funding === "pooled") await fund(s.u, ENTRY);
    await db.transaction((tx) => takeSeat(tx, p, s.u.id, p.entryKobo));
    await db.update(partyPlayers).set({ rank: i + 1, score: 1000 - i }).where(and(eq(partyPlayers.partyId, p.id), eq(partyPlayers.userId, s.u.id)));
  }
  for (let idx = 0; idx < 4; idx++) {
    const [pq] = await db.insert(partyQuestions).values({ partyId: p.id, idx, format: "pick_one", payload: { question: `q${idx}`, options: ["a", "b"], correctIndex: 0 }, seconds: 10, status: "played", hostWritten: hostWritten && idx < 2, hostAuthored: hostWritten && idx < 2 }).returning();
    await db.insert(partyAnswers).values(opts.seats.map((s) => ({ partyId: p.id, questionId: pq.id, userId: s.u.id, correctness: s.correct[idx], points: s.correct[idx] })));
  }
  await opts.beforeSettle?.(p);
  await settle(settleDeps, p.id);
  settled.push(p.id);
  return (await partyRow(p.id))!;
}
/**
 * An established account, so the newcomer rule doesn't apply: older than newAccountDays, with minFinishedParties
 * finished parties behind it (hosted by someone unrelated, nothing won).
 */
async function settledUser(label: string): Promise<User> {
  const u = await makeUser(name(label), { createdAt: new Date(Date.now() - (DEFAULT_HOST_WRITTEN_RULES.newAccountDays + 30) * 86_400_000) });
  for (let i = 0; i < DEFAULT_HOST_WRITTEN_RULES.minFinishedParties; i++) {
    const [old] = await db.insert(parties).values({
      createdByUserId: admin.id, title: `Past ${randomUUID().slice(0, 6)}`, category: "General knowledge", entryKobo: 0, maxPlayers: 10, funding: "pooled", split: [100],
      status: "finished", startsAt: new Date(Date.now() - 40 * 86_400_000), endedAt: new Date(Date.now() - 40 * 86_400_000),
    }).returning();
    await db.insert(partyPlayers).values({ partyId: old.id, userId: u.id });
  }
  return u;
}
const heldIn = (partyId: string) => db.select().from(heldPrizes).where(eq(heldPrizes.partyId, partyId));
const ACE = [100, 100, 0, 0];
const MISS = [0, 0, 100, 100];

describe("the link check and the outlier flag at settlement", () => {
  it("holds a winner who is the host's contact and beat the room on the host's questions (and alerts)", async () => {
    const h = await makeUser(name("hosta"));
    const [w, a, b] = [await makeUser(name("wina")), await makeUser(name("pa")), await makeUser(name("pb"))];
    await db.insert(contactMatches).values({ userId: h.id, contactUserId: w.id });
    const p = await playedParty({ hostUser: h, seats: [{ u: w, correct: ACE }, { u: a, correct: MISS }, { u: b, correct: MISS }] });
    expect(p.status).toBe("finished");
    const [held] = await heldIn(p.id);
    expect(held).toMatchObject({ userId: w.id, hostUserId: h.id, place: 1, status: "held", amountKobo: (await db.select().from(partyPlayers).where(and(eq(partyPlayers.partyId, p.id), eq(partyPlayers.userId, w.id))))[0].prizeKobo });
    expect(held.evidence).toMatchObject({ links: ["contact"], hostQuestionsPlayed: 2, winnerAccuracyPct: 100, roomAccuracyPct: 0, questionsPlayed: 4, winnerAllAccuracyPct: 50, roomAllAccuracyPct: 50, flaggedOn: ["host_written"] });
    // Won, but into their prize hold, not their cash (their entry came from cash).
    expect([await cash(w), await hold(w)]).toEqual([0, held.amountKobo]);
    const [entry] = await db.select().from(ledgerEntries).where(eq(ledgerEntries.idempotencyKey, `party_prize:${p.id}:${w.id}`));
    expect(entry.amountKobo).toBe(held.amountKobo);
    expect(await holdBreaches()).toEqual([]);
    const [alert] = await db.select().from(adminAlerts).where(eq(adminAlerts.dedupeKey, `prize_held:${held.id}`));
    expect(alert).toMatchObject({ kind: "templates.prize_held", severity: "warning", refId: p.id });
  });

  it("links by the same install id, and by the same IP", async () => {
    for (const kind of ["install", "ip"] as const) {
      const h = await makeUser(name(`host${kind}`));
      const w = await makeUser(name(`win${kind}`));
      const signal = kind === "install" ? { installId: `inst-${randomUUID()}` } : { ip: `2001:db8::${randomUUID().slice(0, 4)}` };
      await recordSignals(h.id, signal);
      await recordSignals(w.id, signal);
      const p = await playedParty({ hostUser: h, seats: [{ u: w, correct: ACE }, { u: await makeUser(name("px")), correct: MISS }] });
      expect((await heldIn(p.id))[0]?.evidence.links).toEqual([kind]);
    }
  });

  it("pays as normal: an established, unlinked winner below the unlinked threshold, and a linked one within the margin on both", async () => {
    const h = await makeUser(name("hostc"));
    // 40 points above the room on the host's questions: over the linked margin (30), under the unlinked one (50).
    const ahead = [100, 100, 50, 50], behind = [50, 70, 50, 50];
    const stranger = await settledUser("stranger");
    const p1 = await playedParty({ hostUser: h, seats: [{ u: stranger, correct: ahead }, { u: await makeUser(name("py")), correct: behind }] });
    expect(await heldIn(p1.id)).toEqual([]);
    const friend = await makeUser(name("friend"));
    await db.insert(contactMatches).values({ userId: friend.id, contactUserId: h.id }); // either way makes them contacts
    // 50% against 50%, on the host's questions and on the set.
    const p2 = await playedParty({ hostUser: h, seats: [{ u: friend, correct: [100, 0, 100, 0] }, { u: await makeUser(name("pz")), correct: [0, 100, 0, 100] }] });
    expect(await heldIn(p2.id)).toEqual([]);
  });

  it("newcomers: a new account, or an old one with few finished parties, is checked as if linked, invited or not", async () => {
    const ahead = [100, 100, 50, 50], behind = [50, 70, 50, 50];
    const fresh = await makeUser(name("fresh")); // a new account from the Parties tab: no invite, no ties
    const p1 = await playedParty({ hostUser: await makeUser(name("hostn")), seats: [{ u: fresh, correct: ahead }, { u: await makeUser(name("pn")), correct: behind }] });
    const [held] = await heldIn(p1.id);
    expect(held?.evidence).toMatchObject({ links: [], newcomer: true, finishedParties: 0, marginPct: 40, flaggedOn: ["host_written"] });
    // Old, but hardly played: still a newcomer.
    const quiet = await makeUser(name("quiet"), { createdAt: new Date(Date.now() - 365 * 86_400_000) });
    const p2 = await playedParty({ hostUser: await makeUser(name("hostq")), seats: [{ u: quiet, correct: ahead }, { u: await makeUser(name("pq")), correct: behind }] });
    expect((await heldIn(p2.id))[0]?.evidence).toMatchObject({ newcomer: true, flaggedOn: ["host_written"] });
    // Level with the room: paid like anyone.
    const p3 = await playedParty({ hostUser: await makeUser(name("hoste")), seats: [{ u: await makeUser(name("fresh")), correct: [100, 0, 100, 0] }, { u: await makeUser(name("pe")), correct: [0, 100, 0, 100] }] });
    expect(await heldIn(p3.id)).toEqual([]);
  });

  it("anyone at or above the unlinked threshold is held, linked or not, established or not", async () => {
    const pro = await settledUser("pro");
    const p = await playedParty({ hostUser: await makeUser(name("hostf")), seats: [{ u: pro, correct: ACE }, { u: await makeUser(name("pf")), correct: MISS }] });
    const [held] = await heldIn(p.id);
    expect(held?.evidence).toMatchObject({ links: [], newcomer: false, marginPct: 100, unlinkedThresholdPct: DEFAULT_HOST_WRITTEN_RULES.unlinkedMarginPct, flaggedOn: ["host_written"] });
    const [alert] = await db.select().from(adminAlerts).where(eq(adminAlerts.dedupeKey, `prize_held:${held.id}`));
    expect(alert.subject).toBe("A prize is held: a winner far above the room");
  });

  it("holds on the whole set: level on the host's questions, far ahead on the generated ones (a curate host knows them too)", async () => {
    const h = await makeUser(name("hostall"));
    const w = await makeUser(name("winall"));
    await db.insert(contactMatches).values({ userId: h.id, contactUserId: w.id });
    const p = await playedParty({ hostUser: h, seats: [{ u: w, correct: [100, 0, 100, 100] }, { u: await makeUser(name("pall")), correct: [100, 0, 0, 0] }] });
    const [held] = await heldIn(p.id);
    expect(held?.evidence).toMatchObject({ marginPct: 0, allMarginPct: 50, flaggedOn: ["all"] });
  });
});

describe("curate parties without host-written questions (their host saw every generated answer)", () => {
  it("take the caps: entry, host prize and pot; a free one, or a sealed one, doesn't", async () => {
    const rules = DEFAULT_HOST_WRITTEN_RULES;
    expect((await create(host, pooled({ entryKobo: rules.maxEntryKobo + kobo(100) }))).json().error).toBe("curate_entry_above_cap");
    expect((await create(host, pooled({ entryKobo: rules.maxEntryKobo, maxPlayers: 60 }))).json().error).toBe("curate_pot_above_cap");
    await fund(host, rules.maxHostPrizeKobo + kobo(100));
    expect((await create(host, pooled({ funding: "host", entryKobo: 0, prizeKind: "cash", hostPoolKobo: rules.maxHostPrizeKobo + kobo(100), split: "winner" }))).json().error).toBe("curate_prize_above_cap");
    expect((await create(host, pooled({ entryKobo: 0 }))).statusCode).toBe(201);
    await fund(host, rules.maxEntryKobo + kobo(100));
    expect((await create(host, pooled({ mode: "sealed", entryKobo: rules.maxEntryKobo + kobo(100) }))).statusCode).toBe(201);
  });

  it("get the settlement check: a linked winner far above the room on the set is held", async () => {
    const h = await makeUser(name("hostcur"));
    const w = await makeUser(name("wincur"));
    await db.insert(contactMatches).values({ userId: h.id, contactUserId: w.id });
    const p = await playedParty({ hostUser: h, hostWritten: false, seats: [{ u: w, correct: [100, 100, 100, 0] }, { u: await makeUser(name("pcur")), correct: [0, 0, 100, 0] }] });
    expect(p.hostQuestionCount).toBe(0);
    const [held] = await heldIn(p.id);
    expect(held?.evidence).toMatchObject({ links: ["contact"], hostQuestionsPlayed: 0, allMarginPct: 50, flaggedOn: ["all"] });
  });
});

describe("repeat winners", () => {
  it("a winner who keeps winning the same host's host-written parties is held on the next, unlinked and level with the room", async () => {
    const h = await makeUser(name("hostrep"));
    const w = await makeUser(name("winrep"));
    // Even with the room on every question, and no link: only the repeat can hold it.
    const play = async () => playedParty({ hostUser: h, seats: [{ u: w, correct: [100, 0, 100, 0] }, { u: await makeUser(name("prep")), correct: [0, 100, 0, 100] }] });
    for (let i = 0; i < DEFAULT_HOST_WRITTEN_RULES.repeatWinsMax; i++) expect(await heldIn((await play()).id)).toEqual([]);
    const third = await play();
    const [held] = await heldIn(third.id);
    expect(held?.evidence).toMatchObject({ links: [], flaggedOn: ["repeat"], priorWins: DEFAULT_HOST_WRITTEN_RULES.repeatWinsMax, repeatWinsMax: DEFAULT_HOST_WRITTEN_RULES.repeatWinsMax });
    // A different host's party is a fresh count; wins older than the window don't count.
    expect(await heldIn((await playedParty({ hostUser: await makeUser(name("hostrep2")), seats: [{ u: w, correct: [100, 0, 100, 0] }, { u: await makeUser(name("prep2")), correct: [0, 100, 0, 100] }] })).id)).toEqual([]);
    await db.update(parties).set({ endedAt: new Date(Date.now() - (DEFAULT_HOST_WRITTEN_RULES.repeatWindowDays + 1) * 86_400_000) }).where(and(eq(parties.createdByUserId, h.id), sql`${parties.id} <> ${third.id}`));
    // Only the third win (held, still a win) is inside the window now: 1, under the max.
    expect(await heldIn((await play()).id)).toEqual([]);
  });
});

describe("the link check reads the raw relationships, blocks included", () => {
  const linkOf = async (setUp: (h: User, w: User) => Promise<unknown>, opts: { winner?: Partial<typeof users.$inferInsert>; beforeSettle?: (p: Party, h: User, w: User) => Promise<unknown>; correct?: number[][] } = {}) => {
    const h = await makeUser(name("hostl"));
    const w = await makeUser(name("winl"), opts.winner);
    await setUp(h, w);
    const [mine, theirs] = opts.correct ?? [ACE, MISS];
    const p = await playedParty({ hostUser: h, seats: [{ u: w, correct: mine }, { u: await makeUser(name("pl")), correct: theirs }], beforeSettle: opts.beforeSettle && ((party) => opts.beforeSettle!(party, h, w)) });
    return (await heldIn(p.id))[0]?.evidence.links ?? [];
  };
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
  const pair = (a: User, b: User) => (a.id < b.id ? { userA: a.id, userB: b.id } : { userA: b.id, userB: a.id });

  it("crew mates", async () => {
    expect(await linkOf(async (h, w) => {
      const [c] = await db.insert(crews).values({ name: `Crew ${randomUUID().slice(0, 6)}`, emoji: "🎉", color: "#7B5CFF", createdByUserId: h.id }).returning();
      await db.insert(crewMembers).values([{ crewId: c.id, userId: h.id, role: "creator" }, { crewId: c.id, userId: w.id, role: "member" }]);
    })).toEqual(["crew"]);
  });

  it("played together within yourPeopleDays, not before", async () => {
    const { yourPeopleDays } = await getSocialConfig();
    expect(await linkOf((h, w) => db.insert(playedWith).values({ ...pair(h, w), parties: 1, lastPlayedAt: daysAgo(yourPeopleDays - 1) }))).toEqual(["played_with"]);
    expect(await linkOf((h, w) => db.insert(playedWith).values({ ...pair(h, w), parties: 1, lastPlayedAt: daysAgo(yourPeopleDays + 1) }))).toEqual([]);
  });

  it("a block doesn't hide a link: contacts who blocked each other long ago are still contacts", async () => {
    expect(await linkOf(async (h, w) => {
      await db.insert(contactMatches).values({ userId: h.id, contactUserId: w.id });
      await db.insert(blocks).values({ blockerId: h.id, blockedId: w.id, createdAt: daysAgo(60) });
    })).toEqual(["contact"]);
  });

  it("invited_new: a young account in through the host's invite (to this party) or referral; an old account or no invite isn't", async () => {
    const nothing = async () => undefined;
    const invite = (p: Party, h: User, w: User) => db.insert(partyInvites).values({ partyId: p.id, inviteeId: w.id, inviterId: h.id, status: "accepted" });
    const referral = (h: User, w: User) => db.insert(cornerNewPlayers).values({ userId: w.id, hostUserId: h.id, via: "invite" });
    expect(await linkOf(nothing, { beforeSettle: invite })).toEqual(["invited_new"]);
    expect(await linkOf(referral)).toEqual(["invited_new"]);
    const old = { createdAt: daysAgo(DEFAULT_HOST_WRITTEN_RULES.newAccountDays + 1) };
    expect(await linkOf(nothing, { winner: old, beforeSettle: invite })).toEqual([]);
    expect(await linkOf(referral, { winner: old })).toEqual([]);
    expect(await linkOf(nothing)).toEqual([]); // young, but nobody brought them
    // A link like the others: without an outlier score, paid as normal.
    expect(await linkOf(referral, { correct: [[100, 0, 100, 0], [0, 100, 0, 100]] })).toEqual([]);
  });

  it("an IP counts only if both used it around the party, and not if a carrier's worth of accounts did", async () => {
    const ip = () => `2001:db8:${randomUUID().slice(0, 4)}::${randomUUID().slice(0, 4)}`;
    const seen = (u: User, value: string, at: Date) => db.insert(userSignals).values({ kind: "ip", value, userId: u.id, firstSeenAt: at, lastSeenAt: at });
    const hours = (h: number) => new Date(Date.now() - h * 3_600_000);
    const within = DEFAULT_HOST_WRITTEN_RULES.ipWindowHoursBefore - 1;
    // Both in the window: linked.
    expect(await linkOf(async (h, w) => { const v = ip(); await seen(h, v, hours(within)); await seen(w, v, hours(1)); })).toEqual(["ip"]);
    // Shared once, long ago (the same café a month back): not linked.
    expect(await linkOf(async (h, w) => { const v = ip(); await seen(h, v, daysAgo(30)); await seen(w, v, daysAgo(30)); })).toEqual([]);
    // Only one of them around the party: not linked.
    expect(await linkOf(async (h, w) => { const v = ip(); await seen(h, v, hours(1)); await seen(w, v, daysAgo(30)); })).toEqual([]);
    // Carrier NAT: more than maxAccountsPerIp accounts on it in the window: ignored. At the limit: linked.
    // Only signed-up accounts made before the window count: guests or accounts opened for it can't fake a crowd.
    const established = { createdAt: daysAgo(30) };
    const crowd = async (others: number, who: Partial<typeof users.$inferInsert> = established) => linkOf(async (h, w) => {
      const v = ip();
      await seen(h, v, hours(1));
      await seen(w, v, hours(1));
      for (let i = 0; i < others; i++) await seen(await makeUser(name("nat"), who), v, hours(2));
    });
    const many = DEFAULT_HOST_WRITTEN_RULES.maxAccountsPerIp + 5;
    // (The host and winner here are new accounts themselves, so only the others count.)
    expect(await crowd(DEFAULT_HOST_WRITTEN_RULES.maxAccountsPerIp + 1)).toEqual([]);
    expect(await crowd(DEFAULT_HOST_WRITTEN_RULES.maxAccountsPerIp)).toEqual(["ip"]);
    expect(await crowd(many, { ...established, isGuest: true })).toEqual(["ip"]); // guest sessions on the same Wi-Fi
    expect(await crowd(many, { createdAt: hours(2) })).toEqual(["ip"]); // accounts made inside the window
  });

  it("a block lifted before settlement still counts (lifted_blocks); unblocking works for trust and safety as before", async () => {
    const blockThenLift = async (h: User, w: User) => {
      expect((await app.inject({ method: "POST", url: `/users/${w.id}/block`, headers: as(h) })).statusCode).toBeLessThan(300);
      expect(await blockedEitherWay(db, h.id, w.id)).toBe(true);
      expect((await app.inject({ method: "DELETE", url: `/users/${w.id}/block`, headers: as(h) })).statusCode).toBeLessThan(300);
      // Trust and safety sees no block at all once it's lifted, exactly as before.
      expect(await blockedEitherWay(db, h.id, w.id)).toBe(false);
      expect(await db.select().from(blocks).where(and(eq(blocks.blockerId, h.id), eq(blocks.blockedId, w.id)))).toEqual([]);
      const [row] = await db.select().from(liftedBlocks).where(and(eq(liftedBlocks.blockerId, h.id), eq(liftedBlocks.blockedId, w.id)));
      expect(row.liftedAt.getTime()).toBeGreaterThanOrEqual(row.blockedAt.getTime());
    };
    expect(await linkOf(blockThenLift)).toEqual(["recent_block"]);
    // Lifted, but made long before the party: not recent.
    expect(await linkOf((h, w) => db.insert(liftedBlocks).values({ blockerId: w.id, blockedId: h.id, blockedAt: daysAgo(60), liftedAt: daysAgo(1) }))).toEqual([]);
    // Unblocking someone you never blocked records nothing.
    const [a, b] = [await makeUser(name("ua")), await makeUser(name("ub"))];
    await app.inject({ method: "DELETE", url: `/users/${b.id}/block`, headers: as(a) });
    expect(await db.select().from(liftedBlocks).where(eq(liftedBlocks.blockerId, a.id))).toEqual([]);
  });

  it("recording a signal again moves its last-seen time on", async () => {
    const u = await makeUser(name("seen"));
    const v = `2001:db8:${randomUUID().slice(0, 4)}::1`;
    await db.insert(userSignals).values({ kind: "ip", value: v, userId: u.id, firstSeenAt: daysAgo(30), lastSeenAt: daysAgo(30) });
    await recordSignals(u.id, { ip: v });
    const [row] = await db.select().from(userSignals).where(and(eq(userSignals.userId, u.id), eq(userSignals.value, v)));
    expect(row.firstSeenAt.getTime()).toBeLessThan(daysAgo(29).getTime());
    expect(row.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("a block made within recentBlockDays before the party is a link itself, either way; an older one isn't", async () => {
    const days = DEFAULT_HOST_WRITTEN_RULES.recentBlockDays;
    expect(await linkOf((h, w) => db.insert(blocks).values({ blockerId: h.id, blockedId: w.id, createdAt: daysAgo(days - 1) }))).toEqual(["recent_block"]);
    expect(await linkOf((h, w) => db.insert(blocks).values({ blockerId: w.id, blockedId: h.id, createdAt: daysAgo(1) }))).toEqual(["recent_block"]);
    expect(await linkOf((h, w) => db.insert(blocks).values({ blockerId: h.id, blockedId: w.id, createdAt: daysAgo(days + 1) }))).toEqual([]);
  });
});

describe("a held prize", () => {
  let h: User, w: User, second: User, third: User, p: Party, heldId: string;
  beforeAll(async () => {
    h = await makeUser(name("hostd"));
    w = await makeUser(name("wind"), { phone: `+23480${randomUUID().replace(/\D/g, "").slice(0, 8)}`, phoneVerifiedAt: new Date() });
    second = await makeUser(name("second"));
    third = await makeUser(name("third"));
    await db.insert(contactMatches).values({ userId: h.id, contactUserId: w.id });
    p = await playedParty({ hostUser: h, seats: [{ u: w, correct: ACE }, { u: second, correct: MISS }, { u: third, correct: MISS }] });
    heldId = (await heldIn(p.id))[0].id;
  });

  it("sits in the hold: can't be withdrawn or spent; their own cash stays theirs, withdrawable as usual", async () => {
    const [u] = await db.select().from(users).where(eq(users.id, w.id));
    // Nothing blocks their withdrawals; the prize just isn't in what they have to withdraw.
    expect(withdrawBlockReason(u, await withdrawContext(db, u))).toBeNull();
    expect((await app.inject({ method: "GET", url: "/me", headers: as(w) })).json().canWithdraw).toBe(true);
    expect((await app.inject({ method: "GET", url: "/wallet", headers: as(w) })).json().cashKobo).toBe(0);
    // The held prize isn't cash: an entry can't come out of it; their own cash pays it as usual.
    const open = (await create(host, pooled({ mode: "curate" }))).json().id;
    expect((await app.inject({ method: "POST", url: `/parties/${open}/join`, headers: as(w) })).json().error).toBe("insufficient_funds");
    await fund(w, ENTRY);
    expect((await app.inject({ method: "POST", url: `/parties/${open}/join`, headers: as(w) })).statusCode).toBe(201);
    expect([await cash(w), await hold(w)]).toEqual([0, (await heldIn(p.id))[0].amountKobo]);
  });

  it("is listed for admins with its evidence", async () => {
    expect((await app.inject({ method: "GET", url: "/admin/party-templates/held-prizes", headers: as(w) })).statusCode).toBe(403);
    const list = (await app.inject({ method: "GET", url: "/admin/party-templates/held-prizes?status=held", headers: as(admin) })).json();
    const mine = list.prizes.find((x: { id: string }) => x.id === heldId);
    expect(mine).toMatchObject({ status: "held", place: 1, winner: { id: w.id }, host: { id: h.id }, party: { id: p.id }, request: null, evidence: { links: ["contact"] } });
  });

  it("reject: taken back and passed to the next placed player, once, however many times it's asked", async () => {
    const amount = (await heldIn(p.id))[0].amountKobo;
    const [wBefore, sBefore] = [await cash(w), await cash(second)];
    expect(await hold(w)).toBe(amount);
    expect((await app.inject({ method: "POST", url: `/admin/party-templates/held-prizes/${heldId}/reject`, headers: as(admin), payload: {} })).statusCode).toBe(400); // a reason
    // One admin only asks: nothing moves until a second confirms.
    const asked = await decide("reject", heldId, admin, "Fed the answers by the host");
    expect(asked.json()).toMatchObject({ replayed: false, awaitingSecondAdmin: true, prize: { status: "held", request: { decision: "reject", by: { id: admin.id }, reason: "Fed the answers by the host" } } });
    expect([await cash(w), await hold(w), await cash(second)]).toEqual([wBefore, amount, sBefore]);
    expect((await decide("reject", heldId, admin, "again")).json()).toMatchObject({ replayed: true, awaitingSecondAdmin: true, prize: { status: "held" } });
    const first = await decide("reject", heldId, admin2, "Agreed: fed the answers");
    expect(first.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/admin/party-templates/held-prizes/${heldId}/reject`, headers: as(w), payload: { reason: "mine" } })).statusCode).toBe(403); // not an admin anyway
    expect(first.json()).toMatchObject({ replayed: false, awaitingSecondAdmin: false, prize: { status: "rejected", reason: "Agreed: fed the answers", outcome: { kind: "passed_on", to: [{ userId: second.id, amountKobo: amount }] }, decidedBy: { id: admin2.id } } });
    // Out of the hold, not their cash; second place is paid in cash (not linked, so not held).
    expect([await cash(w), await hold(w)]).toEqual([wBefore, 0]);
    expect(await cash(second)).toBe(sBefore + amount);
    expect(await holdBreaches()).toEqual([]);
    const entries = () => db.select().from(ledgerEntries).where(like(ledgerEntries.idempotencyKey, `held_prize_reject:${heldId}%`));
    expect(await entries()).toHaveLength(2);
    const again = await app.inject({ method: "POST", url: `/admin/party-templates/held-prizes/${heldId}/reject`, headers: as(admin), payload: { reason: "again" } });
    expect(again.json()).toMatchObject({ replayed: true, prize: { status: "rejected", reason: "Agreed: fed the answers" } });
    expect(await entries()).toHaveLength(2);
    expect([await cash(w), await hold(w), await cash(second)]).toEqual([wBefore, 0, sBefore + amount]);
    expect((await db.select().from(partyPlayers).where(and(eq(partyPlayers.partyId, p.id), eq(partyPlayers.userId, second.id))))[0].prizeKobo).toBe(amount);
    // A rejected prize can't then be cleared; the winner can withdraw again (nothing else holds them).
    expect((await app.inject({ method: "POST", url: `/admin/party-templates/held-prizes/${heldId}/clear`, headers: as(admin), payload: { reason: "oops" } })).json().error).toBe("prize_already_decided");
    const [u] = await db.select().from(users).where(eq(users.id, w.id));
    expect(withdrawBlockReason(u, await withdrawContext(db, u))).toBeNull();
    const logs = await db.select().from(adminActions).where(and(eq(adminActions.targetType, "held_prize"), eq(adminActions.targetId, heldId)));
    expect(logs.map((l) => [l.action, l.adminUserId]).sort()).toEqual([["party_templates.held_prize_reject", admin2.id], ["party_templates.held_prize_reject_requested", admin.id]].sort());
  });
});

describe("clear, and the other reject outcomes", () => {
  it("clear: the hold moves into their cash, once; the winner may withdraw; a replay says so", async () => {
    const h = await makeUser(name("hoste"));
    const w = await makeUser(name("wine"), { phone: `+23480${randomUUID().replace(/\D/g, "").slice(0, 8)}`, phoneVerifiedAt: new Date() });
    await db.insert(contactMatches).values({ userId: h.id, contactUserId: w.id });
    const p = await playedParty({ hostUser: h, seats: [{ u: w, correct: ACE }, { u: await makeUser(name("pq")), correct: MISS }] });
    const [held] = await heldIn(p.id);
    const before = await cash(w);
    // Well under the payments second-admin threshold: two admins all the same.
    expect(held.amountKobo).toBeLessThan((await getPaymentsConfig()).finalize.secondAdminThresholdKobo);
    const res = await decided("clear", held.id, "Checked: they're just good");
    expect(res.json()).toMatchObject({ replayed: false, awaitingSecondAdmin: false, prize: { status: "cleared", reason: "Checked: they're just good", decidedBy: { id: admin2.id } } });
    expect((await app.inject({ method: "POST", url: `/admin/party-templates/held-prizes/${held.id}/clear`, headers: as(admin), payload: { reason: "again" } })).json()).toMatchObject({ replayed: true, prize: { reason: "Checked: they're just good" } });
    expect([await cash(w), await hold(w)]).toEqual([before + held.amountKobo, 0]);
    expect(await holdBreaches()).toEqual([]);
    const [u] = await db.select().from(users).where(eq(users.id, w.id));
    expect(withdrawBlockReason(u, await withdrawContext(db, u))).toBeNull();
    expect((await app.inject({ method: "POST", url: `/admin/party-templates/held-prizes/${held.id}/reject`, headers: as(admin), payload: { reason: "changed my mind" } })).json().error).toBe("prize_already_decided");
  });

  it("two admins for every decision: one asks, a different one confirms, the other decision replaces the request; never the host or the winner", async () => {
    const h = await makeUser(name("hostm"), { isAdmin: true });
    const w = await makeUser(name("winm"), { isAdmin: true, phone: `+23480${randomUUID().replace(/\D/g, "").slice(0, 8)}`, phoneVerifiedAt: new Date() });
    await db.insert(contactMatches).values({ userId: h.id, contactUserId: w.id });
    const p = await playedParty({ hostUser: h, funding: "host", hostPoolKobo: kobo(2_000), seats: [{ u: w, correct: ACE }, { u: await makeUser(name("pm")), correct: MISS }] });
    const [held] = await heldIn(p.id);
    // Neither the winner nor the host, though both are admins, for either decision.
    expect((await decide("clear", held.id, w, "mine")).json().error).toBe("own_transaction");
    expect((await decide("clear", held.id, h, "my friend")).json().error).toBe("own_transaction");
    expect((await decide("reject", held.id, h, "give it back")).json().error).toBe("own_transaction");
    const asked = await decide("clear", held.id, admin, "Looks fine to me");
    expect(asked.json()).toMatchObject({ replayed: false, awaitingSecondAdmin: true, prize: { status: "held", request: { decision: "clear", by: { id: admin.id }, reason: "Looks fine to me" } } });
    expect(await hold(w)).toBe(held.amountKobo); // still held
    expect((await decide("clear", held.id, admin, "again")).json()).toMatchObject({ replayed: true, awaitingSecondAdmin: true, prize: { status: "held" } });
    // A second admin who disagrees doesn't confirm: their reject replaces the request, and nothing moves.
    expect((await decide("reject", held.id, admin2, "Not convinced")).json()).toMatchObject({ awaitingSecondAdmin: true, prize: { status: "held", request: { decision: "reject", by: { id: admin2.id } } } });
    expect(await hold(w)).toBe(held.amountKobo);
    // The first admin asks to clear again (replacing the reject), and the second comes round.
    await decide("clear", held.id, admin, "Their history is clean");
    const confirmed = await decide("clear", held.id, admin2, "Confirmed: checked their history");
    expect(confirmed.json()).toMatchObject({ replayed: false, awaitingSecondAdmin: false, prize: { status: "cleared", decidedBy: { id: admin2.id } } });
    expect([await hold(w), await cash(w)]).toEqual([0, held.amountKobo]);
    const logs = await db.select().from(adminActions).where(and(eq(adminActions.targetType, "held_prize"), eq(adminActions.targetId, held.id)));
    expect(logs.map((l) => l.action).sort()).toEqual([
      "party_templates.held_prize_clear", "party_templates.held_prize_clear_requested", "party_templates.held_prize_clear_requested", "party_templates.held_prize_reject_requested",
    ]);
  });

  it("no self-interest: an admin the reject would pay (placed next, or due a refund) can neither ask nor confirm it", async () => {
    // Placed next: the reject would pass the prize to them.
    const h = await makeUser(name("hosts"));
    const w = await makeUser(name("wins"));
    const next = await makeUser(name("admnext"), { isAdmin: true });
    await db.insert(contactMatches).values({ userId: h.id, contactUserId: w.id });
    const p = await playedParty({ hostUser: h, seats: [{ u: w, correct: ACE }, { u: next, correct: MISS }, { u: await makeUser(name("ps")), correct: MISS }] });
    const [held] = await heldIn(p.id);
    expect((await decide("reject", held.id, next, "Fed the answers")).json().error).toBe("own_transaction");
    await decide("reject", held.id, admin, "Fed the answers");
    expect((await decide("reject", held.id, next, "Agreed")).json().error).toBe("own_transaction");
    const done = await decide("reject", held.id, admin2, "Agreed");
    expect(done.json().prize).toMatchObject({ status: "rejected", outcome: { kind: "passed_on", to: [{ userId: next.id }] }, decidedBy: { id: admin2.id } });

    // Due a refund: second place already has their share, nobody's left to pass it to, so it's refunded to the seats.
    const h2 = await makeUser(name("hostr"));
    const w2 = await makeUser(name("winr"));
    const paid = await makeUser(name("admpaid"), { isAdmin: true });
    await db.insert(contactMatches).values({ userId: h2.id, contactUserId: w2.id });
    const p2 = await playedParty({ hostUser: h2, split: [70, 30], seats: [{ u: w2, correct: ACE }, { u: paid, correct: MISS }] });
    const [held2] = await heldIn(p2.id);
    expect((await decide("reject", held2.id, paid, "Fed the answers")).json().error).toBe("own_transaction");
    expect((await decided("reject", held2.id, "Fed the answers")).json().prize.outcome).toMatchObject({ kind: "refunded", to: [{ userId: paid.id }] });
  });

  it("a host's cash prize to a linked winner: checked the same, and back to the host when nobody's left to pass it to", async () => {
    const h = await makeUser(name("hostf"));
    const w = await makeUser(name("winf"));
    await recordSignals(w.id, { installId: `inst-${randomUUID()}` });
    await db.insert(contactMatches).values({ userId: w.id, contactUserId: h.id });
    const other = await makeUser(name("otherf"));
    const p = await playedParty({ hostUser: h, funding: "host", hostPoolKobo: kobo(2_000), seats: [{ u: w, correct: ACE }, { u: other, correct: MISS }] });
    await db.update(users).set({ bannedAt: new Date() }).where(eq(users.id, other.id)); // banned since: never a prize
    const [held] = await heldIn(p.id);
    expect(held.amountKobo).toBe(kobo(2_000));
    const hostBefore = await cash(h);
    const res = await decided("reject", held.id, "Host funding a friend");
    expect(res.json().prize.outcome).toEqual({ kind: "returned_to_host", to: [{ userId: h.id, amountKobo: kobo(2_000) }] });
    expect(await cash(h)).toBe(hostBefore + kobo(2_000));
    expect([await cash(w), await hold(w)]).toEqual([0, 0]);
  });

  it("a passed-on prize goes through the same check: a second linked player is held in turn", async () => {
    const h = await makeUser(name("hostg"));
    const [w1, w2, last] = [await makeUser(name("w1g")), await makeUser(name("w2g")), await makeUser(name("lastg"))];
    await db.insert(contactMatches).values([{ userId: h.id, contactUserId: w1.id }, { userId: h.id, contactUserId: w2.id }]);
    const p = await playedParty({ hostUser: h, seats: [{ u: w1, correct: ACE }, { u: w2, correct: ACE }, { u: last, correct: MISS }] });
    const [held] = await heldIn(p.id);
    await decided("reject", held.id, "Linked");
    const now = await heldIn(p.id);
    expect(now.map((x) => [x.userId, x.status]).sort()).toEqual([[w1.id, "rejected"], [w2.id, "held"]].sort());
    expect([await cash(w2), await hold(w2)]).toEqual([0, held.amountKobo]);
    expect(await holdBreaches()).toEqual([]);
  });
});

afterAll(async () => {
  // Nothing else reads these parties; they're left finished like any other.
  expect(settled.length).toBeGreaterThan(0);
});

describe("the hold and the money around it", () => {
  const store = new Map<string, string>();
  const kv: KeyValue = { get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v); }, del: async (k) => { store.delete(k); } };
  const deps = { enqueue: async () => undefined };
  beforeAll(() => { delete process.env.PAYSTACK_SECRET_KEY; delete process.env.PAYMENTS_PROVIDER; resetProviders(); });

  /** A person who can withdraw: verified phone, a confirmed mock bank account, `cashKobo` in cash. */
  async function withdrawer(label: string, cashKobo: number) {
    const u = await makeUser(name(label), { phone: `+23480${randomUUID().replace(/\D/g, "").slice(0, 8)}`, phoneVerifiedAt: new Date() });
    if (cashKobo) await fund(u, cashKobo);
    const r = await resolveAccount(u.id, { bankCode: "001", accountNumber: `01${String(Date.now()).slice(-8)}` }, kv);
    return { u, account: await addBankAccount(u.id, { resolveToken: r.resolveToken, accountName: r.accountName }, kv) };
  }

  it("a held prize to someone who owes: nothing repays from the hold; clearing credits cash, which repays first", async () => {
    // A duplicate payout they couldn't cover (ADR 0013): reversed, spent down to 0, then paid after all.
    const mock = mockControlsOrNull()!;
    const { u: w, account } = await withdrawer("owes", kobo(5_000));
    const { payout } = await requestPayout(w, { amountKobo: kobo(1500) + 11, bankAccountId: account.id, clientRequestId: randomUUID() }, deps);
    expect(await submitPayout(payout.id)).toBe("failed");
    await db.transaction((tx) => ledger.post(tx, { userId: w.id, kind: "cash", amountKobo: -(kobo(5_000)), type: "topup", idempotencyKey: `t:tpl:spend:${payout.id}` }));
    await mock.setTransfer(payout.reference, { ...(await mock.getTransfer(payout.reference))!, state: "success" });
    await checkPayout(payout.id, "check");
    expect(await ledger.owedKobo(db, w.id)).toBe(payout.amountKobo);

    const h = await makeUser(name("hostowe"));
    await db.insert(contactMatches).values({ userId: h.id, contactUserId: w.id });
    // Their entry: the cash playedParty adds repays the debt first (as any credit), so the seat is paid from bonus coins.
    await db.transaction((tx) => ledger.post(tx, { userId: w.id, kind: "bonus", amountKobo: ENTRY, type: "topup", idempotencyKey: `t:tpl:bonus:${w.id}` }));
    const p = await playedParty({ hostUser: h, seats: [{ u: w, correct: ACE }, { u: await makeUser(name("powe")), correct: MISS }] });
    const owed = await ledger.owedKobo(db, w.id);
    expect(owed).toBe(payout.amountKobo - ENTRY);
    const [held] = await heldIn(p.id);
    // Their entry came from fresh cash; the prize is in the hold, and the debt is untouched by it.
    expect([await cash(w), await hold(w), await ledger.owedKobo(db, w.id)]).toEqual([0, held.amountKobo, owed]);
    // A reject can always take it back (here we clear, so it becomes cash and repays the debt first).
    expect((await decided("clear", held.id, "fine")).json().prize.status).toBe("cleared");
    const repaid = Math.min(held.amountKobo, owed);
    expect([await hold(w), await ledger.owedKobo(db, w.id), await cash(w)]).toEqual([0, owed - repaid, held.amountKobo - repaid]);
    expect(await holdBreaches()).toEqual([]);
  });

  it("settlement takes the winners' rows first: a withdrawal holding one makes settlement wait, and the prize never reaches it", async () => {
    const { u: w, account } = await withdrawer("race", 0);
    const h = await makeUser(name("hostrace"));
    await db.insert(contactMatches).values({ userId: h.id, contactUserId: w.id });
    // Seated and ranked, not settled yet: playedParty settles, so build it, then race a withdrawal against its settle.
    const seats = [{ u: w, correct: ACE }, { u: await makeUser(name("prace")), correct: MISS }];
    const [p] = await db.insert(parties).values({
      createdByUserId: h.id, title: `Race ${randomUUID().slice(0, 6)}`, category: "General knowledge", entryKobo: ENTRY, maxPlayers: 10, funding: "pooled", split: [100],
      mode: "curate", status: "live", startsAt: new Date(), liveAt: new Date(), questionsStatus: "ready", hostRules: DEFAULT_HOST_WRITTEN_RULES, hostQuestionCount: 2,
    }).returning();
    for (const [i, st] of seats.entries()) {
      await fund(st.u, ENTRY);
      await db.transaction((tx) => takeSeat(tx, p, st.u.id, ENTRY));
      await db.update(partyPlayers).set({ rank: i + 1 }).where(and(eq(partyPlayers.partyId, p.id), eq(partyPlayers.userId, st.u.id)));
    }
    for (let idx = 0; idx < 4; idx++) {
      const [pq] = await db.insert(partyQuestions).values({ partyId: p.id, idx, format: "pick_one", payload: { question: `r${idx}`, options: ["a", "b"], correctIndex: 0 }, seconds: 10, status: "played", hostWritten: idx < 2, hostAuthored: idx < 2 }).returning();
      await db.insert(partyAnswers).values(seats.map((st) => ({ partyId: p.id, questionId: pq.id, userId: st.u.id, correctness: st.correct[idx], points: st.correct[idx] })));
    }
    await fund(w, kobo(2_000)); // their own money, withdrawable

    // 1. A transaction holding the winner's row (as a withdrawal does) makes settlement wait for it.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const holding = db.transaction(async (tx) => { await tx.select().from(users).where(eq(users.id, w.id)).for("no key update"); await gate; });
    await new Promise((r) => setTimeout(r, 50));
    const settling = settle(settleDeps, p.id);
    await new Promise((r) => setTimeout(r, 300));
    expect((await partyRow(p.id)).status).toBe("live"); // still waiting on the winner's row
    release();
    await holding;
    await settling;
    expect((await partyRow(p.id)).status).toBe("finished");

    // 2. After the settle: their own cash withdraws as usual; the prize isn't in it, so asking for more is short.
    const [held] = await heldIn(p.id);
    const [u] = await db.select().from(users).where(eq(users.id, w.id));
    await expect(requestPayout(u, { amountKobo: kobo(2_000) + held.amountKobo, bankAccountId: account.id, clientRequestId: randomUUID() }, deps)).rejects.toThrow("insufficient_funds");
    const { payout } = await requestPayout(u, { amountKobo: kobo(2_000), bankAccountId: account.id, clientRequestId: randomUUID() }, deps);
    expect(payout.amountKobo).toBe(kobo(2_000));
    expect([await cash(w), await hold(w)]).toEqual([0, held.amountKobo]);
    expect(await holdBreaches()).toEqual([]);
  });

  it("a withdrawal and a settle at the same moment: the withdrawal gets only their own cash, never the prize", async () => {
    const { u: w, account } = await withdrawer("race2", kobo(2_000));
    const h = await makeUser(name("hostrace2"));
    await db.insert(contactMatches).values({ userId: h.id, contactUserId: w.id });
    const seats = [{ u: w, correct: ACE }, { u: await makeUser(name("prace2")), correct: MISS }];
    const [p] = await db.insert(parties).values({
      createdByUserId: h.id, title: `Race ${randomUUID().slice(0, 6)}`, category: "General knowledge", entryKobo: ENTRY, maxPlayers: 10, funding: "pooled", split: [100],
      mode: "curate", status: "live", startsAt: new Date(), liveAt: new Date(), questionsStatus: "ready", hostRules: DEFAULT_HOST_WRITTEN_RULES, hostQuestionCount: 2,
    }).returning();
    for (const [i, st] of seats.entries()) {
      await fund(st.u, ENTRY);
      await db.transaction((tx) => takeSeat(tx, p, st.u.id, ENTRY));
      await db.update(partyPlayers).set({ rank: i + 1 }).where(and(eq(partyPlayers.partyId, p.id), eq(partyPlayers.userId, st.u.id)));
    }
    for (let idx = 0; idx < 4; idx++) {
      const [pq] = await db.insert(partyQuestions).values({ partyId: p.id, idx, format: "pick_one", payload: { question: `s${idx}`, options: ["a", "b"], correctIndex: 0 }, seconds: 10, status: "played", hostWritten: idx < 2, hostAuthored: idx < 2 }).returning();
      await db.insert(partyAnswers).values(seats.map((st) => ({ partyId: p.id, questionId: pq.id, userId: st.u.id, correctness: st.correct[idx], points: st.correct[idx] })));
    }
    const [u] = await db.select().from(users).where(eq(users.id, w.id));
    const [out] = await Promise.allSettled([
      requestPayout(u, { amountKobo: kobo(2_000), bankAccountId: account.id, clientRequestId: randomUUID() }, deps),
      settle(settleDeps, p.id),
    ]);
    const [held] = await heldIn(p.id);
    // Whichever ran first, the withdrawal takes their own 2,000 and nothing more; the prize is in the hold.
    expect(out.status).toBe("fulfilled");
    expect(await cash(w)).toBe(0);
    expect(await hold(w)).toBe(held.amountKobo);
    expect(await holdBreaches()).toEqual([]);
  });

  it("journal() refuses to take a prize hold below zero (a clear of a prize that was never held there)", async () => {
    const u = await makeUser(name("overdraw"));
    const take = (amountKobo: number) => db.transaction((tx) => ledger.journal(tx, { type: "held_prize_cleared", idempotencyKey: `t:tpl:overdraw:${u.id}:${randomUUID()}`, legs: [{ account: ledger.prizeHoldAccount(u.id), amountKobo: -amountKobo }, { account: { userId: u.id, kind: "cash" }, amountKobo }] }));
    await expect(take(kobo(100))).rejects.toThrow(HoldOverdrawn);
    expect([await hold(u), await cash(u)]).toEqual([0, 0]); // rolled back
    // What is held can come out, and no more.
    await db.transaction((tx) => ledger.journal(tx, { type: "party_prize", idempotencyKey: `t:tpl:overdraw-in:${u.id}`, legs: [{ account: ledger.prizeHoldAccount(u.id), amountKobo: kobo(100) }, { account: { system: "dev_mint" }, amountKobo: -kobo(100) }] }));
    await expect(take(kobo(101))).rejects.toThrow(HoldOverdrawn);
    await take(kobo(100));
    expect([await hold(u), await cash(u)]).toEqual([0, kobo(100)]);
  });

  it("the invariant sees a hold that doesn't match its held prizes", async () => {
    const stray = await makeUser(name("stray"));
    await db.transaction((tx) => ledger.journal(tx, { type: "held_prize_test", idempotencyKey: `t:tpl:stray:${stray.id}`, legs: [{ account: ledger.prizeHoldAccount(stray.id), amountKobo: 100 }, { account: { system: "dev_mint" }, amountKobo: -100 }] }));
    const breaches = await holdBreaches();
    expect(breaches).toHaveLength(1);
    expect(breaches[0].items[stray.id]).toBe(100);
    // Put it back, so later runs see a clean ledger.
    await db.transaction((tx) => ledger.journal(tx, { type: "held_prize_test", idempotencyKey: `t:tpl:unstray:${stray.id}`, legs: [{ account: ledger.prizeHoldAccount(stray.id), amountKobo: -100 }, { account: { system: "dev_mint" }, amountKobo: 100 }] }));
    expect(await holdBreaches()).toEqual([]);
  });
});

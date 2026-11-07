/**
 * Curate host edits get the model safety check (ADR 0016): the API runs the term filter and marks the edit
 * "checking"; the questions service's check_host_edit passes or fails it (fail closed when the model can't
 * answer); only a passed edit can be approved, and a newer edit makes an older check moot. The safety
 * reviewer here is a fake.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, parties, partyQuestions } from "@contestly/db";
import { ProviderUnavailable } from "@contestly/ai";
import type { HostEditCheck } from "@contestly/shared";
import { checkHostEdit } from "../../questions/src/pipeline/checkHostEdit.js";
import { mockEmbedder } from "../../questions/src/providers/mock/embedder.js";
import { mockGenerator } from "../../questions/src/providers/mock/generator.js";
import { mockVerifier } from "../../questions/src/providers/mock/verifier.js";
import type { Providers, SafetyReviewer } from "../../questions/src/providers/types.js";
import { as, makeUser, tag, testApp } from "./harness.js";

const PAYLOAD = { question: "Which bridge opened in 1990?", options: ["Third Mainland Bridge", "Eko Bridge", "Carter Bridge", "Lekki-Ikoyi Link Bridge"], correctIndex: 0 };
let app: Awaited<ReturnType<typeof testApp>>["app"];
let host: Awaited<ReturnType<typeof makeUser>>;
let partyId: string;

const providers = (safety: SafetyReviewer): Providers => ({ generator: mockGenerator, verifier: mockVerifier, embedder: mockEmbedder, safety });
const passes: SafetyReviewer = { name: "fake", review: async (_b, items) => items.map(() => ({ passed: true, reasons: [], reviewedBy: "fake-model" })) };
const fails: SafetyReviewer = { name: "fake", review: async (_b, items) => items.map(() => ({ passed: false, reasons: ["model:private_individual"], reviewedBy: "fake-model" })) };
const down: SafetyReviewer = { name: "fake", review: async () => { throw new ProviderUnavailable("rate_limited", "anthropic", "safety", "slow down"); } };

async function draft(idx: number) {
  const [q] = await db.insert(partyQuestions).values({ partyId, idx, format: "pick_one", payload: PAYLOAD, seconds: 15, status: "draft" }).returning();
  return q;
}
const check = async (id: string) => (await db.select().from(partyQuestions).where(eq(partyQuestions.id, id)))[0].editCheck as HostEditCheck | null;
const edit = (qid: string, question: string) =>
  app.inject({ method: "PATCH", url: `/parties/${partyId}/drafts/${qid}`, headers: as(host), payload: { payload: { ...PAYLOAD, question } } });
const approve = (qid: string) => app.inject({ method: "POST", url: `/parties/${partyId}/drafts/${qid}/approve`, headers: as(host) });

beforeAll(async () => {
  ({ app } = await testApp());
  host = await makeUser(`curator${tag}`);
  const [p] = await db.insert(parties).values({
    createdByUserId: host.id, title: `curate ${tag}`, category: "General knowledge", brief: "Lagos bridges", mode: "curate",
    maxPlayers: 6, funding: "pooled", split: [100], startsAt: new Date(Date.now() + 3_600_000),
  }).returning();
  partyId = p.id;
});

afterAll(async () => {
  await app.close();
});

describe("host edit safety check", () => {
  it("an edit is checking until the model passes it, and only then can be approved", async () => {
    const q = await draft(0);
    expect((await edit(q.id, "Which bridge did Babangida open in 1990?")).statusCode).toBe(204);
    const pending = await check(q.id);
    expect(pending).toMatchObject({ status: "checking", reasons: [] });
    expect((await approve(q.id)).json()).toMatchObject({ error: "edit_check_pending" });

    await checkHostEdit({ partyId, partyQuestionId: q.id, checkId: pending!.id }, { providers: providers(passes) });
    expect(await check(q.id)).toMatchObject({ id: pending!.id, status: "passed", reviewedBy: "fake-model" });
    expect((await approve(q.id)).statusCode).toBe(204);
  });

  it("a failed check blocks approval with its reasons, shown in the drafts", async () => {
    const q = await draft(1);
    await edit(q.id, "What is my neighbour Tolu's home address?");
    await checkHostEdit({ partyId, partyQuestionId: q.id, checkId: (await check(q.id))!.id }, { providers: providers(fails) });
    expect(await check(q.id)).toMatchObject({ status: "failed", reasons: ["model:private_individual"] });
    expect((await approve(q.id)).json()).toMatchObject({ error: "edit_failed_safety" });
    const drafts = (await app.inject({ method: "GET", url: `/parties/${partyId}/drafts`, headers: as(host) })).json();
    expect(drafts.questions.find((d: { id: string }) => d.id === q.id).editCheck).toEqual({ status: "failed", reasons: ["model:private_individual"] });
  });

  it("fails closed when the model can't answer", async () => {
    const q = await draft(2);
    await edit(q.id, "Which bridge opened first?");
    await checkHostEdit({ partyId, partyQuestionId: q.id, checkId: (await check(q.id))!.id }, { providers: providers(down) });
    expect(await check(q.id)).toMatchObject({ status: "failed", reasons: ["safety_unavailable"] });
  });

  it("a newer edit makes the older check moot", async () => {
    const q = await draft(3);
    await edit(q.id, "First version?");
    const first = (await check(q.id))!.id;
    await edit(q.id, "Second version?");
    const second = (await check(q.id))!.id;
    await checkHostEdit({ partyId, partyQuestionId: q.id, checkId: first }, { providers: providers(fails) });
    expect(await check(q.id)).toMatchObject({ id: second, status: "checking" });
  });

  it("the term filter still refuses at once, before any check is queued", async () => {
    const q = await draft(4);
    expect((await edit(q.id, "Bet at the casino tonight?")).statusCode).toBe(422);
    expect(await check(q.id)).toBeNull();
  });
});

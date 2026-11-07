/**
 * The provider spend caps (ADR 0016): a party that has spent its cap is refused generation, verification and
 * the safety check, but not embeddings, which its bank-only fallback needs; the day's cap refuses everything.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, dbBudgetGate, getQuestionsConfig, parties, providerCalls, setQuestionsConfig } from "@contestly/db";
import { MICRO_USD_PER_CENT } from "@contestly/shared";
import { makeUser, tag } from "./harness.js";

let partyId: string;
let saved: Awaited<ReturnType<typeof getQuestionsConfig>>;

beforeAll(async () => {
  saved = await getQuestionsConfig();
  const host = await makeUser(`budget${tag}`);
  const [p] = await db.insert(parties).values({ createdByUserId: host.id, title: `budget ${tag}`, category: "General knowledge", maxPlayers: 6, funding: "pooled", split: [100], startsAt: new Date(Date.now() + 3_600_000) }).returning();
  partyId = p.id;
  await db.insert(providerCalls).values({ provider: "anthropic", model: "claude-opus-5-5", step: "verify", partyId, job: "generate_set", inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, searchQueries: 0, latencyMs: 1, costMicros: 2 * MICRO_USD_PER_CENT, attempts: 1, outcome: "ok" });
});

afterAll(async () => {
  await setQuestionsConfig(saved);
});

describe("provider budget gate", () => {
  it("a party at its cap is refused the paid steps, never embeddings", async () => {
    await setQuestionsConfig({ ...saved, providers: { ...saved.providers, perPartyCents: 1, dailyCents: 10_000_000 } });
    for (const step of ["generate", "verify", "safety"] as const) expect(await dbBudgetGate.check({ partyId, step })).toMatch(/party's provider budget/);
    expect(await dbBudgetGate.check({ partyId, step: "embed" })).toBeNull();
    expect(await dbBudgetGate.check({ partyId: null, step: "verify" })).toBeNull();
  });

  it("the day's cap refuses every step, embeddings too", async () => {
    await setQuestionsConfig({ ...saved, providers: { ...saved.providers, perPartyCents: 100_000, dailyCents: 1 } });
    expect(await dbBudgetGate.check({ partyId, step: "embed" })).toMatch(/today's provider budget/);
    expect(await dbBudgetGate.check({ partyId: null, step: "transcribe" })).toMatch(/today's provider budget/);
  });
});

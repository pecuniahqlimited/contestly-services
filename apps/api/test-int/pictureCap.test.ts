/**
 * The picture cap on small sets (ADR 0016): at most a quarter of the play order, rounded down, counting the reserves
 * too, so a set under four questions has no picture round however the fill goes (bank, generation, the fallback).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, ne } from "drizzle-orm";
import { db, partyQuestions, sql } from "@contestly/db";
import { pictureCap } from "@contestly/shared";
import { generateSet } from "../../questions/src/pipeline/generateSet.js";
import { selectProviders } from "../../questions/src/providers/index.js";
import { as, makeUser, testApp } from "./harness.js";

let app: Awaited<ReturnType<typeof testApp>>["app"];
beforeAll(async () => { ({ app } = await testApp()); });
afterAll(async () => {
  await app.close();
  await sql.end();
});

describe("the picture cap on small sets", () => {
  it.each([3, 4, 5, 8])("a %i-question set with pictures allowed holds at most a quarter of it, reserves included", async (questionCount) => {
    const host = await makeUser(`piccap${questionCount}${Date.now() % 100000}`);
    const res = await app.inject({
      method: "POST", url: "/parties", headers: as(host),
      payload: { title: "Landmarks", brief: "Famous Nigerian landmarks and rocks", entryKobo: 0, maxPlayers: 5, funding: "pooled", split: "winner", questionCount, formats: ["picture", "pick_one"], visibility: "private" },
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().id as string;
    await generateSet(id, { providers: selectProviders(), publish: async () => undefined });
    const rows = await db.select({ format: partyQuestions.format, reserve: partyQuestions.reserve }).from(partyQuestions)
      .where(and(eq(partyQuestions.partyId, id), ne(partyQuestions.status, "voided")));
    expect(rows.filter((r) => !r.reserve)).toHaveLength(questionCount);
    expect(rows.filter((r) => r.format === "picture").length).toBeLessThanOrEqual(pictureCap(questionCount));
  });
});

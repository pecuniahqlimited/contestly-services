/**
 * Reusing bank questions (ADR 0002, 0016): only at or above the embedder's measured floor; never a mock-written
 * question for a real embedder; a specific category only its own questions, the catch-all unfiltered. Vectors
 * are built so each row's similarity to the spec is known exactly, in a direction no other test's rows use.
 */
import { afterAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { bankQuestions, db, sql } from "@contestly/db";
import { EMBEDDING_DIM, type Category } from "@contestly/shared";
import { retrieveFromBank, retrievalFloor } from "../../questions/src/pipeline/retrieve.js";
import type { GenerationSpec } from "../../questions/src/providers/types.js";

const MODEL = "gemini-embedding-2";
/** Two axes of our own, far from where any other row points. */
const A = EMBEDDING_DIM - 1;
const B = EMBEDDING_DIM - 2;
const axis = (i: number) => Array.from({ length: EMBEDDING_DIM }, (_, k) => (k === i ? 1 : 0));
/** A unit vector at exactly this cosine to axis A. */
const at = (cos: number) => Array.from({ length: EMBEDDING_DIM }, (_, k) => (k === A ? cos : k === B ? Math.sqrt(1 - cos * cos) : 0));
const spec = (categoryTag: Category): GenerationSpec => ({
  topic: "test", categoryTag, difficulty: "mixed", secondsPerQuestion: 15, formats: ["pick_one"], exclusions: [], language: "en", sourceScope: "open", summary: "test",
});

const ids: string[] = [];
async function row(similarity: number, over: Partial<typeof bankQuestions.$inferInsert> = {}) {
  const [r] = await db.insert(bankQuestions).values({
    format: "pick_one", payload: { question: `q ${similarity} ${Math.random()}`, options: ["a", "b", "c", "d"], correctIndex: 0 }, categoryTag: "Football",
    embedding: at(similarity), embeddingModel: MODEL, difficulty: 0.5, writtenBy: "gemini", ...over,
  }).returning({ id: bankQuestions.id });
  ids.push(r.id);
  return r.id;
}
afterAll(async () => {
  if (ids.length) await db.delete(bankQuestions).where(inArray(bankQuestions.id, ids));
  await sql.end();
});

describe("reusing bank questions", () => {
  it("only at or above the embedder's floor (0.79 for gemini-embedding-2), most similar first", async () => {
    expect(retrievalFloor(MODEL)).toBe(0.79);
    const close = await row(0.86);
    const edge = await row(0.79);
    await row(0.78);
    await row(0.7);
    const got = await retrieveFromBank(spec("Football"), axis(A), 10, [], MODEL);
    expect(got.map((q) => q.id).filter((id) => ids.includes(id))).toEqual([close, edge]);
  });

  it("never a mock-written question for a real embedder; the mock embedder still sees its own", async () => {
    const mockWritten = await row(0.95, { writtenBy: "mock" });
    expect((await retrieveFromBank(spec("Football"), axis(A), 10, [], MODEL)).map((q) => q.id)).not.toContain(mockWritten);
    const forMock = await row(0.95, { writtenBy: "mock", embeddingModel: "mock" });
    expect((await retrieveFromBank(spec("Football"), axis(A), 50, [], "mock")).map((q) => q.id)).toContain(forMock);
  });

  it("a specific category gets only its own questions; the catch-all isn't narrowed", async () => {
    const afro = await row(0.9, { categoryTag: "Afrobeats" });
    expect((await retrieveFromBank(spec("Football"), axis(A), 10, [], MODEL)).map((q) => q.id)).not.toContain(afro);
    expect((await retrieveFromBank(spec("Afrobeats"), axis(A), 10, [], MODEL)).map((q) => q.id)).toContain(afro);
    expect((await retrieveFromBank(spec("General knowledge"), axis(A), 10, [], MODEL)).map((q) => q.id)).toContain(afro);
  });

  it("an embedder nobody has measured is strict", () => {
    expect(retrievalFloor("some-new-embedder")).toBe(0.85);
  });
});

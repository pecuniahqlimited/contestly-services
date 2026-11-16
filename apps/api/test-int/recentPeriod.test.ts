/**
 * A brief asking about a period too recent to cover (ADR 0016, "Periods and recent events"): refused with 409
 * recent_period_unsupported until the host chooses explicitly, on create and on a retry with a new brief; kept on
 * the party; carried by a rematch.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, parties, sql } from "@contestly/db";
import { RECENT_PERIOD_UNSUPPORTED, knownThroughYear } from "@contestly/shared";
import { as, makeUser, testApp } from "./harness.js";

let app: Awaited<ReturnType<typeof testApp>>["app"];
const THIS_YEAR = new Date().getUTCFullYear();
const RECENT = `WWE monday night raw ${THIS_YEAR}`;

beforeAll(async () => { ({ app } = await testApp()); });
afterAll(async () => {
  await app.close();
  await sql.end();
});

const create = (host: { id: string }, payload: Record<string, unknown>) => app.inject({
  method: "POST", url: "/parties", headers: as(host),
  payload: { title: "Raw night", entryKobo: 0, maxPlayers: 4, funding: "pooled", split: "winner", questionCount: 3, visibility: "private", ...payload },
});
const row = async (id: string) => (await db.select().from(parties).where(eq(parties.id, id)))[0];

describe("a recent period needs the host's choice", () => {
  it("refused without one, naming the period and the choices; made with history, which the party keeps", async () => {
    const host = await makeUser("rphost1");
    const refused = await create(host, { brief: RECENT });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: RECENT_PERIOD_UNSUPPORTED, details: { period: { label: String(THIS_YEAR), from: THIS_YEAR, to: THIS_YEAR }, knownThrough: knownThroughYear(), choices: ["history"] } });

    const made = await create(host, { brief: RECENT, recentPeriod: "history" });
    expect(made.statusCode, made.body).toBe(201);
    expect((await row(made.json().id)).recentPeriod).toBe("history");
  });

  it("an older period or none needs nothing, and a stray choice isn't kept", async () => {
    const host = await makeUser("rphost2");
    const old = await create(host, { brief: "WWF Attitude Era, 1997-2001" });
    expect(old.statusCode, old.body).toBe(201);
    expect((await row(old.json().id)).recentPeriod).toBeNull();
    const plain = await create(host, { brief: "Jollof wars", recentPeriod: "history" });
    expect((await row(plain.json().id)).recentPeriod).toBeNull();
  });

  it("a retry with a new, recent brief asks again", async () => {
    const host = await makeUser("rphost3");
    const { id } = (await create(host, { brief: "Afrobeats classics" })).json();
    await db.update(parties).set({ questionsStatus: "failed" }).where(eq(parties.id, id));
    const retry = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: `/parties/${id}/questions/retry`, headers: as(host), payload });
    expect((await retry({ brief: RECENT })).json().error).toBe(RECENT_PERIOD_UNSUPPORTED);
    expect((await row(id)).brief).toBe("Afrobeats classics"); // nothing changed
    expect((await retry({ brief: RECENT, recentPeriod: "history" })).statusCode).toBe(202);
    expect(await row(id)).toMatchObject({ brief: RECENT, recentPeriod: "history", questionsStatus: "generating" });
  });

  it("a rematch keeps the original's answer and never asks again", async () => {
    const host = await makeUser("rphost4");
    const { id } = (await create(host, { brief: RECENT, recentPeriod: "history" })).json();
    await db.update(parties).set({ status: "finished" }).where(eq(parties.id, id));
    const res = await app.inject({ method: "POST", url: `/parties/${id}/rematch`, headers: as(host) });
    expect(res.statusCode, res.body).toBe(201);
    expect(await row(res.json().partyId)).toMatchObject({ brief: RECENT, recentPeriod: "history" });
  });
});

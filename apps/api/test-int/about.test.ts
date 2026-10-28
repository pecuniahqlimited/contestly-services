/**
 * About you (roadmap 5c) against the real database: the admin's sets are versioned, validated and
 * logged with a reason; the preview maps picks before a save; answers are checked against the
 * version given and stored with it; a new version never touches anyone's answers or archetype.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TransactionRollbackError, and, desc, eq } from "drizzle-orm";
import { aboutConfigs, adminActions, currentAboutConfig, db, sql, users, type User } from "@contestly/db";
import { DEFAULT_ABOUT, aboutConfigSchemaFor, type AboutConfig } from "@contestly/shared";
import { as, makeUser, testApp } from "./harness.js";

let app: Awaited<ReturnType<typeof testApp>>["app"];
let admin: User, guest: User, brand: User, both: User;

beforeAll(async () => {
  ({ app } = await testApp());
  admin = await makeUser("aboutadmin", { isAdmin: true });
  guest = await makeUser("aboutguest", { isGuest: true, email: null, emailVerifiedAt: null });
  brand = await makeUser("aboutbrand");
  both = await makeUser("aboutboth");
});
afterAll(async () => {
  await app.close();
  await sql.end();
});

const current = async (audience: string) => (await app.inject({ method: "GET", url: `/onboarding/about?audience=${audience}` })).json();
const put = (audience: string, config: unknown, reason?: string) =>
  app.inject({ method: "PUT", url: `/admin/onboarding/about/${audience}`, headers: as(admin), payload: { config, reason } });
const answer = (u: User, version: number, answers: Record<string, string[]>) =>
  app.inject({ method: "PATCH", url: "/me/onboarding", headers: as(u), payload: { about: { version, answers } } });

describe("version 1", () => {
  it("comes from the migration: the prototype's sets, as DEFAULT_ABOUT", async () => {
    for (const audience of ["person", "brand"] as const) {
      const [v1] = await db.select().from(aboutConfigs).where(and(eq(aboutConfigs.audience, audience), eq(aboutConfigs.version, 1)));
      expect(v1.config).toEqual(aboutConfigSchemaFor(audience).parse(DEFAULT_ABOUT[audience]));
    }
  });

  it("a read that finds no set is an error, not a write", async () => {
    let read = "", left = -1;
    // Inside a transaction that's rolled back, so the brand set comes back for everything else.
    await db.transaction(async (tx) => {
      await tx.delete(aboutConfigs).where(eq(aboutConfigs.audience, "brand"));
      read = await currentAboutConfig("brand", tx).then(() => "read", (e: Error) => e.message);
      left = (await tx.select().from(aboutConfigs).where(eq(aboutConfigs.audience, "brand"))).length;
      tx.rollback();
    }).catch((e) => { if (!(e instanceof TransactionRollbackError)) throw e; });
    expect(read).toMatch(/^about_config_missing/);
    expect(left).toBe(0);
    expect((await current("brand")).version).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /onboarding/about", () => {
  it("is public and always has a current version of each set", async () => {
    const person = await current("person");
    expect(person.version).toBeGreaterThanOrEqual(1);
    expect(person.config.questions.length).toBeGreaterThan(0);
    expect((await current("brand")).audience).toBe("brand");
    expect((await app.inject({ method: "GET", url: "/onboarding/about?audience=robot" })).statusCode).toBe(400);
  });
});

describe("admin: versioned, validated, logged", () => {
  it("refuses an invalid set and a save without a reason", async () => {
    const dupe: AboutConfig = { questions: [DEFAULT_ABOUT.person.questions[1], DEFAULT_ABOUT.person.questions[1]] };
    expect((await put("person", dupe, "dupe ids")).statusCode).toBe(400);
    const weighted = { questions: [{ ...DEFAULT_ABOUT.brand.questions[1], options: DEFAULT_ABOUT.brand.questions[1].options.map((o) => ({ ...o, weights: { host: 1 } })) }] };
    expect((await put("brand", weighted, "weights")).statusCode).toBe(400);
    expect((await put("person", DEFAULT_ABOUT.person)).statusCode).toBe(400);
  });

  it("each save is the next version, and is logged with its reason", async () => {
    const before = await current("brand");
    const saved = (await put("brand", DEFAULT_ABOUT.brand, "integration test: same set again")).json();
    expect(saved.version).toBe(before.version + 1);
    expect((await current("brand")).version).toBe(saved.version);
    const [log] = await db.select().from(adminActions).where(and(eq(adminActions.action, "config.onboarding_about"), eq(adminActions.targetId, "onboarding_about:brand"))).orderBy(desc(adminActions.createdAt)).limit(1);
    expect(log).toMatchObject({ adminUserId: admin.id, reason: "integration test: same set again" });
    expect((log.after as { version: number }).version).toBe(saved.version);
  });

  it("previews picks against the current set or a draft", async () => {
    const live = (await app.inject({ method: "POST", url: "/admin/onboarding/about/person/preview", headers: as(admin), payload: { answers: {} } })).json();
    expect(live.archetype).toBe("competitor");
    const draft = DEFAULT_ABOUT.person;
    const res = (await app.inject({ method: "POST", url: "/admin/onboarding/about/person/preview", headers: as(admin), payload: { config: draft, answers: { saturday: ["quiz", "building"], rather: ["vibe"] } } })).json();
    expect(res).toEqual({ lanes: ["Brain teasers", "General knowledge", "Tech", "Science"], archetype: "fan", totals: { competitor: 0, host: 0, grinder: 2, fan: 3 }, problems: [] });
    const partial = (await app.inject({ method: "POST", url: "/admin/onboarding/about/person/preview", headers: as(admin), payload: { config: draft, answers: { saturday: ["quiz"] } } })).json();
    expect(partial.problems).toEqual([{ questionId: "rather", problem: "too_few" }]);
  });
});

describe("answers", () => {
  it("are checked against the version given, stored with it, and give lanes and the archetype", async () => {
    const v = await put("person", DEFAULT_ABOUT.person, "integration test: known set");
    const { version } = v.json();
    expect((await answer(guest, version, { saturday: ["match"] })).json()).toMatchObject({ error: "invalid_answers", details: [{ questionId: "rather", problem: "too_few" }] });
    expect((await answer(guest, 999_999, { saturday: ["match"], rather: ["beat"] })).json().error).toBe("unknown_about_version");
    const ok = (await answer(guest, version, { saturday: ["match", "quiz"], rather: ["climb"] })).json();
    expect(ok).toMatchObject({ aboutVersion: version, archetype: "grinder", lanes: ["Football", "Brain teasers", "General knowledge"] });

    // A new version, with the "quiz" option gone and the single question changed: the guest's row is untouched.
    const next: AboutConfig = { questions: [
      { ...DEFAULT_ABOUT.person.questions[0], options: DEFAULT_ABOUT.person.questions[0].options.filter((o) => o.id !== "quiz") },
      { ...DEFAULT_ABOUT.person.questions[1], options: DEFAULT_ABOUT.person.questions[1].options.map((o) => ({ ...o, weights: { fan: 2 } })) },
    ] };
    const v2 = (await put("person", next, "integration test: drop quiz")).json().version;
    const [row] = await db.select().from(users).where(eq(users.id, guest.id));
    expect(row).toMatchObject({ aboutVersion: version, archetype: "grinder", aboutAnswers: { saturday: ["match", "quiz"], rather: ["climb"] } });

    // Me: edit against the current version, prefilled where ids still match.
    const mine = (await app.inject({ method: "GET", url: "/me/onboarding", headers: as(guest) })).json();
    expect(mine).toMatchObject({ answered: { version }, current: { version: v2 }, prefill: { saturday: ["match"], rather: ["climb"] }, archetype: "grinder" });
    const edited = (await answer(guest, v2, mine.prefill)).json();
    expect(edited).toMatchObject({ aboutVersion: v2, archetype: "fan", lanes: ["Football"] });
    await put("person", DEFAULT_ABOUT.person, "integration test: put it back");
  });

  it("who and answers in one PATCH: all or nothing", async () => {
    const person = await current("person");
    const good = { saturday: ["match"], rather: ["beat"] };
    expect((await app.inject({ method: "PATCH", url: "/me/onboarding", headers: as(both), payload: { who: "person", about: { version: person.version, answers: good } } })).statusCode).toBe(200);
    const [before] = await db.select().from(users).where(eq(users.id, both.id));

    // Switching to brand would clear the person answers, but the brand answers are bad: nothing changes.
    const brandSet = await current("brand");
    const bad = await app.inject({ method: "PATCH", url: "/me/onboarding", headers: as(both), payload: { who: "brand", about: { version: brandSet.version, answers: { does: ["nope"] } } } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toBe("invalid_answers");
    const [after] = await db.select().from(users).where(eq(users.id, both.id));
    expect(after).toEqual(before);
    expect(after).toMatchObject({ who: "person", aboutAudience: "person", archetype: "competitor" });

    // An unknown version rolls back the who too.
    expect((await app.inject({ method: "PATCH", url: "/me/onboarding", headers: as(both), payload: { who: "brand", about: { version: 999_999, answers: {} } } })).statusCode).toBe(422);
    expect((await db.select().from(users).where(eq(users.id, both.id)))[0]).toEqual(before);

    // Both valid: both land.
    const ok = (await app.inject({ method: "PATCH", url: "/me/onboarding", headers: as(both), payload: { who: "brand", about: { version: brandSet.version, answers: { does: ["tech"], goal: ["reach"] } } } })).json();
    expect(ok).toMatchObject({ who: "brand", archetype: "host", lanes: ["Tech"] });
  });

  it("a brand answers the brand set and is always host; switching who clears the other set's answers", async () => {
    await app.inject({ method: "PATCH", url: "/me/onboarding", headers: as(brand), payload: { who: "brand" } });
    const { version } = await current("brand");
    const res = (await answer(brand, version, { does: ["food", "film"], goal: ["culture"] })).json();
    expect(res).toMatchObject({ who: "brand", archetype: "host", lanes: ["Food", "Nollywood", "Reality TV"] });
    const back = (await app.inject({ method: "PATCH", url: "/me/onboarding", headers: as(brand), payload: { who: "person" } })).json();
    expect(back).toMatchObject({ who: "person", aboutVersion: null, archetype: null, lanes: ["Food", "Nollywood", "Reality TV"] });
  });
});

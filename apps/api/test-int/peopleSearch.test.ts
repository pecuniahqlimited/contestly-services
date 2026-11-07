/**
 * People search (GET /users/search): a prefix of the handle, the name or any word of the name, folded for case
 * and accents; your people first, then an exact handle, then the rest; never blocked (either way), banned,
 * deleted or guest accounts; whether each can be messaged and if it'd be a request; the per-user limit.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { blocks, contactMatches, crewMembers, crews, db, playedWith, type User } from "@contestly/db";
import { limitsFromEnv } from "../src/limits.js";
import { as, makeUser, tag, testApp } from "./harness.js";

let app: Awaited<ReturnType<typeof testApp>>["app"];
const W = `Bísì${tag}`; // a word only this run's people have
const plain = `bisi${tag}`;
let me: User, crewmate: User, contact: User, played: User, stranger: User, secondWord: User;
let blockedByMe: User, blockerOfMe: User, banned: User, deleted: User, guest: User;
let exact: User, exactly: User;

const search = (q: string, u: User = me) => app.inject({ url: `/users/search?q=${encodeURIComponent(q)}`, headers: as(u) });
const ids = async (q: string) => ((await search(q)).json().people as { id: string }[]).map((p) => p.id);

beforeAll(async () => {
  ({ app } = await testApp());
  me = await makeUser("searcher");
  let n = 0;
  const named = (name: string, extra: Parameters<typeof makeUser>[1] = {}) => { const handle = `t${tag}_p${++n}`; return makeUser(name, { handle, email: `${handle}@test.contestly.invalid`, ...extra }); };
  [crewmate, contact, played, stranger, blockedByMe, blockerOfMe, banned, deleted, guest] = await Promise.all([
    named(`${W} Crew`), named(`${W} Contact`), named(`${W} Played`), named(`${W} Stranger`),
    named(`${W} Blocked`), named(`${W} Blocker`), named(`${W} Banned`, { bannedAt: new Date() }),
    named(`${W} Gone`, { deletedAt: new Date() }), named(`${W} Guest`, { isGuest: true }),
  ]);
  secondWord = await named(`Ọlá ${W}`);
  exact = await makeUser("exact");
  exactly = await makeUser("exactly");
  const [crew] = await db.insert(crews).values({ name: "Search crew", emoji: "🔎", color: "blue", createdByUserId: me.id }).returning();
  await db.insert(crewMembers).values([{ crewId: crew.id, userId: me.id, role: "creator" }, { crewId: crew.id, userId: crewmate.id }]);
  await db.insert(contactMatches).values({ userId: contact.id, contactUserId: me.id });
  const [a, b] = [me.id, played.id].sort();
  await db.insert(playedWith).values({ userA: a, userB: b, lastPlayedAt: new Date() });
  await db.insert(blocks).values([{ blockerId: me.id, blockedId: blockedByMe.id }, { blockerId: blockerOfMe.id, blockedId: me.id }]);
});

afterAll(async () => {
  await app.close();
});

describe("people search", () => {
  it("finds by a prefix of the name or any word of it, folded for case and accents", async () => {
    const found = await ids(plain);
    expect(new Set(found)).toEqual(new Set([crewmate.id, contact.id, played.id, stranger.id, secondWord.id]));
    expect(new Set(await ids(W.toUpperCase()))).toEqual(new Set(found));
    expect(await ids(`${plain} str`)).toEqual([stranger.id]);
  });

  it("never shows anyone blocked either way, banned, deleted or a guest, or you", async () => {
    const found = await ids(plain);
    for (const u of [blockedByMe, blockerOfMe, banned, deleted, guest, me]) expect(found).not.toContain(u.id);
    // Not by handle either.
    expect(await ids(blockedByMe.handle)).toEqual([]);
    expect(await ids(blockerOfMe.handle)).toEqual([]);
    expect(await ids(banned.handle)).toEqual([]);
  });

  it("ranks your people first, says how you know them, and whether a message would be a request", async () => {
    const people = (await search(plain)).json().people as { id: string; yourPeople: boolean; relationship: string | null; canMessage: boolean; messageIsRequest: boolean }[];
    expect(people.slice(0, 3).every((p) => p.yourPeople)).toBe(true);
    expect(people.slice(3).every((p) => !p.yourPeople)).toBe(true);
    const of = (u: User) => people.find((p) => p.id === u.id)!;
    expect(of(crewmate)).toMatchObject({ relationship: "in_your_crew", canMessage: true, messageIsRequest: false });
    expect(of(contact)).toMatchObject({ relationship: "in_your_contacts", canMessage: true, messageIsRequest: false });
    expect(of(played)).toMatchObject({ relationship: "played_with_you", canMessage: true, messageIsRequest: false });
    expect(of(stranger)).toMatchObject({ relationship: null, yourPeople: false, canMessage: true, messageIsRequest: true });
  });

  it("an exact handle comes before handles that only start with it", async () => {
    expect(await ids(`@${exact.handle}`)).toEqual([exact.id, exactly.id]);
  });

  it("needs at least 2 characters and a signed-up account", async () => {
    expect((await search("a")).statusCode).toBe(400);
    expect((await search("@ b")).statusCode).toBe(400);
    expect((await search(plain, guest)).statusCode).toBeGreaterThanOrEqual(400);
  });

  it("is rate-limited per user, and heavy use is logged", async () => {
    const limited = await testApp({ limits: { ...limitsFromEnv(), peopleSearchPerMinute: 4 } });
    const u = await makeUser("hammer");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await limited.app.inject({ url: `/users/search?q=${plain}`, headers: as(u) })).statusCode);
      expect(codes).toEqual([200, 200, 200, 200, 429]);
      expect(warn.mock.calls.some((c) => String(c[0]).includes(`heavy use: user ${u.id}`))).toBe(true);
    } finally {
      warn.mockRestore();
      await limited.app.close();
    }
  });
});

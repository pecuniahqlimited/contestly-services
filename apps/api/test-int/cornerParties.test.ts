/**
 * Parties on a corner (ADR 0012): a corner owner's public party goes up on their corner's Up next and pings
 * the followers who have its alerts on; a private (invite-only) party does neither. The builder learns the
 * corner's reach from GET /parties/limits and the create response (postsToCorner, followers, pings).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { corners, db, emitCornerParty, follows, nudges, type User } from "@contestly/db";
import { as, makeUser, tag, testApp } from "./harness.js";

let app: Awaited<ReturnType<typeof testApp>>["app"];
let owner: User, alerted: User, quiet: User, noCorner: User;
let cornerId: string;

const create = (u: User, visibility: "public" | "private") => app.inject({
  method: "POST", url: "/parties", headers: as(u),
  payload: { title: `${visibility} night ${tag}`, brief: "general knowledge", maxPlayers: 4, entryKobo: 0, funding: "pooled", split: "winner", visibility },
});
const pinged = async (partyId: string) => db.select({ userId: nudges.userId }).from(nudges).where(and(eq(nudges.kind, "corner_party"), eq(nudges.dedupeKey, `corner_party:${partyId}`)));

beforeAll(async () => {
  ({ app } = await testApp());
  [owner, alerted, quiet, noCorner] = await Promise.all(["cpowner", "cpalert", "cpquiet", "cpnone"].map((n) => makeUser(`${n}${tag}`)));
  const [c] = await db.insert(corners).values({ ownerUserId: owner.id, name: `${owner.displayName}'s corner`, status: "unlocked", unlockedAt: new Date() }).returning();
  cornerId = c.id;
  await db.insert(follows).values([{ cornerId, followerId: alerted.id, notify: true }, { cornerId, followerId: quiet.id, notify: false }]);
});

afterAll(async () => {
  await app.close();
});

describe("parties on a corner", () => {
  it("the builder sees the corner's reach before creating", async () => {
    const limits = (await app.inject({ url: "/parties/limits", headers: as(owner) })).json();
    expect(limits.corner).toEqual({ cornerId, followerCount: 2, pingCount: 1 });
    expect((await app.inject({ url: "/parties/limits", headers: as(noCorner) })).json().corner).toBeNull();
  });

  it("a public party goes up on Up next and pings the followers with alerts on", async () => {
    const res = await create(owner, "public");
    expect(res.statusCode).toBe(201);
    const p = res.json();
    expect(p).toMatchObject({ postsToCorner: true, corner: { cornerId, followerCount: 2, pingCount: 1 } });
    const page = (await app.inject({ url: `/corners/${cornerId}` })).json();
    expect(page.upNext.map((x: { id: string }) => x.id)).toContain(p.id);
    expect(await emitCornerParty(p.id, owner.id)).toBe(1);
    expect((await pinged(p.id)).map((r) => r.userId)).toEqual([alerted.id]);
  });

  it("a private party is neither on Up next nor pings anyone", async () => {
    const res = await create(owner, "private");
    const p = res.json();
    expect(p).toMatchObject({ postsToCorner: false, corner: { cornerId } });
    const page = (await app.inject({ url: `/corners/${cornerId}` })).json();
    expect(page.upNext.map((x: { id: string }) => x.id)).not.toContain(p.id);
    expect(await emitCornerParty(p.id, owner.id)).toBe(0);
    expect(await pinged(p.id)).toEqual([]);
  });

  it("without a shown corner, nothing goes up anywhere", async () => {
    const p = (await create(noCorner, "public")).json();
    expect(p).toMatchObject({ postsToCorner: false, corner: null });
    expect(await emitCornerParty(p.id, noCorner.id)).toBe(0);
  });
});

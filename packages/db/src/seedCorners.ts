/**
 * Demo corners (ADR 0012) for db:seed: Tunde's corner unlocked, Afrobeats Weekly's as a verified brand's
 * (createBrandCorner), both with a few posts and followers; and Kemi one finished party, two players and one
 * new player short of unlocking hers, from past bragging-rights parties she hosted for the demo regulars.
 * Fixed ids, so a re-run changes nothing it already wrote.
 */
import { eq } from "drizzle-orm";
import { DEFAULT_CORNER_UNLOCK, kobo } from "@contestly/shared";
import type { Tx } from "./client.js";
import {
  cornerNewPlayers, cornerParties, cornerPartyPlayers, cornerPostReactions, cornerPostReplies, cornerPosts, corners, feedEvents, follows, parties, partyPlayers, users,
} from "./schema.js";
import { createBrandCorner, ensureCorner } from "./corners.js";
import { recordPlayedWith } from "./social.js";

const id = (block: number, n: number) => `00000000-0000-4000-8000-${String(block).padStart(4, "0")}${String(n).padStart(8, "0")}`;

/** The people Kemi's past parties brought in: signed up, verified dev emails. */
export const demoRegulars = ["bisi", "chuka", "dayo", "efe", "funmi", "gbenga", "hauwa", "ifeoma", "jide", "kunle", "lola", "musa", "nneka", "obinna", "pelumi", "rukky", "sade", "tobi"]
  .map((name, i) => ({ id: id(2001, i + 1), handle: `${name}.demo`, displayName: name[0].toUpperCase() + name.slice(1), avatarEmoji: "🙂" }));

const DAY_MS = 86_400_000;

export async function seedCorners(tx: Tx, by: Record<string, string>, now = new Date()) {
  await tx.insert(users).values(demoRegulars.map((r) => ({ ...r, email: `${r.handle}@dev.contestly.invalid`, emailVerifiedAt: now }))).onConflictDoNothing();

  // Tunde: unlocked under version 1 (a seed; nobody made up N). Afrobeats Weekly: a verified brand's corner.
  const tunde = await ensureCorner(tx, by["tunde"]);
  await tx.update(corners).set({ name: "Tunde's Friday Football", bio: "Football trivia every Friday night. Bring your people.", status: "unlocked", unlockedAt: now, unlockConfigVersion: 1, lane: "Football", laneChosenAt: now, color: "#16A34A" })
    .where(eq(corners.id, tunde.id));
  const afro = await createBrandCorner(tx, by["afrobeatsweekly"], now);
  await tx.update(corners).set({ name: "Afrobeats Weekly", bio: "The home of Afrobeats. A new party every week.", lane: "Afrobeats", laneChosenAt: now, color: "#DB2777" }).where(eq(corners.id, afro.id));

  await tx.insert(follows).values([
    { followerId: by["ada.o"], cornerId: tunde.id }, { followerId: by["kemz"], cornerId: tunde.id }, { followerId: by["segunola"], cornerId: tunde.id },
    { followerId: by["tunde"], cornerId: afro.id }, { followerId: by["zee"], cornerId: afro.id }, { followerId: by["ada.o"], cornerId: afro.id },
  ]).onConflictDoNothing();

  const posts = [
    { id: id(2002, 1), cornerId: tunde.id, authorUserId: by["tunde"], text: "Friday night football is back. Super Eagles edition this week. Who's in?", at: 3 },
    { id: id(2002, 2), cornerId: tunde.id, authorUserId: by["tunde"], text: "Ada took last week's crown with a perfect last round. Respect.", at: 2 },
    { id: id(2002, 3), cornerId: tunde.id, authorUserId: by["tunde"], text: "Next one is AFCON history. Revise your 2013.", at: 1 },
    { id: id(2002, 4), cornerId: afro.id, authorUserId: by["afrobeatsweekly"], text: "2010s throwback party tonight. Bring your best ad-libs.", at: 2 },
    { id: id(2002, 5), cornerId: afro.id, authorUserId: by["afrobeatsweekly"], text: "Which album should next week's party be about? Reply below.", at: 1 },
  ];
  for (const p of posts) {
    const createdAt = new Date(now.getTime() - p.at * 3_600_000);
    await tx.insert(cornerPosts).values({ id: p.id, cornerId: p.cornerId, authorUserId: p.authorUserId, text: p.text, createdAt }).onConflictDoNothing();
    await tx.insert(feedEvents).values({ id: p.id, userId: p.authorUserId, kind: "corner_post", data: { cornerId: p.cornerId, postId: p.id, text: p.text }, cornerPostId: p.id, createdAt }).onConflictDoNothing();
  }
  await tx.insert(cornerPostReactions).values([
    { postId: id(2002, 1), userId: by["ada.o"], emoji: "🔥" }, { postId: id(2002, 1), userId: by["kemz"], emoji: "🔥" },
    { postId: id(2002, 2), userId: by["ada.o"], emoji: "😂" }, { postId: id(2002, 4), userId: by["zee"], emoji: "👏" },
  ]).onConflictDoNothing();
  await tx.insert(cornerPostReplies).values([
    { id: id(2003, 1), postId: id(2002, 1), userId: by["ada.o"], text: "In. Bringing Kemi.", clientMsgId: id(2004, 1) },
    { id: id(2003, 2), postId: id(2002, 5), userId: by["zee"], text: "Made in Lagos, no question", clientMsgId: id(2004, 2) },
  ]).onConflictDoNothing();

  await seedKemiProgress(tx, by, now);
}

/**
 * Kemi's progress: four past bragging-rights parties she hosted, each with five of the demo regulars (18 distinct
 * players in all), four of them new players brought by her. Against the default thresholds (P 5, D 20, N 5) she
 * needs one more party, two more players and one more new player.
 */
async function seedKemiProgress(tx: Tx, by: Record<string, string>, now: Date) {
  const kemi = by["kemz"];
  await ensureCorner(tx, kemi);
  const groups = [[0, 1, 2, 3, 4], [5, 6, 7, 8, 9], [10, 11, 12, 13, 14], [15, 16, 17, 0, 5]];
  for (const [i, group] of groups.entries()) {
    const endedAt = new Date(now.getTime() - (groups.length - i) * DAY_MS);
    const partyId = id(2005, i + 1);
    const [made] = await tx.insert(parties).values({
      id: partyId, createdByUserId: kemi, title: `Nollywood night #${i + 1}`, brief: "Nollywood classics: the films, the stars, the lines", category: "Nollywood",
      entryKobo: kobo(0), maxPlayers: 10, funding: "pooled", split: [100], visibility: "public", status: "finished", questionsStatus: "ready",
      startsAt: new Date(endedAt.getTime() - 10 * 60_000), liveAt: new Date(endedAt.getTime() - 10 * 60_000), endedAt, coverEmoji: "🎬", coverColor: "#E8467C",
    }).onConflictDoNothing().returning({ id: parties.id });
    if (!made) continue; // seeded before
    const players = group.map((g) => demoRegulars[g].id);
    await tx.insert(partyPlayers).values(players.map((userId, r) => ({ partyId, userId, score: 1000 - r * 100, rank: r + 1, joinedAt: endedAt })));
    await recordPlayedWith(tx, partyId, endedAt);
    await tx.insert(cornerParties).values({ partyId, hostUserId: kemi, realPlayers: players.length, counts: players.length >= DEFAULT_CORNER_UNLOCK.realPlayersPerParty, finishedAt: endedAt });
    await tx.insert(cornerPartyPlayers).values(players.map((userId) => ({ partyId, userId, hostUserId: kemi })));
  }
  // The first player of each of her first four parties: their first party anywhere was hers.
  for (const [i, g] of [0, 5, 10, 15].entries()) {
    await tx.insert(cornerNewPlayers).values({ userId: demoRegulars[g].id, hostUserId: kemi, via: "first_party", status: "counted", partyId: id(2005, i + 1), decidedAt: now })
      .onConflictDoNothing();
  }
}

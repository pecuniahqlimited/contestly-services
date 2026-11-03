/**
 * Corners sim (row 6c, ADR 0012), fresh people against the running stack:
 *
 * 1. Playing parties until a host unlocks: thresholds lowered for the run (P 2, R 2, D 3, N 2; put back after),
 *    two rounds of real parties, the corner locked after the first and unlocked after the second, with the
 *    info alert naming who made up N.
 * 2. The N rules: an unverified email doesn't count, an install id seen on another account doesn't count, and a
 *    player another host brought first doesn't count for this one.
 * 3. Follow and unfollow, party alerts, the public follower list.
 * 4. A post, a reaction, a reply and a mute (the muted follower isn't told).
 * 5. The DM rule: following a corner opens nothing; playing together does.
 * 6. Your people: the friends board, the lobby's "who's in", and the feed with the corner's post.
 *
 * Every request carries the player's install id (x-install-id), as the app does. TEST-ONLY: answers are read
 * from Postgres, and one player's email is marked unverified in the database (dev accounts come verified).
 * Run with the stack up: npm run sim:corners
 */
import { randomBytes, randomUUID } from "node:crypto";
import { Client, type Room } from "colyseus.js";
import { and, eq } from "drizzle-orm";
import { adminAlerts, db, partyQuestions, users } from "@contestly/db";
import { partyQueue } from "@contestly/queue";
import { INSTALL_ID_HEADER, MSG, PARTY_ROOM } from "@contestly/shared";
import type { QuestionFormat } from "@contestly/game";
import { API, RT, correctAnswer, failureCount, inMinutes, ok, sleep, waitFor } from "./sim-lib.js";

const tag = randomBytes(2).toString("hex");
const h = (name: string) => `cs${tag}_${name}`;
const ADMIN = "tunde"; // a dev admin (DEV_ADMIN_HANDLES)
const installs = new Map<string, string>();
const installOf = (handle: string) => installs.get(handle) ?? installs.set(handle, `sim-${tag}-${randomBytes(8).toString("hex")}`).get(handle)!;

/** Like sim-lib's call(), with the player's install id on every request (signed out when handle is null). */
async function call<T = any>(handle: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = body === undefined ? {} : { "content-type": "application/json" };
  if (handle) Object.assign(headers, { "x-dev-user": handle, [INSTALL_ID_HEADER]: installOf(handle) });
  const res = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}
async function api<T = any>(handle: string | null, method: string, path: string, body?: unknown): Promise<T> {
  const r = await call<T>(handle, method, path, body);
  if (r.status >= 300) throw new Error(`${method} ${path} → ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}
const idOf = async (handle: string) => (await db.select({ id: users.id }).from(users).where(eq(users.handle, handle)))[0].id;

/** Make a free private party for `host`, seat `players`, wait for its questions. */
async function openParty(host: string, players: string[], title: string) {
  const party = await api(host, "POST", "/parties", {
    title, brief: "Nigerian general knowledge: cities, food, music", entryKobo: 0, maxPlayers: 6, funding: "pooled", split: "winner",
    startsAt: inMinutes(30), questionCount: 3, secondsPerQuestion: 5, visibility: "private",
  });
  for (const p of players) await api(p, "POST", `/parties/${party.id}/join`);
  await waitFor(async () => (await api(host, "GET", `/parties/${party.id}`)).questions.status === "ready" || null, { tries: 120, everyMs: 500 });
  return party.id as string;
}

/** Play it to the end with everyone answering every question right (so they're real players). */
async function play(partyId: string, players: string[]) {
  const rooms: Room[] = [];
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  for (const handle of players) {
    const room = await new Client(RT).joinOrCreate(PARTY_ROOM, { partyId, devUser: handle });
    for (const t of [MSG.phase, MSG.reveal, MSG.standings, MSG.presence, MSG.chatMessage, MSG.questionsStatus, MSG.questionVoided, MSG.error]) room.onMessage(t, () => {});
    room.onMessage(MSG.question, async (view: { questionId: string }) => {
      const [q] = await db.select().from(partyQuestions).where(eq(partyQuestions.id, view.questionId));
      room.send(MSG.answer, correctAnswer(q.format as QuestionFormat, q.payload));
    });
    room.onMessage(MSG.finalStandings, () => resolveDone());
    rooms.push(room);
  }
  await (await partyQueue().getJob(`start-${partyId}`))?.promote();
  await Promise.race([done, sleep(150_000)]);
  for (const r of rooms) await r.leave().catch(() => {});
  return waitFor(async () => (await api(players[0], "GET", `/parties/${partyId}`)).status === "finished" || null, { tries: 60, everyMs: 500 });
}

const [HOST, OTHER_HOST, P1, P2, UNVERIFIED, SAME_DEVICE, BROUGHT, Q2, FAN, MUTED] =
  ["host", "otherhost", "p1", "p2", "unverified", "samedevice", "brought", "q2", "fan", "muted"].map(h);

const originalConfig = await api(ADMIN, "GET", "/admin/corners/config");
try {
  // Everyone's first request records their install id. SAME_DEVICE is on FAN's phone (FAN plays no part in N).
  for (const p of [HOST, OTHER_HOST, P1, P2, UNVERIFIED, BROUGHT, Q2, FAN, MUTED]) await api(p, "GET", "/me");
  installs.set(SAME_DEVICE, installOf(FAN));
  await api(SAME_DEVICE, "GET", "/me");
  await db.update(users).set({ emailVerifiedAt: null }).where(eq(users.handle, UNVERIFIED)); // TEST-ONLY
  await api(ADMIN, "PUT", "/admin/corners/config", { config: { partiesHosted: 2, realPlayersPerParty: 2, distinctPlayers: 3, newPlayers: 2 }, reason: `sim:corners ${tag}` });

  // ---- 1 and 2. playing until the host unlocks ----------------------------------------------

  console.log("\n1. Playing until a host unlocks");
  const first = await openParty(HOST, [P1, P2, UNVERIFIED], `Corner sim ${tag} #1`);
  const elsewhere = await openParty(OTHER_HOST, [BROUGHT, Q2], `Corner sim ${tag} elsewhere`);
  const played = await Promise.all([play(first, [HOST, P1, P2, UNVERIFIED]), play(elsewhere, [OTHER_HOST, BROUGHT, Q2])]);
  ok(played.every(Boolean), "the first round of parties is played and settled");
  const after1 = await api(HOST, "GET", "/me/corner/progress");
  ok(after1.corner?.status === "locked" && after1.thresholds.partiesHosted.have === 1 && !after1.allMet, "after one party: locked, P 1 of 2");
  ok(after1.parties[0]?.realPlayers === 3 && after1.parties[0]?.counts, "the party counted, with three real players (the host isn't one)");

  const second = await openParty(HOST, [P1, SAME_DEVICE, BROUGHT], `Corner sim ${tag} #2`);
  ok(!!(await play(second, [HOST, P1, SAME_DEVICE, BROUGHT])), "the second party is played and settled");
  const after2 = await api(HOST, "GET", "/me/corner/progress");
  ok(after2.corner?.status === "unlocked" && after2.corner.level === 1 && after2.allMet, "after the second: unlocked, level 1, the moment all four are met");
  ok(after2.thresholds.distinctPlayers.have === 5 && after2.thresholds.newPlayers.have === 2, "D 5 (P1, P2, the unverified, same device, brought), N 2 (P1 and P2)");

  console.log("\n2. Who counts for N");
  const np = (handle: string) => after2.newPlayers.find((n: any) => n.person.handle === handle);
  ok(np(P1)?.status === "counted" && np(P2)?.status === "counted", "new players with a verified email and their own device count");
  ok(np(UNVERIFIED)?.status === "excluded" && np(UNVERIFIED)?.reason === "email_not_verified", "an unverified email doesn't count");
  ok(np(SAME_DEVICE)?.status === "excluded" && np(SAME_DEVICE)?.reason === "install_seen_on_another_account", "an install id seen on another account doesn't count");
  ok(!np(BROUGHT), "a player another host brought first doesn't count for this one");
  ok((await api(OTHER_HOST, "GET", "/me/corner/progress")).newPlayers.some((n: any) => n.person.handle === BROUGHT && n.status === "counted"), "they count for the host who brought them");

  const cornerId: string = after2.corner.id;
  const [alert] = await db.select().from(adminAlerts).where(and(eq(adminAlerts.refType, "corner"), eq(adminAlerts.refId, cornerId)));
  ok(alert?.kind === "corner.unlocked" && alert.severity === "info", "admins get an info alert for the unlock");
  ok(JSON.stringify(alert?.details.newPlayers ?? []).includes(P1), "naming who made up N");
  const adminView = await api(ADMIN, "GET", `/admin/corners/hosts/${await idOf(HOST)}`);
  ok(adminView.unlockContributors.map((p: any) => p.handle).sort().join() === [P1, P2].sort().join(), "the admin's view of the host lists the contributors");

  // ---- 3. follows ---------------------------------------------------------------------------

  console.log("\n3. Follows");
  await api(HOST, "PATCH", "/me/corner", { name: `Corner ${tag}`, bio: "Quiz night, every night." });
  const f = await api(FAN, "POST", `/corners/${cornerId}/follow`);
  ok(f.following && f.notify && f.followerCount === 1, "following a corner: alerts on by default, count on the corner");
  ok((await api(FAN, "PATCH", `/corners/${cornerId}/follow`, { notify: false })).notify === false, "alerts can be turned off per corner");
  ok((await api(FAN, "DELETE", `/corners/${cornerId}/follow`)).following === false, "unfollow");
  await api(FAN, "POST", `/corners/${cornerId}/follow`);
  for (const p of [MUTED, P1, P2]) await api(p, "POST", `/corners/${cornerId}/follow`);
  const list = await api(null, "GET", `/corners/${cornerId}/followers?limit=2`);
  ok(list.total === 4 && list.followers.length === 2 && !!list.before, "the follower list is public and paged");
  const asP1 = await api(P1, "GET", `/corners/${cornerId}/followers`);
  ok(asP1.yourPeople.count === 1 && asP1.yourPeople.faces[0]?.handle === P2, "with how many of your people follow it on top");
  ok((await api(FAN, "GET", "/me/follows")).some((x: any) => x.corner.id === cornerId), "your own follows");
  ok((await api(FAN, "GET", `/users/${HOST}`)).corner?.id === cornerId, "the host's profile points to the corner");
  ok((await call(FAN, "POST", `/users/${await idOf(HOST)}/follow`)).status === 404, "people can't be followed any more");

  // ---- 4. posts -----------------------------------------------------------------------------

  console.log("\n4. A post, a reaction, a reply, a mute");
  const post = await api(HOST, "POST", `/corners/${cornerId}/posts`, { text: "Rematch Friday. Bring your people." });
  ok(!!post.id && post.text.startsWith("Rematch"), "the host posts");
  const reacted = await api(FAN, "PUT", `/corner-posts/${post.id}/reaction`, { emoji: "🔥" });
  ok(reacted.mine === "🔥" && reacted.reactions[0]?.count === 1, "a follower reacts");
  const reply = await api(FAN, "POST", `/corner-posts/${post.id}/replies`, { text: "I'm in", clientMsgId: randomUUID() });
  ok(reply.reply.text === "I'm in" && !reply.duplicate, "a follower replies");
  await api(HOST, "POST", `/corners/${cornerId}/mutes`, { userId: await idOf(MUTED) });
  const mutedReply = await call(MUTED, "POST", `/corner-posts/${post.id}/replies`, { text: "anyone?", clientMsgId: randomUUID() });
  ok(mutedReply.status === 201, "a muted follower's reply looks sent to them");
  const replies = async (who: string | null) => (await api(who, "GET", `/corner-posts/${post.id}/replies`)).replies.map((r: any) => r.text);
  ok((await replies(MUTED)).includes("anyone?") && !(await replies(FAN)).includes("anyone?") && !(await replies(null)).includes("anyone?"), "but only they see it");
  ok((await call(Q2, "POST", `/corner-posts/${post.id}/replies`, { text: "hi", clientMsgId: randomUUID() })).body.error === "follow_to_take_part", "only followers take part");

  // ---- 5. DMs -------------------------------------------------------------------------------

  console.log("\n5. The DM rule");
  ok((await api(FAN, "GET", `/users/${HOST}`)).canMessage === "request", "following someone's corner doesn't open DMs");
  ok((await api(P1, "GET", `/users/${P2}`)).canMessage === "direct", "finishing a party together does");

  // ---- 6. your people -----------------------------------------------------------------------

  console.log("\n6. Your people");
  const board = await api(P1, "GET", "/leaderboards/friends");
  ok(board.rows.some((r: any) => r.person.handle === P2) && !board.rows.some((r: any) => r.person.handle === FAN), "the friends board is your people (played together), not followers");
  const lobby = await openParty(Q2, [P2], `Corner sim ${tag} lobby`);
  await api(Q2, "POST", `/parties/${lobby}/invites`, { userIds: [await idOf(BROUGHT)] });
  ok((await api(P1, "GET", `/parties/${lobby}`)).friendsIn.people.some((p: any) => p.handle === P2), "the lobby names your people who are in");
  await api(Q2, "POST", `/parties/${lobby}/cancel`, { reason: "sim" });
  const feed = await api(FAN, "GET", "/feed");
  ok(feed.events.some((e: any) => e.kind === "corner_post" && e.data.postId === post.id), "the corner's post is in its followers' feed");
  const page = await api(FAN, "GET", `/corners/${cornerId}`);
  ok(page.corner.name === `Corner ${tag}` && page.posts.posts[0]?.id === post.id && page.viewer.following, "the corner page: name, posts, your follow");
  ok(page.winners.length === 0 && page.upNext.length === 0, "private parties stay off the corner page");

  // ---- revoke --------------------------------------------------------------------------------

  const revoked = await call(ADMIN, "POST", `/admin/corners/${cornerId}/revoke`, { reason: `sim:corners ${tag}` });
  ok(revoked.status === 200 && revoked.body.corner.status === "revoked", "an admin revokes it, with a reason");
  ok((await call(FAN, "GET", `/corners/${cornerId}`)).status === 404, "and it's gone");
} finally {
  const { partiesHosted, realPlayersPerParty, distinctPlayers, newPlayers } = originalConfig;
  await call(ADMIN, "PUT", "/admin/corners/config", { config: { partiesHosted, realPlayersPerParty, distinctPlayers, newPlayers }, reason: `sim:corners ${tag}: put back` });
}

const failed = failureCount();
console.log(failed ? `\n✗ corners sim: ${failed} check(s) failed` : "\n✓ corners sim passed");
process.exit(failed ? 1 : 0);

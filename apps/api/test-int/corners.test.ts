/**
 * Corners (ADR 0012, row 6c) against the real database: counting a party (R), each threshold, each new-player
 * rule, the unlock alerts, revoke, bans, follows and the public follower list, every place "your people"
 * replaced person follows, the DM rule, post moderation, the interim Parties sort and the follow migration.
 * Unlock thresholds for this file: P 2, R 3, D 4, N 2 (a version of its own, set back after).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql as dsql } from "drizzle-orm";
import {
  adminActions, adminAlerts, becomeMember, contactMatches, cornerNewPlayers, cornerParties, cornerPartyPlayers, corners, crewMembers, crews, db, dmPermissionBetween, feedEvents,
  getChatConfig, moderationItems, parties, partyAnswers, partyDays, partyPlayers, partyQuestions, playedWith, recordCornerProgress, recordPartyProgress, recordSignals, saveCornerConfig,
  setChatConfig, setSocialConfig, sql, users, yourPeople, type Party, type User,
} from "@contestly/db";
import { DEFAULT_CHAT_CONFIG, DEFAULT_CORNER_UNLOCK, DEFAULT_SOCIAL_CONFIG, celebrationSeenSchema, lagosDay, myContactsSchema, weekOf } from "@contestly/shared";
import { setWeekPoints } from "../src/climb/boards.js";
import { as, makeUser, tag, testApp } from "./harness.js";

let app: Awaited<ReturnType<typeof testApp>>["app"];
let admin: User;
let seq = 0;

const TEST_UNLOCK = { partiesHosted: 2, realPlayersPerParty: 3, distinctPlayers: 4, newPlayers: 2 };
const ip = () => `10.${randomBytes(3).join(".")}`;
const install = () => `inst-${tag}-${String(++seq).padStart(8, "0")}`;

/** A fresh account with its own install id and IP (or the ones given), as the API would have recorded them. */
async function person(name: string, o: { install?: string | null; ip?: string; extra?: Partial<typeof users.$inferInsert> } = {}) {
  const u = await makeUser(`${name}${++seq}`, o.extra);
  await recordSignals(u.id, { installId: o.install === undefined ? install() : o.install, ip: o.ip ?? ip() });
  return u;
}

/**
 * A party `host` hosted, finished now: these seats (in rank order), one question, an answer from everyone in
 * `answered` (default: all seated), then the worker's record_progress job (corners and played-with).
 */
async function finish(host: User, seated: User[], o: { answered?: User[]; at?: Date } = {}): Promise<Party> {
  const at = o.at ?? new Date();
  const [p] = await db.insert(parties).values({
    createdByUserId: host.id, title: "Corner test", category: "General knowledge", maxPlayers: 30, funding: "pooled", split: [100], status: "finished", startsAt: at, endedAt: at,
  }).returning();
  for (const [i, u] of seated.entries()) await db.insert(partyPlayers).values({ partyId: p.id, userId: u.id, rank: i + 1, score: 100 - i });
  const [q] = await db.insert(partyQuestions).values({ partyId: p.id, idx: 0, format: "pick_one", payload: {}, seconds: 10 }).returning();
  const answered = o.answered ?? seated;
  if (answered.length) await db.insert(partyAnswers).values(answered.map((u) => ({ partyId: p.id, questionId: q.id, userId: u.id, answer: { choice: 0 }, answeredMs: 900 })));
  await recordPartyProgress(p.id);
  return p;
}

const progress = async (host: User) => (await app.inject({ url: "/me/corner/progress", headers: as(host) })).json();
const cornerRow = async (host: User) => (await db.select().from(corners).where(eq(corners.ownerUserId, host.id)))[0];
const newPlayerRow = async (u: User) => (await db.select().from(cornerNewPlayers).where(eq(cornerNewPlayers.userId, u.id)))[0];
const alertsFor = (cornerId: string) => db.select().from(adminAlerts).where(and(eq(adminAlerts.refType, "corner"), eq(adminAlerts.refId, cornerId)));
const contact = (a: User, b: User) => db.insert(contactMatches).values({ userId: a.id, contactUserId: b.id }).onConflictDoNothing();
/** An unlocked corner, straight to the database (as a seed or a brand's would be). */
async function unlockedCorner(owner: User) {
  const [c] = await db.insert(corners).values({ ownerUserId: owner.id, name: `${owner.displayName}'s corner`, status: "unlocked", unlockedAt: new Date() })
    .onConflictDoUpdate({ target: corners.ownerUserId, set: { status: "unlocked", unlockedAt: new Date() } }).returning();
  return c;
}

beforeAll(async () => {
  ({ app } = await testApp());
  admin = await makeUser("cadmin", { isAdmin: true });
  await db.transaction((tx) => saveCornerConfig(tx, TEST_UNLOCK, admin.id));
});

afterAll(async () => {
  await db.transaction((tx) => saveCornerConfig(tx, DEFAULT_CORNER_UNLOCK, admin.id));
  await setSocialConfig(DEFAULT_SOCIAL_CONFIG);
  await setChatConfig(DEFAULT_CHAT_CONFIG);
  await app.close();
  await sql.end();
});

// ---- R: what counts as a party, and a real player ---------------------------------------

describe("counting a party (R)", () => {
  it("counts only signed-in players who answered, never the host, a guest or a banned player", async () => {
    const host = await person("rhost");
    const [a, b, silent] = [await person("ra"), await person("rb"), await person("rsilent")];
    const guest = await person("rguest", { extra: { isGuest: true, email: null, emailVerifiedAt: null } });
    const banned = await person("rbanned", { extra: { bannedAt: new Date() } });
    const p = await finish(host, [host, a, b, silent, guest, banned], { answered: [host, a, b, guest, banned] });
    const [row] = await db.select().from(cornerParties).where(eq(cornerParties.partyId, p.id));
    expect(row).toMatchObject({ hostUserId: host.id, realPlayers: 2, counts: false }); // a and b: under R = 3
    expect(await db.select().from(cornerPartyPlayers).where(eq(cornerPartyPlayers.partyId, p.id))).toEqual([]);
  });

  it("counts a party with exactly R real players, and records them for D", async () => {
    const host = await person("r2host");
    const players = [await person("r2a"), await person("r2b"), await person("r2c")];
    const p = await finish(host, players);
    expect((await db.select().from(cornerParties).where(eq(cornerParties.partyId, p.id)))[0]).toMatchObject({ realPlayers: 3, counts: true });
    expect((await db.select().from(cornerPartyPlayers).where(eq(cornerPartyPlayers.partyId, p.id))).map((r) => r.userId).sort()).toEqual(players.map((u) => u.id).sort());
  });

  it("records a party once, however often its corner step runs", async () => {
    const host = await person("r3host");
    const p = await finish(host, [await person("r3a"), await person("r3b"), await person("r3c")]);
    const seats = await db.select({ userId: partyPlayers.userId, isGuest: users.isGuest, bannedAt: users.bannedAt }).from(partyPlayers).innerJoin(users, eq(users.id, partyPlayers.userId)).where(eq(partyPlayers.partyId, p.id));
    await db.transaction((tx) => recordCornerProgress(tx, p, seats));
    expect((await progress(host)).thresholds.partiesHosted.have).toBe(1);
  });
});

// ---- each threshold ---------------------------------------------------------------------

describe("thresholds", () => {
  it("P short: one counted party isn't enough, whatever else is met", async () => {
    const host = await person("phost");
    await finish(host, [await person("pa"), await person("pb"), await person("pc"), await person("pd")]);
    const pr = await progress(host);
    expect(pr.thresholds).toEqual({ partiesHosted: { need: 2, have: 1, met: false }, distinctPlayers: { need: 4, have: 4, met: true }, newPlayers: { need: 2, have: 4, met: true } });
    expect(pr.allMet).toBe(false);
    expect(pr.corner.status).toBe("locked");
  });

  it("D short: the same three players twice are three distinct players", async () => {
    const host = await person("dhost");
    const same = [await person("da"), await person("db"), await person("dc")];
    await finish(host, same);
    await finish(host, same);
    const pr = await progress(host);
    expect(pr.thresholds.partiesHosted.met && pr.thresholds.newPlayers.met).toBe(true);
    expect(pr.thresholds.distinctPlayers).toEqual({ need: 4, have: 3, met: false });
    expect(pr.corner.status).toBe("locked");
  });

  it("N short: players who came to Contestly through someone else bring nobody", async () => {
    const elsewhere = await person("nelse");
    const old = [await person("na"), await person("nb"), await person("nc"), await person("nd")];
    await finish(elsewhere, old); // their first party
    const host = await person("nhost");
    await finish(host, old.slice(0, 3));
    await finish(host, old.slice(1));
    const pr = await progress(host);
    expect(pr.thresholds.partiesHosted.met && pr.thresholds.distinctPlayers.met).toBe(true);
    expect(pr.thresholds.newPlayers).toEqual({ need: 2, have: 0, met: false });
    expect(pr.corner.status).toBe("locked");
  });

  it("unlocks the moment all four are met, at level 1, keeping the config version and who made up N", async () => {
    const host = await person("uhost");
    const [a, b, c, d] = [await person("ua"), await person("ub"), await person("uc"), await person("ud")];
    await finish(host, [a, b, c]);
    expect((await cornerRow(host)).status).toBe("locked");
    await finish(host, [a, b, d]);
    const corner = await cornerRow(host);
    expect(corner).toMatchObject({ status: "unlocked", level: 1, unlockConfigVersion: (await progress(host)).config.version });
    expect(corner.unlockContributors.sort()).toEqual([a, b, c, d].map((u) => u.id).sort());
    expect((await app.inject({ url: `/corners/${corner.id}` })).statusCode).toBe(200);
  });
});

// ---- N: who counts as a new player ------------------------------------------------------

describe("new players (N)", () => {
  it("an unverified email doesn't count", async () => {
    const host = await person("n1host");
    const u = await person("unverified", { extra: { emailVerifiedAt: null } });
    await finish(host, [u, await person("n1b"), await person("n1c")]);
    expect(await newPlayerRow(u)).toMatchObject({ hostUserId: host.id, status: "excluded", reason: "email_not_verified" });
  });

  it("no install id doesn't count", async () => {
    const host = await person("n2host");
    const u = await person("noinstall", { install: null });
    await finish(host, [u, await person("n2b"), await person("n2c")]);
    expect(await newPlayerRow(u)).toMatchObject({ status: "excluded", reason: "no_install_id" });
  });

  it("an install id seen on another account doesn't count", async () => {
    const shared = install();
    await person("firstondevice", { install: shared });
    const host = await person("n3host");
    const u = await person("secondondevice", { install: shared });
    await finish(host, [u, await person("n3b"), await person("n3c")]);
    expect(await newPlayerRow(u)).toMatchObject({ status: "excluded", reason: "install_seen_on_another_account" });
  });

  it("an install id seen only on a guest (who never signed up) still counts", async () => {
    const shared = install();
    await person("guestondevice", { install: shared, extra: { isGuest: true, email: null, emailVerifiedAt: null } });
    const host = await person("n4host");
    const u = await person("afterguest", { install: shared });
    await finish(host, [u, await person("n4b"), await person("n4c")]);
    expect(await newPlayerRow(u)).toMatchObject({ status: "counted", reason: null });
  });

  it("counts for the first host only: a second host gets nothing from them", async () => {
    const [first, second] = [await person("n5first"), await person("n5second")];
    const u = await person("loyal");
    await finish(first, [u, await person("n5b"), await person("n5c")]);
    await finish(second, [u, await person("n5d"), await person("n5e")]);
    expect(await newPlayerRow(u)).toMatchObject({ hostUserId: first.id, via: "first_party", status: "counted" });
    expect((await progress(second)).newPlayers.map((n: { person: { id: string } }) => n.person.id)).not.toContain(u.id);
  });

  it("signing up from a host's invite makes them that host's; they count once they finish one of the host's parties", async () => {
    const host = await person("n6host");
    const [invite] = await db.insert(parties).values({ createdByUserId: host.id, title: "Invite", category: "General knowledge", maxPlayers: 10, funding: "pooled", split: [100], startsAt: new Date(Date.now() + 3_600_000) }).returning();
    const g = await person("invited", { extra: { isGuest: true, email: null, emailVerifiedAt: null, invitePartyId: invite.id } });
    await db.transaction((tx) => becomeMember(tx, g.id, `invited-${tag}@test.contestly.invalid`));
    expect(await newPlayerRow(g)).toMatchObject({ hostUserId: host.id, via: "invite", status: "pending", partyId: invite.id });
    const other = await person("n6other");
    await finish(other, [g, await person("n6b"), await person("n6c")]); // someone else's party doesn't change whose they are
    expect(await newPlayerRow(g)).toMatchObject({ hostUserId: host.id, status: "pending" });
    await finish(host, [g, await person("n6d"), await person("n6e")]);
    expect(await newPlayerRow(g)).toMatchObject({ hostUserId: host.id, status: "counted" });
  });

  it("a guest who finished a host's party and then signs up counts for that host at once", async () => {
    const host = await person("n7host");
    const g = await person("guestfirst", { extra: { isGuest: true, email: null, emailVerifiedAt: null } });
    await finish(host, [g, await person("n7b"), await person("n7c")]);
    expect(await newPlayerRow(g)).toBeUndefined(); // guests aren't anyone's yet
    await db.transaction((tx) => becomeMember(tx, g.id, `guestfirst-${tag}@test.contestly.invalid`));
    expect(await newPlayerRow(g)).toMatchObject({ hostUserId: host.id, via: "first_party", status: "counted" });
  });
});

// ---- alerts, revoke and bans --------------------------------------------------------------

describe("unlock alerts", () => {
  it("raises info naming who made up N when nothing is shared", async () => {
    const host = await person("ahost");
    const [a, b, c, d] = [await person("aa"), await person("ab"), await person("ac"), await person("ad")];
    await finish(host, [a, b, c]);
    await finish(host, [a, b, d]);
    const [alert] = await alertsFor((await cornerRow(host)).id);
    expect(alert).toMatchObject({ kind: "corner.unlocked", severity: "info" });
    expect((alert.details.newPlayers as { id: string }[]).map((p) => p.id).sort()).toEqual([a, b, c, d].map((u) => u.id).sort());
    expect(alert.details.clustered).toEqual([]);
  });

  it("raises a warning instead when several of the N share an IP with each other or the host", async () => {
    const shared = ip();
    const host = await person("whost", { ip: shared });
    const [a, b, c] = [await person("wa", { ip: shared }), await person("wb", { ip: shared }), await person("wc")];
    await finish(host, [a, b, c]);
    await finish(host, [a, c, await person("wd")]);
    const [alert] = await alertsFor((await cornerRow(host)).id);
    expect(alert).toMatchObject({ kind: "corner.unlock_cluster", severity: "warning" });
    expect((alert.details.clustered as { id: string }[]).map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });
});

describe("the unlock celebration", () => {
  it("progress has unlockedAt and celebrationSeenAt; seen once, a repeat keeps the first time; refused before unlock", async () => {
    const host = await person("chost");
    const celebrate = () => app.inject({ method: "POST", url: "/me/corner/celebration-seen", headers: as(host) });
    expect((await celebrate()).json().error).toBe("corner_not_unlocked"); // no corner yet
    const [a, b] = [await person("ca"), await person("cb")];
    await finish(host, [a, b, await person("cc")]);
    expect((await celebrate()).json().error).toBe("corner_not_unlocked"); // locked
    await finish(host, [a, b, await person("cd")]);
    const before = await progress(host);
    expect(before.corner).toMatchObject({ status: "unlocked", celebrationSeenAt: null });
    expect(before.corner.unlockedAt).toEqual(expect.any(String));
    const first = await celebrate();
    expect(first.statusCode).toBe(200);
    const seenAt = celebrationSeenSchema.parse(first.json()).celebrationSeenAt;
    expect((await progress(host)).corner.celebrationSeenAt).toBe(seenAt);
    expect((await celebrate()).json().celebrationSeenAt).toBe(seenAt);
    expect((await app.inject({ method: "POST", url: "/me/corner/celebration-seen" })).statusCode).toBe(401);
  });
});

describe("revoke", () => {
  let host: User, cornerId: string;
  beforeAll(async () => {
    host = await person("vhost");
    const [a, b] = [await person("va"), await person("vb")];
    await finish(host, [a, b, await person("vc")]);
    await finish(host, [a, b, await person("vd")]);
    cornerId = (await cornerRow(host)).id;
  });

  it("is admins only, with a reason", async () => {
    expect((await app.inject({ method: "POST", url: `/admin/corners/${cornerId}/revoke`, headers: as(host), payload: { reason: "x" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/admin/corners/${cornerId}/revoke`, headers: as(admin), payload: {} })).statusCode).toBe(400);
  });

  it("hides the corner, logs who and why, and shows in the admin's view of the host", async () => {
    const res = await app.inject({ method: "POST", url: `/admin/corners/${cornerId}/revoke`, headers: as(admin), payload: { reason: "farmed: one household" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ corner: { status: "revoked" }, revoked: { by: { id: admin.id }, reason: "farmed: one household" } });
    expect(res.json().unlockContributors).toHaveLength(4);
    expect((await app.inject({ url: `/corners/${cornerId}` })).statusCode).toBe(404);
    const [log] = await db.select().from(adminActions).where(and(eq(adminActions.action, "corner.revoke"), eq(adminActions.targetId, cornerId)));
    expect(log).toMatchObject({ adminUserId: admin.id, reason: "farmed: one household", before: { status: "unlocked" }, after: { status: "revoked" } });
  });

  it("stays revoked: a second revoke is refused, and more play doesn't unlock it again", async () => {
    expect((await app.inject({ method: "POST", url: `/admin/corners/${cornerId}/revoke`, headers: as(admin), payload: { reason: "again" } })).json().error).toBe("corner_not_unlocked");
    await finish(host, [await person("ve"), await person("vf"), await person("vg")]);
    expect((await cornerRow(host)).status).toBe("revoked");
  });
});

describe("bans", () => {
  let host: User, a: User, b: User, cornerId: string;
  beforeAll(async () => {
    host = await person("bhost");
    [a, b] = [await person("ba"), await person("bb")];
    await finish(host, [a, b, await person("bc", { install: null })]); // bc doesn't count for N
    await finish(host, [a, b, await person("bd", { install: null })]);
    cornerId = (await cornerRow(host)).id;
  });

  it("banning a new player takes them out of N, and an unlocked corner that drops below raises a warning", async () => {
    expect((await progress(host)).thresholds.newPlayers.have).toBe(2);
    expect((await app.inject({ method: "POST", url: `/admin/users/${a.id}/ban`, headers: as(admin), payload: { reason: "farm account" } })).statusCode).toBe(200);
    const view = (await app.inject({ url: `/admin/corners/hosts/${host.id}`, headers: as(admin) })).json();
    expect(view.thresholds.newPlayers).toEqual({ need: 2, have: 1, met: false });
    expect(view.newPlayers.find((n: { person: { id: string } }) => n.person.id === a.id)).toMatchObject({ banned: true, status: "counted" });
    expect((await alertsFor(cornerId)).some((x) => x.kind === "corner.below_threshold" && x.severity === "warning")).toBe(true);
    expect((await cornerRow(host)).status).toBe("unlocked"); // not taken away automatically
  });

  it("unbanning puts them back", async () => {
    await app.inject({ method: "POST", url: `/admin/users/${a.id}/unban`, headers: as(admin), payload: { reason: "appeal" } });
    expect((await progress(host)).thresholds.newPlayers.have).toBe(2);
  });

  it("banning the host hides their corner; unbanning brings it back", async () => {
    await app.inject({ method: "POST", url: `/admin/users/${host.id}/ban`, headers: as(admin), payload: { reason: "test" } });
    expect((await app.inject({ url: `/corners/${cornerId}` })).statusCode).toBe(404);
    await app.inject({ method: "POST", url: `/admin/users/${host.id}/unban`, headers: as(admin), payload: { reason: "test" } });
    expect((await app.inject({ url: `/corners/${cornerId}` })).statusCode).toBe(200);
  });
});

describe("admin config", () => {
  it("shows and saves the thresholds as a new version, logged with a reason", async () => {
    const before = (await app.inject({ url: "/admin/corners/config", headers: as(admin) })).json();
    expect(before).toMatchObject(TEST_UNLOCK);
    expect((await app.inject({ method: "PUT", url: "/admin/corners/config", headers: as(admin), payload: { config: TEST_UNLOCK } })).statusCode).toBe(400);
    const saved = (await app.inject({ method: "PUT", url: "/admin/corners/config", headers: as(admin), payload: { config: TEST_UNLOCK, reason: "same again, new version" } })).json();
    expect(saved.version).toBe(before.version + 1);
    const [log] = await db.select().from(adminActions).where(and(eq(adminActions.action, "config.corners"), eq(adminActions.reason, "same again, new version")));
    expect(log.after).toMatchObject({ version: saved.version });
  });
});

// ---- follows and followers ----------------------------------------------------------------

describe("follows", () => {
  let owner: User, fan: User, corner: { id: string };
  beforeAll(async () => {
    owner = await person("fowner");
    fan = await person("ffan");
    corner = await unlockedCorner(owner);
  });

  it("follows and unfollows a corner, alerts on by default, with the count on the corner", async () => {
    const f = await app.inject({ method: "POST", url: `/corners/${corner.id}/follow`, headers: as(fan) });
    expect(f.json()).toEqual({ following: true, notify: true, followerCount: 1 });
    expect((await app.inject({ method: "PATCH", url: `/corners/${corner.id}/follow`, headers: as(fan), payload: { notify: false } })).json()).toMatchObject({ notify: false });
    expect((await app.inject({ url: "/me/follows", headers: as(fan) })).json()).toMatchObject([{ corner: { id: corner.id, followerCount: 1, owner: { id: owner.id } }, notify: false }]);
    expect((await app.inject({ method: "DELETE", url: `/corners/${corner.id}/follow`, headers: as(fan) })).json()).toEqual({ following: false, notify: false, followerCount: 0 });
    expect((await app.inject({ method: "PATCH", url: `/corners/${corner.id}/follow`, headers: as(fan), payload: { notify: true } })).json().error).toBe("not_following");
  });

  it("refuses your own corner, a locked one and guests", async () => {
    expect((await app.inject({ method: "POST", url: `/corners/${corner.id}/follow`, headers: as(owner) })).json().error).toBe("cannot_follow_own_corner");
    const lockedHost = await person("flocked");
    await finish(lockedHost, []);
    expect((await app.inject({ method: "POST", url: `/corners/${(await cornerRow(lockedHost)).id}/follow`, headers: as(fan) })).statusCode).toBe(404);
    const guest = await person("fguest", { extra: { isGuest: true, email: null, emailVerifiedAt: null } });
    expect((await app.inject({ method: "POST", url: `/corners/${corner.id}/follow`, headers: as(guest) })).json().error).toBe("sign_up_required");
  });

  it("people aren't followed any more: the routes are gone and profiles carry the corner instead", async () => {
    expect((await app.inject({ method: "POST", url: `/users/${owner.id}/follow`, headers: as(fan) })).statusCode).toBe(404);
    expect((await app.inject({ url: `/users/${owner.handle}/followers` })).statusCode).toBe(404);
    await app.inject({ method: "POST", url: `/corners/${corner.id}/follow`, headers: as(fan) });
    const profile = (await app.inject({ url: `/users/${owner.handle}`, headers: as(fan) })).json();
    expect(profile).not.toHaveProperty("followers");
    expect(profile).not.toHaveProperty("viewer");
    expect(profile.corner).toEqual({ id: corner.id, name: `${owner.displayName}'s corner`, following: true });
    expect((await app.inject({ url: `/users/${fan.handle}`, headers: as(owner) })).json().corner).toBeNull();
  });

  it("the lobby shows the host's corner with the viewer's follow", async () => {
    const [p] = await db.insert(parties).values({ createdByUserId: owner.id, title: "Lobby", category: "General knowledge", maxPlayers: 10, funding: "pooled", split: [100], startsAt: new Date(Date.now() + 3_600_000) }).returning();
    expect((await app.inject({ url: `/parties/${p.id}`, headers: as(fan) })).json().hostCorner).toEqual({ id: corner.id, name: `${owner.displayName}'s corner`, following: true });
  });
});

describe("the public follower list", () => {
  let corner: { id: string }, viewer: User, followers: User[];
  beforeAll(async () => {
    corner = await unlockedCorner(await person("lowner"));
    viewer = await person("lviewer");
    followers = [];
    for (let i = 0; i < 5; i++) followers.push(await person(`lf${i}`));
    // Newest first is followers[4] … followers[0]; two of them are the viewer's contacts.
    for (const [i, f] of followers.entries()) await db.execute(dsql`insert into follows (follower_id, corner_id, created_at) values (${f.id}, ${corner.id}, ${new Date(Date.now() - (10 - i) * 60_000).toISOString()}::timestamptz)`);
    await contact(viewer, followers[1]);
    await contact(followers[3], viewer);
  });

  it("is public, newest first, a page at a time, with how many of your people follow on top", async () => {
    const seen: string[] = [];
    let before: string | null = null;
    let pages = 0;
    do {
      const res = (await app.inject({ url: `/corners/${corner.id}/followers?limit=2${before ? `&before=${encodeURIComponent(before)}` : ""}`, headers: as(viewer) })).json();
      expect(res.total).toBe(5);
      expect(res.yourPeople.count).toBe(2);
      expect(res.yourPeople.faces.map((p: { id: string }) => p.id).sort()).toEqual([followers[1].id, followers[3].id].sort());
      for (const f of res.followers) {
        seen.push(f.person.id);
        expect(f.isYourPerson).toBe([followers[1].id, followers[3].id].includes(f.person.id));
      }
      before = res.before;
      pages++;
    } while (before);
    expect(pages).toBe(3);
    expect(seen).toEqual([...followers].reverse().map((u) => u.id));
  });

  it("is readable signed out, with none of your people", async () => {
    const res = (await app.inject({ url: `/corners/${corner.id}/followers` })).json();
    expect(res).toMatchObject({ total: 5, yourPeople: { count: 0, faces: [] }, before: null });
  });
});

// ---- your people ---------------------------------------------------------------------------

describe("your people replaced follows", () => {
  let me: User, crewmate: User, theirContact: User, myContact: User, recent: User, longAgo: User, stranger: User, host: User, hostCorner: { id: string };
  beforeAll(async () => {
    [me, crewmate, theirContact, myContact, recent, longAgo, stranger, host] = await Promise.all(
      ["yme", "ycrew", "ytheirs", "ymine", "yrecent", "yold", "ystranger", "yhost"].map((n) => person(n)));
    const [crew] = await db.insert(crews).values({ name: "Y crew", emoji: "🧪", color: "#123456", createdByUserId: me.id }).returning();
    await db.insert(crewMembers).values([{ crewId: crew.id, userId: me.id, role: "creator" }, { crewId: crew.id, userId: crewmate.id }]);
    await contact(theirContact, me); // they have my number
    await contact(me, myContact); // I have theirs
    await finish(stranger, [me, recent, await person("y3")]);
    const [x, y] = me.id < longAgo.id ? [me.id, longAgo.id] : [longAgo.id, me.id];
    await db.insert(playedWith).values({ userA: x, userB: y, parties: 3, lastPlayedAt: new Date(Date.now() - 40 * 86_400_000) });
    hostCorner = await unlockedCorner(host);
  });

  it("are crew mates, contacts either way and who you played with in the last 30 days; never you", async () => {
    const people = await yourPeople(me.id);
    for (const u of [crewmate, theirContact, myContact, recent]) expect(people.has(u.id)).toBe(true);
    for (const u of [longAgo, host, me]) expect(people.has(u.id)).toBe(false);
  });

  it("the window is config", async () => {
    await setSocialConfig({ ...DEFAULT_SOCIAL_CONFIG, yourPeopleDays: 60 });
    expect((await yourPeople(me.id)).has(longAgo.id)).toBe(true);
    await setSocialConfig(DEFAULT_SOCIAL_CONFIG);
  });

  it("GET /me/contacts: matched contacts either way, played or not, never a deleted or banned one; and they can be invited to a crew", async () => {
    const banned = await person("ybanned", { extra: { bannedAt: new Date() } });
    await contact(me, banned);
    const res = await app.inject({ url: "/me/contacts", headers: as(me) });
    expect(res.statusCode).toBe(200);
    const ids = myContactsSchema.parse(res.json()).contacts.map((p) => p.id).sort();
    expect(ids).toEqual([theirContact.id, myContact.id].sort()); // not the crew mate or who I played with
    expect((await app.inject({ url: "/me/contacts", headers: as(stranger) })).json()).toEqual({ contacts: [] });
    expect((await app.inject({ url: "/me/contacts" })).statusCode).toBe(401);
    // myContact has never played or scored: still invitable.
    const crew = (await app.inject({ method: "POST", url: "/crews", headers: as(me), payload: { name: "Contacts crew" } })).json();
    const inv = await app.inject({ method: "POST", url: `/crews/${crew.id}/invites`, headers: as(me), payload: { userIds: [myContact.id] } });
    expect(inv.statusCode).toBe(201);
    expect(inv.json().invited).toBe(1);
  });

  it("make up the friends board (Climb plus party points)", async () => {
    for (const u of [myContact, longAgo, host]) await db.insert(partyDays).values({ userId: u.id, day: lagosDay(), week: weekOf(lagosDay()), points: 30, parties: 1 });
    const ids = (await app.inject({ url: "/leaderboards/friends", headers: as(me) })).json().rows.map((r: { person: { id: string } }) => r.person.id);
    expect(ids).toContain(myContact.id);
    expect(ids).not.toContain(longAgo.id);
    expect(ids).not.toContain(host.id);
  });

  it("make up the Climb's Friends board", async () => {
    for (const u of [me, theirContact, longAgo]) await setWeekPoints(weekOf(lagosDay()), u.id, 40);
    const ids = (await app.inject({ url: "/climb/leaderboard?board=friends", headers: as(me) })).json().rows.map((r: { person: { id: string } }) => r.person.id);
    expect(ids).toContain(theirContact.id);
    expect(ids).not.toContain(longAgo.id);
  });

  it("make up mutuals on a profile: people who are both yours and theirs", async () => {
    await contact(myContact, crewmate); // crewmate is mine (crew) and myContact's (contact)
    const profile = (await app.inject({ url: `/users/${myContact.handle}`, headers: as(me) })).json();
    expect(profile.mutuals).toEqual({ count: 1, faces: [expect.objectContaining({ id: crewmate.id })] });
  });

  it("are who the lobby names as in", async () => {
    const [p] = await db.insert(parties).values({ createdByUserId: host.id, title: "Who's in", category: "General knowledge", maxPlayers: 10, funding: "pooled", split: [100], startsAt: new Date(Date.now() + 3_600_000) }).returning();
    for (const u of [myContact, longAgo]) await db.insert(partyPlayers).values({ partyId: p.id, userId: u.id });
    const card = (await app.inject({ url: `/parties/${p.id}`, headers: as(me) })).json();
    expect(card.friendsIn).toEqual({ people: [expect.objectContaining({ id: myContact.id })], count: 1 });
  });

  it("fill the feed, with posts from the corners you follow (and not the ones you don't)", async () => {
    await db.insert(feedEvents).values([{ userId: recent.id, kind: "streak", data: { days: 7 } }, { userId: longAgo.id, kind: "streak", data: { days: 8 } }]);
    await app.inject({ method: "POST", url: `/corners/${hostCorner.id}/posts`, headers: as(host), payload: { text: "Tonight: Afrobeats" } });
    const otherOwner = await person("yother");
    const other = await unlockedCorner(otherOwner);
    await app.inject({ method: "POST", url: `/corners/${other.id}/posts`, headers: as(otherOwner), payload: { text: "Not followed" } });
    const read = async () => (await app.inject({ url: "/feed", headers: as(me) })).json().events as { kind: string; person: { id: string }; data: { text?: string } }[];
    expect((await read()).some((e) => e.kind === "corner_post")).toBe(false);
    await app.inject({ method: "POST", url: `/corners/${hostCorner.id}/follow`, headers: as(me) });
    const events = await read();
    expect(events.some((e) => e.kind === "streak" && e.person.id === recent.id)).toBe(true);
    expect(events.some((e) => e.person.id === longAgo.id)).toBe(false);
    expect(events.filter((e) => e.kind === "corner_post").map((e) => e.data.text)).toEqual(["Tonight: Afrobeats"]);
  });

  it("are who you can invite to a party", async () => {
    const [p] = await db.insert(parties).values({ createdByUserId: me.id, title: "Invites", category: "General knowledge", maxPlayers: 10, funding: "pooled", split: [100], startsAt: new Date(Date.now() + 3_600_000) }).returning();
    expect((await app.inject({ method: "POST", url: `/parties/${p.id}/invites`, headers: as(me), payload: { userIds: [myContact.id, theirContact.id, recent.id] } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `/parties/${p.id}/invites`, headers: as(me), payload: { userIds: [host.id] } })).json().error).toBe("cannot_invite"); // following their corner isn't knowing them
  });

  it("played-with lists everyone you've finished a party with, from the read model", async () => {
    const list = (await app.inject({ url: "/me/played-with", headers: as(me) })).json();
    expect(list[0]).toMatchObject({ id: longAgo.id, partiesTogether: 3 });
    expect(list.map((p: { id: string }) => p.id)).toContain(recent.id);
  });
});

describe("dmPermission (ADR 0012)", () => {
  it("is direct for contacts either way, and following someone's corner opens nothing", async () => {
    const [a, b, c] = [await person("dma"), await person("dmb"), await person("dmc")];
    await contact(b, a);
    expect(await dmPermissionBetween(db, a, b)).toBe("direct");
    expect(await dmPermissionBetween(db, b, a)).toBe("direct");
    const corner = await unlockedCorner(c);
    await app.inject({ method: "POST", url: `/corners/${corner.id}/follow`, headers: as(a) });
    expect(await dmPermissionBetween(db, c, a)).toBe("request");
    expect(await dmPermissionBetween(db, a, c)).toBe("request");
  });

  it("is direct after a finished party together (the played-with read model)", async () => {
    const [a, b] = [await person("dmd"), await person("dme")];
    await finish(await person("dmhost"), [a, b]);
    expect(await dmPermissionBetween(db, a, b)).toBe("direct");
  });
});

// ---- posts ---------------------------------------------------------------------------------

describe("host posts", () => {
  let owner: User, fan: User, muted: User, outsider: User, cornerId: string, postId: string;
  const say = (u: User, text: string, clientMsgId = randomUUID()) => app.inject({ method: "POST", url: `/corner-posts/${postId}/replies`, headers: as(u), payload: { text, clientMsgId } });
  const page = async (u?: User) => (await app.inject({ url: `/corners/${cornerId}/posts`, headers: u ? as(u) : {} })).json().posts[0];
  beforeAll(async () => {
    [owner, fan, muted, outsider] = [await person("powner"), await person("pfan"), await person("pmuted"), await person("pout")];
    cornerId = (await unlockedCorner(owner)).id;
    for (const u of [fan, muted]) await app.inject({ method: "POST", url: `/corners/${cornerId}/follow`, headers: as(u) });
  });

  it("only the owner posts, text only, within the configured length", async () => {
    expect((await app.inject({ method: "POST", url: `/corners/${cornerId}/posts`, headers: as(fan), payload: { text: "hi" } })).json().error).toBe("not_corner_owner");
    await setSocialConfig({ ...DEFAULT_SOCIAL_CONFIG, cornerPostMaxChars: 20 });
    expect((await app.inject({ method: "POST", url: `/corners/${cornerId}/posts`, headers: as(owner), payload: { text: "x".repeat(21) } })).json()).toMatchObject({ error: "post_too_long", details: { max: 20 } });
    await setSocialConfig(DEFAULT_SOCIAL_CONFIG);
    const res = await app.inject({ method: "POST", url: `/corners/${cornerId}/posts`, headers: as(owner), payload: { text: "Party at 8. Bring your people." } });
    expect(res.statusCode).toBe(201);
    postId = res.json().id;
    expect((await db.select().from(feedEvents).where(eq(feedEvents.cornerPostId, postId)))[0]).toMatchObject({ kind: "corner_post", userId: owner.id });
  });

  it("replies go through the chat pipeline: followers only, masked, a repeated client id returns the first", async () => {
    expect((await say(outsider, "let me in")).json().error).toBe("follow_to_take_part");
    const clientMsgId = randomUUID();
    const first = await say(fan, "this is shit hot", clientMsgId);
    expect(first.statusCode).toBe(201);
    expect(first.json().reply.text).toBe("this is s*** hot");
    const again = await say(fan, "this is shit hot", clientMsgId);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ duplicate: true, reply: { id: first.json().reply.id } });
  });

  it("replies share chat's rate limit", async () => {
    const chat = await getChatConfig();
    await setChatConfig({ ...chat, burstMax: 2, burstSeconds: 60 });
    const talker = await person("ptalker");
    await app.inject({ method: "POST", url: `/corners/${cornerId}/follow`, headers: as(talker) });
    expect((await say(talker, "one")).statusCode).toBe(201);
    expect((await say(talker, "two")).statusCode).toBe(201);
    const third = await say(talker, "three");
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({ error: "rate_limited", details: { retryAfterSeconds: expect.any(Number) } });
    await setChatConfig(chat);
  });

  it("one reaction per person per post, changeable", async () => {
    await app.inject({ method: "PUT", url: `/corner-posts/${postId}/reaction`, headers: as(fan), payload: { emoji: "🔥" } });
    const changed = (await app.inject({ method: "PUT", url: `/corner-posts/${postId}/reaction`, headers: as(fan), payload: { emoji: "😂" } })).json();
    expect(changed).toMatchObject({ mine: "😂", reactions: [{ emoji: "😂", count: 1 }] });
    expect((await app.inject({ method: "PUT", url: `/corner-posts/${postId}/reaction`, headers: as(fan), payload: { emoji: "💩" } })).statusCode).toBe(400);
  });

  it("a reply can be reported: one moderation item, every report kept", async () => {
    const replyId = (await say(fan, "report me")).json().reply.id;
    for (const u of [outsider, owner]) expect((await app.inject({ method: "POST", url: `/corner-replies/${replyId}/report`, headers: as(u), payload: { reason: "spam" } })).json()).toEqual({ reported: true });
    const [item] = await db.select().from(moderationItems).where(and(eq(moderationItems.kind, "corner_reply"), eq(moderationItems.refId, replyId)));
    expect(item).toMatchObject({ userId: fan.id, transcript: "report me", status: "pending" });
    expect((item.detail as { reports: { by: string }[] }).reports.map((r) => r.by)).toEqual([outsider.id, owner.id]);
  });

  it("the host deletes a reply; nobody else can", async () => {
    const replyId = (await say(fan, "delete me")).json().reply.id;
    expect((await app.inject({ method: "DELETE", url: `/corner-replies/${replyId}`, headers: as(fan) })).json().error).toBe("not_corner_owner");
    expect((await app.inject({ method: "DELETE", url: `/corner-replies/${replyId}`, headers: as(owner) })).json()).toEqual({ deleted: true });
    const replies = (await app.inject({ url: `/corner-posts/${postId}/replies?limit=50` })).json().replies;
    expect(replies.map((r: { id: string }) => r.id)).not.toContain(replyId);
  });

  it("a muted follower isn't told: their reply and reaction reach only themselves", async () => {
    expect((await app.inject({ method: "POST", url: `/corners/${cornerId}/mutes`, headers: as(fan), payload: { userId: muted.id } })).json().error).toBe("not_corner_owner");
    expect((await app.inject({ method: "POST", url: `/corners/${cornerId}/mutes`, headers: as(owner), payload: { userId: muted.id } })).json()).toEqual({ muted: true });
    const sent = await say(muted, "can anyone hear me");
    expect(sent.statusCode).toBe(201);
    const reacted = (await app.inject({ method: "PUT", url: `/corner-posts/${postId}/reaction`, headers: as(muted), payload: { emoji: "🔥" } })).json();
    expect(reacted.mine).toBe("🔥");
    expect(reacted.reactions).toContainEqual({ emoji: "🔥", count: 1 });
    const texts = async (u?: User) => (await app.inject({ url: `/corner-posts/${postId}/replies?limit=50`, headers: u ? as(u) : {} })).json().replies.map((r: { text: string }) => r.text);
    expect(await texts(muted)).toContain("can anyone hear me");
    expect(await texts(owner)).not.toContain("can anyone hear me");
    expect(await texts()).not.toContain("can anyone hear me");
    expect((await page(owner)).reactions.find((r: { emoji: string }) => r.emoji === "🔥")).toBeUndefined();
    expect((await app.inject({ url: `/corners/${cornerId}`, headers: as(muted) })).json().viewer).not.toHaveProperty("muted");
    expect((await app.inject({ url: `/corners/${cornerId}/mutes`, headers: as(owner) })).json().map((m: { person: { id: string } }) => m.person.id)).toEqual([muted.id]);
  });

  it("the host deletes a post, and it leaves the feed with it", async () => {
    expect((await app.inject({ method: "DELETE", url: `/corner-posts/${postId}`, headers: as(fan) })).json().error).toBe("not_corner_owner");
    expect((await app.inject({ method: "DELETE", url: `/corner-posts/${postId}`, headers: as(owner) })).json()).toEqual({ deleted: true });
    expect((await app.inject({ url: `/corners/${cornerId}/posts` })).json().posts).toEqual([]);
    expect((await app.inject({ url: "/feed", headers: as(fan) })).json().events.some((e: { data: { postId?: string } }) => e.data.postId === postId)).toBe(false);
  });
});

// ---- the corner page -------------------------------------------------------------------------

describe("the corner page", () => {
  it("has up next, winners, this week's regulars, followers and posts", async () => {
    const host = await person("cphost");
    const [a, b, c] = [await person("cpa"), await person("cpb"), await person("cpc")];
    await finish(host, [a, b, c]);
    await finish(host, [b, a, c]);
    const corner = await unlockedCorner(host);
    const [open] = await db.insert(parties).values({ createdByUserId: host.id, title: "Next up", category: "General knowledge", maxPlayers: 10, funding: "pooled", split: [100], startsAt: new Date(Date.now() + 3_600_000) }).returning();
    const res = (await app.inject({ url: `/corners/${corner.id}`, headers: as(c) })).json();
    expect(res.upNext.map((p: { id: string }) => p.id)).toEqual([open.id]);
    expect(res.winners.map((w: { person: { id: string } }) => w.person.id).sort()).toEqual([a.id, b.id].sort());
    expect(res.regulars.rows.slice(0, 2).map((r: { person: { id: string }; wins: number }) => [r.person.id, r.wins]).sort()).toEqual([[a.id, 1], [b.id, 1]].sort());
    expect(res.regulars.rows.find((r: { person: { id: string } }) => r.person.id === c.id)).toMatchObject({ parties: 2, wins: 0 });
    expect(res.yourPeopleFollowing).toEqual({ count: 0, faces: [] });
    expect(res.viewer).toEqual({ following: false, notify: false, isOwner: false });
  });
});

// ---- the interim Parties tab ---------------------------------------------------------------

describe("the Parties tab (interim)", () => {
  it("pins parties over 60% full starting within the hour, then sorts by starting soonest", async () => {
    const host = await person("tabhost");
    const at = (min: number) => new Date(Date.now() + min * 60_000);
    const make = async (title: string, min: number, seats: number) => {
      const [p] = await db.insert(parties).values({ createdByUserId: host.id, title: `${title} ${tag}`, category: "General knowledge", maxPlayers: 10, funding: "pooled", split: [100], startsAt: at(min) }).returning();
      for (let i = 0; i < seats; i++) await db.insert(partyPlayers).values({ partyId: p.id, userId: (await person(`tab${title}${i}`)).id });
      return p.id;
    };
    const filling = await make("filling", 50, 7);
    const soonEmpty = await make("soon", 5, 1);
    const laterFull = await make("later", 90, 9);
    const order = ((await app.inject({ url: "/parties" })).json() as { id: string }[]).map((c) => c.id);
    const idx = (id: string) => order.indexOf(id);
    expect(idx(filling)).toBeGreaterThanOrEqual(0);
    expect(idx(filling)).toBeLessThan(idx(soonEmpty));
    expect(idx(soonEmpty)).toBeLessThan(idx(laterFull));
  });
});

// ---- the follow migration (0038) -------------------------------------------------------------

describe("the follow migration", () => {
  it("turns follows of someone with a corner into corner follows and drops the rest, archived ones too", async () => {
    const file = readFileSync(fileURLToPath(new URL("../../../packages/db/drizzle/0038_corners.sql", import.meta.url)), "utf8");
    const block = file.slice(file.indexOf("-- Follows point at corners"), file.indexOf("-- played_with from every finished party"));
    const statements = block.split("--> statement-breakpoint").map((s) => s.replace(/^--.*$/gm, "").trim()).filter(Boolean);
    expect(statements.length).toBeGreaterThan(10);
    const schema = `mig_${tag}`;
    const [hasCorner, noCorner, fan] = [randomUUID(), randomUUID(), randomUUID()];
    const cornerId = randomUUID();
    await db.transaction(async (tx) => {
      await tx.execute(dsql.raw(`create schema ${schema}; set local search_path to ${schema}`));
      await tx.execute(dsql.raw(`create table users (id uuid primary key)`));
      await tx.execute(dsql.raw(`create table corners (id uuid primary key, owner_user_id uuid not null)`));
      await tx.execute(dsql.raw(`create table follows (follower_id uuid not null references users(id), followee_id uuid not null, notify boolean not null default true,
        created_at timestamptz not null default now(), constraint follows_follower_id_followee_id_pk primary key (follower_id, followee_id),
        constraint follows_followee_id_users_id_fk foreign key (followee_id) references users(id))`));
      await tx.execute(dsql.raw(`create index follows_followee_idx on follows (followee_id)`));
      await tx.execute(dsql.raw(`create table archived_follows (id uuid primary key default gen_random_uuid(), follower_id uuid not null, followee_id uuid not null, notify boolean not null,
        created_at timestamptz not null, archived_at timestamptz not null default now(), constraint archived_follows_followee_id_users_id_fk foreign key (followee_id) references users(id))`));
      await tx.execute(dsql.raw(`create index archived_follows_followee_idx on archived_follows (followee_id)`));
      await tx.execute(dsql.raw(`insert into users values ('${hasCorner}'), ('${noCorner}'), ('${fan}'); insert into corners values ('${cornerId}', '${hasCorner}')`));
      await tx.execute(dsql.raw(`insert into follows (follower_id, followee_id, notify) values ('${fan}', '${hasCorner}', false), ('${fan}', '${noCorner}', true), ('${hasCorner}', '${noCorner}', true)`));
      await tx.execute(dsql.raw(`insert into archived_follows (follower_id, followee_id, notify, created_at) values ('${fan}', '${hasCorner}', true, now()), ('${fan}', '${noCorner}', true, now())`));
      for (const s of statements) await tx.execute(dsql.raw(s));
      const follows = await tx.execute(dsql.raw(`select follower_id, corner_id, notify from follows`));
      expect([...follows]).toEqual([{ follower_id: fan, corner_id: cornerId, notify: false }]);
      const archived = await tx.execute(dsql.raw(`select follower_id, corner_id from archived_follows`));
      expect([...archived]).toEqual([{ follower_id: fan, corner_id: cornerId }]);
      const cols = await tx.execute(dsql.raw(`select column_name from information_schema.columns where table_schema = '${schema}' and table_name = 'follows' order by column_name`));
      expect([...cols].map((c) => (c as { column_name: string }).column_name)).toEqual(["corner_id", "created_at", "follower_id", "notify"]);
      tx.rollback();
    }).catch((e) => { if (!String(e).includes("Rollback")) throw e; });
  });
});

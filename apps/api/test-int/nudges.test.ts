/**
 * Nudges (row 9): each trigger's audience and cap, the central rules (toggles, the daily push cap with live-party
 * events outside it, quiet hours where the person is), batching, withdrawals, banner-or-push, token clean-up,
 * the no-money guard, the log, devices and the follower asks. Delivery runs with fakes for push and the sockets.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  archiveAccount, chatThreads, climbRuns, contactMatches, cornerPosts, corners, crews, currentLadder, db, deliverDueNudges, deviceTokens, emitClimbRivals, emitCornerParty,
  emitCornerReply, emitFillingUp, emitGuestFollowUps, emitHeadToHeadRivals, emitHostCancelled, emitMentions, emitPartyLive, emitPartyStarting, emitPeopleJoined,
  emitStreakRisk, emitWinBack, follows, getNudgeConfig, nudge, nudges, parties, partyPlayers, setNudgeConfig, users, blocks,
  type DeliveryDeps, type NudgeRow, type Party, type PushMessage, type PushSender, type User,
} from "@contestly/db";
import {
  DEFAULT_NUDGE_CONFIG, INSTALL_ID_HEADER, activityPageSchema, addDays, deviceSchema, followerInviteOptionsSchema, lagosDay, notificationSettingsSchema, nudgeMessageSchema, parseThreadLink, type NudgeMessage,
} from "@contestly/shared";
import { as, makeUser, testApp } from "./harness.js";

let app: Awaited<ReturnType<typeof testApp>>["app"];
let seq = 0;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const person = (name: string, extra: Partial<typeof users.$inferInsert> = {}) => makeUser(`${name}${++seq}`, extra);

async function party(host: User, o: Partial<typeof parties.$inferInsert> = {}): Promise<Party> {
  const [p] = await db.insert(parties).values({
    createdByUserId: host.id, title: `Quiz ${++seq}`, category: "Football", maxPlayers: 10, funding: "pooled", split: [100],
    startsAt: new Date(Date.now() + HOUR), ...o,
  }).returning();
  return p;
}
const seat = (p: Party, ...people: User[]) => db.insert(partyPlayers).values(people.map((u) => ({ partyId: p.id, userId: u.id })));
const device = (u: User, token = `tok-${randomUUID()}`, permission: "granted" | "denied" = "granted") =>
  db.insert(deviceTokens).values({ userId: u.id, installId: `inst-${randomUUID()}`, platform: "android", token, appVersion: "1.0.0", permission }).returning();
const dmThread = async () => (await db.insert(chatThreads).values({ kind: "dm", dmKey: randomUUID() }).returning())[0].id;
const contacts = (a: User, b: User) => db.insert(contactMatches).values({ userId: a.id, contactUserId: b.id });
const rowsOf = (u: User, kind?: string) => db.select().from(nudges).where(and(eq(nudges.userId, u.id), kind ? eq(nudges.kind, kind as never) : undefined));
const one = async (u: User, kind?: string): Promise<NudgeRow> => {
  const rows = await rowsOf(u, kind);
  expect(rows).toHaveLength(1);
  return rows[0];
};

/** Push records what it sent; tokens in `invalid` answer as FCM does for an unregistered one. */
class FakePush implements PushSender {
  readonly name = "fake";
  sent: PushMessage[] = [];
  invalid = new Set<string>();
  async send(m: PushMessage) {
    if (this.invalid.has(m.token)) return { ok: false as const, invalidToken: true, error: "not registered" };
    this.sent.push(m);
    return { ok: true as const };
  }
}
type World = { push: FakePush; connected: Set<string>; inRoom: Set<string>; banners: { userId: string; message: NudgeMessage }[] };
function world(): World & { deps(now?: Date): DeliveryDeps } {
  const w: World = { push: new FakePush(), connected: new Set(), inRoom: new Set(), banners: [] };
  return {
    ...w,
    deps: (now = new Date()) => ({
      push: w.push,
      connected: async (id) => w.connected.has(id),
      banner: async (userId, message) => {
        if (!w.connected.has(userId)) return false;
        w.banners.push({ userId, message });
        return true;
      },
      inPartyRoom: async (partyId, userId) => w.inRoom.has(`${partyId}:${userId}`),
      now: () => now,
    }),
  };
}
const deliver = (w: ReturnType<typeof world>, now = new Date()) => deliverDueNudges(w.deps(now), 5000);

/** Quiet hours off (start = end) unless a test is about them, so nothing depends on when the suite runs. */
const NO_QUIET = { ...DEFAULT_NUDGE_CONFIG, quietHours: { startHour: 0, endHour: 0 } };

beforeAll(async () => {
  ({ app } = await testApp());
  await setNudgeConfig(NO_QUIET);
});
afterAll(async () => {
  await setNudgeConfig(DEFAULT_NUDGE_CONFIG);
  await app.close();
});

describe("party starts in 5 (and in a minute)", () => {
  it("goes to everyone seated and the host at T-5, once, and isn't held by quiet hours or the daily cap", async () => {
    const [host, a, b] = [await person("sh"), await person("sa", { timeZone: "Asia/Tokyo" }), await person("sb")];
    for (const u of [host, a, b]) await device(u);
    const now = new Date();
    const p = await party(host, { startsAt: new Date(now.getTime() + 5.5 * MIN) });
    const tooLate = await party(host, { startsAt: new Date(now.getTime() + 3 * MIN) }); // joined inside the last four minutes: no "in 5"
    await seat(p, a, b);
    await seat(tooLate, a);
    expect(await emitPartyStarting(now)).toBeGreaterThanOrEqual(3);
    await emitPartyStarting(now); // the next sweep finds the dedupe key taken
    for (const u of [host, a, b]) expect((await one(u, "party_starting")).dueAt.getTime()).toBe(p.startsAt.getTime() - 5 * MIN);
    expect((await rowsOf(a, "party_starting")).filter((r) => r.refId === tooLate.id)).toHaveLength(0);

    // Tokyo is in its small hours for much of the day; a party you're in is let through anyway.
    await db.update(users).set({ timeZone: "Pacific/Kiritimati" }).where(eq(users.id, a.id));
    for (let i = 0; i < 3; i++) await nudge(db, { userId: a.id, kind: "host_cancelled", data: { partyId: tooLate.id, title: "x", entryBack: false }, dedupeKey: `cap-${i}` });
    const w = world();
    await deliver(w, new Date(p.startsAt.getTime() - 5 * MIN));
    const row = await one(a, "party_starting");
    expect(row.status).toBe("sent");
    expect(row.channel).toBe("push");
    expect(w.push.sent.some((m) => m.data.nudgeId === row.id && m.title === `${p.title} starts in 5 minutes`)).toBe(true);
  });

  it("a cancelled party withdraws its T-5; a player who left loses theirs", async () => {
    const [host, a, b] = [await person("ch"), await person("ca"), await person("cb")];
    for (const u of [host, a, b]) await device(u);
    const now = new Date();
    const p = await party(host, { startsAt: new Date(now.getTime() + 5.2 * MIN) });
    const q = await party(host, { startsAt: new Date(now.getTime() + 5.2 * MIN) });
    await seat(p, a);
    await seat(q, b);
    await emitPartyStarting(now);
    await db.update(parties).set({ status: "cancelled" }).where(eq(parties.id, p.id));
    await db.delete(partyPlayers).where(and(eq(partyPlayers.partyId, q.id), eq(partyPlayers.userId, b.id)));
    const w = world();
    await deliver(w, new Date(now.getTime() + 0.2 * MIN));
    expect((await one(a, "party_starting")).status).toBe("withdrawn");
    expect((await one(b, "party_starting")).status).toBe("withdrawn");
    expect(w.push.sent.filter((m) => [a.id, b.id].some((id) => m.token.includes(id)))).toHaveLength(0);
    expect((await rowsOf(host)).find((r) => r.refId === p.id)?.status).toBe("withdrawn");
  });

  it("T-1 only reaches people who aren't in the room yet", async () => {
    const [host, a, b] = [await person("oh"), await person("oa"), await person("ob")];
    for (const u of [a, b]) await device(u);
    const now = new Date();
    const p = await party(host, { startsAt: new Date(now.getTime() + 90_000) });
    await seat(p, a, b);
    await emitPartyStarting(now);
    const w = world();
    w.inRoom.add(`${p.id}:${a.id}`);
    await deliver(w, new Date(p.startsAt.getTime() - MIN));
    const [ra, rb] = [await one(a, "party_starting"), await one(b, "party_starting")];
    expect(ra.data).toMatchObject({ minutes: 1 });
    expect([ra.status, ra.skipReason]).toEqual(["skipped", "not_needed"]);
    expect(rb.status).toBe("sent");
  });
});

describe("party is live", () => {
  it("seated players not in the room hear it once, a little after it goes live", async () => {
    const [host, a, b] = [await person("lh"), await person("la"), await person("lb")];
    for (const u of [a, b]) await device(u);
    const liveAt = new Date();
    const p = await party(host, { status: "live", liveAt, startsAt: liveAt });
    await seat(p, a, b);
    expect(await emitPartyLive(p.id)).toBe(2);
    expect(await emitPartyLive(p.id)).toBe(0); // once per party
    const w = world();
    w.inRoom.add(`${p.id}:${b.id}`);
    expect(await deliver(w, liveAt)).toEqual([]); // not due until the delay
    await deliver(w, new Date(liveAt.getTime() + DEFAULT_NUDGE_CONFIG.liveNudgeDelaySeconds * 1000));
    expect((await one(a, "party_live")).status).toBe("sent");
    expect((await one(b, "party_live")).skipReason).toBe("not_needed");
    expect(await rowsOf(host, "party_live")).toHaveLength(0);
  });
});

describe("one of your people joined your party", () => {
  it("goes to the host and seated players who count the joiner as theirs, at most one an hour per party, batched", async () => {
    const [host, stranger, j1, j2, j3] = [await person("jh"), await person("js"), await person("j1"), await person("j2"), await person("j3")];
    await device(host);
    for (const j of [j1, j2, j3]) await contacts(host, j);
    const p = await party(host);
    await seat(p, stranger, j1);
    await emitPeopleJoined(p.id, j1.id);
    expect(await rowsOf(stranger)).toHaveLength(0);
    const w = world();
    const t0 = new Date();
    await deliver(w, t0);
    const first = await one(host, "people_joined");
    expect([first.status, first.title]).toEqual(["sent", `${j1.displayName} joined ${p.title}`]);

    await seat(p, j2, j3);
    await emitPeopleJoined(p.id, j2.id);
    await emitPeopleJoined(p.id, j3.id);
    const pending = (await rowsOf(host, "people_joined")).filter((r) => r.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0].dueAt.getTime()).toBeGreaterThanOrEqual(first.decidedAt!.getTime() + HOUR - 1000);
    expect(pending[0].title).toBe(`${j2.displayName} and ${j3.displayName} joined ${p.title}`);
    await deliver(w, new Date(t0.getTime() + 30 * MIN));
    expect((await rowsOf(host, "people_joined")).filter((r) => r.status === "sent")).toHaveLength(1);
    await deliver(w, new Date(first.decidedAt!.getTime() + HOUR));
    expect((await rowsOf(host, "people_joined")).filter((r) => r.status === "sent")).toHaveLength(2);
  });

  it("a guest joining tells nobody", async () => {
    const host = await person("gh");
    const guest = await person("gg", { isGuest: true });
    await contacts(host, guest);
    const p = await party(host);
    expect(await emitPeopleJoined(p.id, guest.id)).toBe(0);
  });
});

describe("party filling up", () => {
  it("tells people in its lane, once a day, unless they're in it or have a party within the hour", async () => {
    const host = await person("fh");
    const lane = `Lane${seq}`;
    const [fan, busy, other, sim] = [
      await person("ff", { interests: [lane] }), await person("fb", { interests: [lane] }), await person("fo", { interests: ["Maths"] }),
      await person("fs", { interests: [lane], isSim: true }),
    ];
    for (const u of [fan, busy]) await device(u);
    const now = new Date();
    const p = await party(host, { category: lane, visibility: "public", maxPlayers: 5, startsAt: new Date(now.getTime() + 8 * MIN) });
    await seat(p, await person("x1"), await person("x2"));
    expect(await emitFillingUp(now)).toBe(0); // 2 of 5: not yet
    await seat(p, await person("x3"));
    await emitFillingUp(now);
    await seat(await party(host, { startsAt: new Date(now.getTime() + 40 * MIN) }), busy);
    expect((await rowsOf(other)).length + (await rowsOf(sim)).length).toBe(0);
    const w = world();
    await deliver(w, now);
    expect((await one(fan, "party_filling")).status).toBe("sent");
    expect((await one(busy, "party_filling")).skipReason).toBe("not_needed");

    const p2 = await party(host, { category: lane, visibility: "public", maxPlayers: 5, startsAt: new Date(now.getTime() + 9 * MIN) });
    await seat(p2, await person("y1"), await person("y2"), await person("y3"));
    await emitFillingUp(now);
    await deliver(w, now);
    expect((await rowsOf(fan, "party_filling")).find((r) => r.refId === p2.id)?.skipReason).toBe("kind_cap");
  });
});

describe("new party in a corner you follow", () => {
  it("reaches followers with alerts on, up to the per-corner daily cap", async () => {
    await setNudgeConfig({ ...NO_QUIET, cornerPartyAlertsPerDay: 2 });
    const [host, host2, on, off] = [await person("kh"), await person("k2"), await person("ko"), await person("kf")];
    await device(on);
    const [c] = await db.insert(corners).values({ ownerUserId: host.id, name: "Kemi's corner", status: "unlocked", unlockedAt: new Date() }).returning();
    const [c2] = await db.insert(corners).values({ ownerUserId: host2.id, name: "Other corner", status: "unlocked", unlockedAt: new Date() }).returning();
    await db.insert(follows).values([{ followerId: on.id, cornerId: c.id }, { followerId: off.id, cornerId: c.id, notify: false }, { followerId: on.id, cornerId: c2.id }]);
    const w = world();
    for (let i = 0; i < 3; i++) {
      await emitCornerParty((await party(host, { visibility: "public" })).id, host.id);
      await deliver(w);
    }
    await emitCornerParty((await party(host2, { visibility: "public" })).id, host2.id);
    await emitCornerParty((await party(host, { visibility: "private" })).id, host.id);
    await deliver(w);
    expect(await rowsOf(off)).toHaveLength(0);
    const rows = await rowsOf(on, "corner_party");
    expect(rows.filter((r) => r.refId === c.id).map((r) => r.skipReason ?? r.status).sort()).toEqual(["kind_cap", "sent", "sent"]);
    expect(rows.find((r) => r.refId === c2.id)?.status).toBe("sent");
    expect(rows[0].title).toBe("New party in Kemi's corner");
    await setNudgeConfig(NO_QUIET);
  });
});

describe("@mentions and corner replies", () => {
  it("a mention always goes, batched per thread", async () => {
    const [ada, kemi, me] = [await person("ma", { displayName: "Ada" }), await person("mk", { displayName: "Kemi" }), await person("mm")];
    await device(me);
    const thread = await dmThread();
    const w = world();
    await emitMentions(thread, ada.id, [me.id]);
    await deliver(w);
    await emitMentions(thread, kemi.id, [me.id]);
    await emitMentions(thread, ada.id, [me.id]);
    const rows = await rowsOf(me, "mention");
    expect(rows.map((r) => r.status).sort()).toEqual(["pending", "sent"]);
    expect(rows.find((r) => r.status === "pending")!.title).toBe("Kemi and Ada mentioned you");
    await emitMentions(await dmThread(), ada.id, [me.id]); // another thread is its own batch
    await deliver(w);
    expect((await rowsOf(me, "mention")).filter((r) => r.status === "sent")).toHaveLength(2);
  });

  it("a reply reaches the host, batched per post, and anyone it @mentions", async () => {
    const [host, fan, tagged] = [await person("rh"), await person("rf"), await person("rt")];
    const [c] = await db.insert(corners).values({ ownerUserId: host.id, name: "Corner", status: "unlocked", unlockedAt: new Date() }).returning();
    const [post] = await db.insert(cornerPosts).values({ cornerId: c.id, authorUserId: host.id, text: "Quiz Friday" }).returning();
    await emitCornerReply(post.id, fan.id, `I'm in, @${tagged.handle} too`);
    await emitCornerReply(post.id, host.id, "see you"); // the host's own reply tells nobody
    expect((await one(host, "corner_reply")).title).toBe(`${fan.displayName} replied to your post`);
    expect((await one(tagged, "mention")).body).toBe("In a corner post");
    // Both open the post's replies, by the post's id.
    for (const n of [await one(host, "corner_reply"), await one(tagged, "mention")]) {
      expect(parseThreadLink(n.deepLink)).toEqual({ kind: "corner_post", postId: post.id });
    }
  });

  it("a mention opens the exact thread: a DM by the sender's handle, a crew by its id, a party's chat by the party's id", async () => {
    const [ada, me] = [await person("ta", { displayName: "Ada" }), await person("tm")];
    const p = await party(ada);
    const [crew] = await db.insert(crews).values({ name: "Night owls", emoji: "🦉", color: "blue", createdByUserId: ada.id }).returning();
    const [partyThread] = await db.insert(chatThreads).values({ kind: "party", partyId: p.id }).returning();
    const [crewThread] = await db.insert(chatThreads).values({ kind: "crew", crewId: crew.id }).returning();
    const dm = await dmThread();
    for (const t of [dm, crewThread.id, partyThread.id]) expect(await emitMentions(t, ada.id, [me.id])).toBe(1);
    const byThread = new Map((await rowsOf(me, "mention")).map((r) => [r.refId, r]));
    expect(parseThreadLink(byThread.get(dm)!.deepLink)).toEqual({ kind: "dm", handle: ada.handle });
    expect(byThread.get(dm)!.deepLink).toBe(`contestly://chats/dm/${ada.handle}`);
    expect(parseThreadLink(byThread.get(crewThread.id)!.deepLink)).toEqual({ kind: "crew", crewId: crew.id });
    expect(byThread.get(crewThread.id)!.body).toBe("In Night owls");
    expect(parseThreadLink(byThread.get(partyThread.id)!.deepLink)).toEqual({ kind: "party", partyId: p.id });
    expect(byThread.get(partyThread.id)!.body).toBe(`In ${p.title} chat`);
    // A thread that's gone has nowhere to open: nothing is recorded.
    expect(await emitMentions(randomUUID(), ada.id, [me.id])).toBe(0);
  });
});

describe("your corner is open", () => {
  it("is a push only: with the app open the celebration says it", async () => {
    const [open, away] = [await person("uo"), await person("ua")];
    for (const u of [open, away]) await device(u);
    for (const u of [open, away]) await nudge(db, { userId: u.id, kind: "corner_open", data: { cornerId: randomUUID() }, dedupeKey: "corner_open:x" });
    const w = world();
    w.connected.add(open.id);
    await deliver(w);
    expect((await one(open)).skipReason).toBe("in_app");
    expect(w.banners).toHaveLength(0);
    expect((await one(away)).channel).toBe("push");
  });
});

describe("rivals", () => {
  async function finished(players: [User, number][]) {
    const p = await party(players[0][0], { status: "finished", endedAt: new Date() });
    await db.insert(partyPlayers).values(players.map(([u, rank]) => ({ partyId: p.id, userId: u.id, rank })));
    return p;
  }
  it("head to head: taking the lead (from level) tells the one who lost it; a first meeting doesn't", async () => {
    const [a, b] = [await person("ha"), await person("hb", { displayName: "Kemi" })];
    const first = await finished([[a, 1], [b, 2]]);
    await db.transaction((tx) => emitHeadToHeadRivals(tx, first.id));
    expect(await rowsOf(a)).toHaveLength(0);
    const level = await finished([[b, 1], [a, 2]]); // 1–1: level, nobody took the lead
    await db.transaction((tx) => emitHeadToHeadRivals(tx, level.id));
    expect(await rowsOf(a)).toHaveLength(0);
    const ahead = await finished([[b, 1], [a, 2]]); // Kemi 2–1
    await db.transaction((tx) => emitHeadToHeadRivals(tx, ahead.id));
    const r = await one(a, "rival");
    expect([r.title, r.body]).toEqual(["Kemi took the lead on you", "Head to head: 2–1. Time for a rematch?"]);
    expect(await rowsOf(b)).toHaveLength(0);
  });

  it("the Climb: one of your people passing your best stage; at most one rival nudge a day", async () => {
    const [runner, mine, ahead, stranger] = [await person("cr", { displayName: "Tunde" }), await person("cm"), await person("ca"), await person("cs")];
    for (const u of [mine, ahead]) await contacts(runner, u);
    await device(mine);
    const ladderVersion = (await currentLadder()).version;
    const run = (u: User, stagesCleared: number) => db.insert(climbRuns).values({ userId: u.id, ladderVersion, day: lagosDay(), status: "missed", stagesCleared }).returning().then((r) => r[0]);
    await run(runner, 2);
    await run(mine, 3);
    await run(ahead, 5);
    await run(stranger, 1);
    const r = await run(runner, 4);
    await db.transaction((tx) => emitClimbRivals(tx, r));
    expect((await one(mine, "rival")).title).toBe("Tunde climbed past your best");
    expect(await rowsOf(ahead)).toHaveLength(0);
    expect(await rowsOf(stranger)).toHaveLength(0);
    await nudge(db, { userId: mine.id, kind: "rival", data: { by: "climb", rivalHandle: "x", rivalName: "X", stage: 5 }, dedupeKey: "rival:other" });
    const w = world();
    await deliver(w);
    expect((await rowsOf(mine, "rival")).map((x) => x.skipReason ?? x.status).sort()).toEqual(["kind_cap", "sent"]);
  });
});

describe("streak at risk", () => {
  it("3 hours before midnight where they are, or before Lagos midnight if that's sooner; once a day", async () => {
    const lagosNine = new Date("2026-11-10T20:00:00Z"); // 21:00 Lagos
    const today = lagosDay(lagosNine);
    const onStreak = { streakDays: 4, lastPlayedOn: addDays(today, -1) };
    const [lagos, dubai, played, short] = [
      await person("sl", onStreak), await person("sd", { ...onStreak, timeZone: "Asia/Dubai" }),
      await person("sp", { ...onStreak, lastPlayedOn: today }), await person("ss", { ...onStreak, streakDays: 1 }),
    ];
    await emitStreakRisk(new Date("2026-11-10T17:00:00Z")); // 21:00 in Dubai, 18:00 in Lagos
    expect(await rowsOf(dubai, "streak_risk")).toHaveLength(1);
    expect(await rowsOf(lagos, "streak_risk")).toHaveLength(0);
    await emitStreakRisk(lagosNine);
    expect((await one(lagos, "streak_risk")).title).toBe("Your 4-day streak ends at midnight");
    expect(await rowsOf(dubai, "streak_risk")).toHaveLength(1);
    expect((await rowsOf(played)).length + (await rowsOf(short)).length).toBe(0);
  });
});

describe("the host cancelled, guests, win-back", () => {
  it("the host cancelled: the seated players, no refund wording", async () => {
    const [host, a] = [await person("xh"), await person("xa")];
    const p = await party(host);
    await emitHostCancelled(p.id, [a.id], true);
    await emitHostCancelled(p.id, [a.id], true);
    const r = await one(a, "host_cancelled");
    expect(r.title).toBe(`The host cancelled ${p.title}`);
  });

  it("a guest's follow-up comes 24 hours after their first game, once, if they haven't signed up", async () => {
    const host = await person("gfh");
    const [guest, fresh, member] = [await person("gfg", { isGuest: true }), await person("gff", { isGuest: true }), await person("gfm")];
    const now = new Date();
    const old = await party(host, { status: "finished", endedAt: new Date(now.getTime() - 25 * HOUR) });
    const recent = await party(host, { status: "finished", endedAt: new Date(now.getTime() - 2 * HOUR) });
    await seat(old, guest, member);
    await seat(recent, fresh);
    await emitGuestFollowUps(now);
    await emitGuestFollowUps(now);
    expect((await one(guest, "guest_follow_up")).deepLink).toBe("contestly://sign-up");
    expect((await rowsOf(fresh)).length + (await rowsOf(member)).length).toBe(0);
  });

  it("win-back on day 3 says what one of their people did, and only if there's something true to say", async () => {
    const now = new Date("2026-11-12T17:00:00Z"); // 18:00 Lagos
    const [away, quiet, kemi] = [
      await person("wa", { lastSeenAt: new Date(now.getTime() - 3 * DAY) }), await person("wq", { lastSeenAt: new Date(now.getTime() - 3 * DAY) }),
      await person("wk", { displayName: "Kemi" }),
    ];
    await contacts(away, kemi);
    for (let i = 0; i < 2; i++) await party(kemi, { status: "finished", endedAt: new Date(now.getTime() - DAY) });
    await emitWinBack(now);
    await emitWinBack(now);
    expect((await one(away, "win_back")).title).toBe("Kemi hosted 2 parties");
    expect(await rowsOf(quiet)).toHaveLength(0);
    await emitWinBack(new Date(now.getTime() + DAY)); // day 4: nothing
    expect(await rowsOf(away, "win_back")).toHaveLength(1);
  });
});

describe("the central rules", () => {
  it("3 pushes a day at most, outside live-party events", async () => {
    const [u, host] = [await person("cap"), await person("caph")];
    await device(u);
    const w = world();
    for (let i = 0; i < 4; i++) await nudge(db, { userId: u.id, kind: "host_cancelled", data: { partyId: randomUUID(), title: `P${i}`, entryBack: false }, dedupeKey: `c${i}` });
    const p = await party(host, { status: "live", liveAt: new Date(), startsAt: new Date() });
    await seat(p, u);
    await nudge(db, { userId: u.id, kind: "party_live", data: { partyId: p.id, title: p.title }, ref: { type: "party", id: p.id } });
    await deliver(w);
    const rows = await rowsOf(u);
    expect(rows.filter((r) => r.kind === "host_cancelled").map((r) => r.skipReason ?? r.status).sort()).toEqual(["daily_cap", "sent", "sent", "sent"]);
    expect(rows.find((r) => r.kind === "party_live")!.status).toBe("sent");
  });

  it("quiet hours are 23:00–07:00 in the person's own zone; a party they're in is exempt", async () => {
    await setNudgeConfig(DEFAULT_NUDGE_CONFIG);
    const at = new Date("2026-11-04T04:30:00Z"); // 23:30 in New York, 05:30 in Lagos, 20:30 in Los Angeles
    const [ny, la, host] = [await person("qn", { timeZone: "America/New_York" }), await person("ql", { timeZone: "America/Los_Angeles" }), await person("qh")];
    for (const u of [ny, la]) await device(u);
    const p = await party(host, { startsAt: new Date(at.getTime() + 5 * MIN) });
    await seat(p, ny);
    for (const u of [ny, la]) await nudge(db, { userId: u.id, kind: "mention", data: { thread: { kind: "dm", handle: "x" }, where: "a message" }, dueAt: at });
    await nudge(db, { userId: ny.id, kind: "party_starting", data: { partyId: p.id, title: p.title, minutes: 5 }, ref: { type: "party", id: p.id }, dueAt: at });
    const w = world();
    await deliver(w, at);
    expect((await one(ny, "mention")).skipReason).toBe("quiet_hours");
    expect((await one(la, "mention")).status).toBe("sent");
    expect((await one(ny, "party_starting")).status).toBe("sent");
    await setNudgeConfig(NO_QUIET);
  });

  it("GET /me/notifications says the quiet hours in effect, from config, on the person's clock", async () => {
    const u = await person("qv", { timeZone: "America/New_York" });
    await setNudgeConfig(DEFAULT_NUDGE_CONFIG);
    const settings = notificationSettingsSchema.parse((await app.inject({ url: "/me/notifications", headers: as(u) })).json());
    expect(settings.quietHours).toEqual({ start: "23:00", end: "07:00", timeZone: "America/New_York" });
    await setNudgeConfig({ ...DEFAULT_NUDGE_CONFIG, quietHours: { startHour: 22, endHour: 8 } });
    const moved = await app.inject({ method: "PATCH", url: "/me/notifications", headers: as(u), payload: { timeZone: "Africa/Lagos" } });
    expect(moved.json().quietHours).toEqual({ start: "22:00", end: "08:00", timeZone: "Africa/Lagos" });
    await setNudgeConfig(NO_QUIET);
    expect((await app.inject({ url: "/me/notifications", headers: as(u) })).json().quietHours).toBeNull();
  });

  it("a category turned off is skipped and logged as such; PATCH /me/notifications turns it off", async () => {
    const u = await person("tog");
    await device(u);
    const patched = await app.inject({ method: "PATCH", url: "/me/notifications", headers: as(u), payload: { toggles: { mentions: false }, timeZone: "Europe/London" } });
    // NO_QUIET is in effect here: no quiet hours.
    expect(notificationSettingsSchema.parse(patched.json())).toEqual({ toggles: { parties: true, corners: true, people: true, mentions: false, climb: true, account: true }, timeZone: "Europe/London", quietHours: null });
    expect((await app.inject({ url: "/me/notifications", headers: as(u) })).json().toggles.mentions).toBe(false);
    await emitMentions(await dmThread(), (await person("tog2")).id, [u.id]);
    await nudge(db, { userId: u.id, kind: "streak_risk", data: { days: 3 }, dedupeKey: "s" });
    const w = world();
    await deliver(w);
    expect((await one(u, "mention")).skipReason).toBe("toggle_off");
    expect((await one(u, "streak_risk")).status).toBe("sent");
  });

  it("with the app open, a banner replaces the push: same content and deep link", async () => {
    const u = await person("ban");
    await device(u);
    await nudge(db, { userId: u.id, kind: "host_cancelled", data: { partyId: randomUUID(), title: "Friday", entryBack: true }, dedupeKey: "b" });
    const w = world();
    w.connected.add(u.id);
    await deliver(w);
    const row = await one(u);
    expect([row.status, row.channel, row.pushes]).toEqual(["sent", "banner", 0]);
    expect(w.push.sent.filter((m) => m.data.nudgeId === row.id)).toHaveLength(0);
    const banner = nudgeMessageSchema.parse(w.banners.find((b) => b.userId === u.id)!.message);
    expect(banner).toMatchObject({ id: row.id, title: "The host cancelled Friday", body: row.body, deepLink: row.deepLink, reason: row.reason });
  });

  it("FCM's invalid tokens are cleared; with none left it's no_device", async () => {
    const [u, gone] = [await person("inv"), await person("ing")];
    const [[good], [bad], [bad2]] = [await device(u), await device(u, "invalid-1"), await device(gone, "invalid-2")];
    await device(gone, `denied-${randomUUID()}`, "denied");
    for (const x of [u, gone]) await nudge(db, { userId: x.id, kind: "streak_risk", data: { days: 3 }, dedupeKey: "i" });
    const w = world();
    w.push.invalid.add("invalid-1").add("invalid-2");
    await deliver(w);
    expect((await one(u)).pushes).toBe(1);
    expect((await one(gone)).skipReason).toBe("no_device");
    const tokens = await db.select({ id: deviceTokens.id, token: deviceTokens.token }).from(deviceTokens).where(inArray(deviceTokens.id, [good.id, bad.id, bad2.id]));
    expect(tokens.find((t) => t.id === good.id)!.token).toBe(good.token);
    expect(tokens.filter((t) => t.token === null).map((t) => t.id).sort()).toEqual([bad.id, bad2.id].sort());
  });

  it("copy that mentions money is never sent: recorded as skipped (money)", async () => {
    const [host, a] = [await person("mh"), await person("ma")];
    await device(a);
    const p = await party(host, { title: "Win ₦50,000 tonight", status: "live", liveAt: new Date(), startsAt: new Date() });
    await seat(p, a);
    await emitPartyLive(p.id);
    const row = await one(a, "party_live");
    expect([row.status, row.skipReason]).toEqual(["skipped", "money"]);
    const w = world();
    await deliver(w, new Date(Date.now() + HOUR));
    expect(w.push.sent.filter((m) => m.data.nudgeId === row.id)).toHaveLength(0);
  });

  it("every outcome is logged on the record, and the app reports opened and dismissed", async () => {
    const [u, other] = [await person("log"), await person("log2")];
    await device(u);
    await nudge(db, { userId: u.id, kind: "streak_risk", data: { days: 3 }, dedupeKey: "l" });
    await nudge(db, { userId: other.id, kind: "streak_risk", data: { days: 3 }, dedupeKey: "l" });
    const w = world();
    await deliver(w);
    const [sent, skipped] = [await one(u), await one(other)];
    expect(sent).toMatchObject({ status: "sent", channel: "push", pushes: 1, skipReason: null });
    expect(sent.decidedAt).not.toBeNull();
    expect(skipped).toMatchObject({ status: "skipped", skipReason: "no_device", channel: null });
    const opened = await app.inject({ method: "POST", url: `/me/nudges/${sent.id}/opened`, headers: as(u) });
    expect(opened.json().openedAt).not.toBeNull();
    const again = await app.inject({ method: "POST", url: `/me/nudges/${sent.id}/opened`, headers: as(u) });
    expect(again.json().openedAt).toBe(opened.json().openedAt);
    expect((await app.inject({ method: "POST", url: `/me/nudges/${sent.id}/dismissed`, headers: as(u) })).json().dismissedAt).not.toBeNull();
    expect((await app.inject({ method: "POST", url: `/me/nudges/${sent.id}/opened`, headers: as(other) })).statusCode).toBe(404);
  });
});

describe("devices", () => {
  const installA = "install-aaaaaaaaaaaaaaaa";
  const installB = "install-bbbbbbbbbbbbbbbb";
  const body = (token: string | null) => ({ platform: "android", token, appVersion: "2.1.0", permission: token ? "granted" : "prompt", timeZone: "Africa/Accra" });

  it("register needs the install id; it records the permission and the zone, and a token lives on one account", async () => {
    const [u, v] = [await person("dv"), await person("dw")];
    expect((await app.inject({ method: "PUT", url: "/me/device", headers: as(u), payload: body(null) })).json().error).toBe("install_id_required");
    const first = await app.inject({ method: "PUT", url: "/me/device", headers: { ...as(u), [INSTALL_ID_HEADER]: installA }, payload: body(null) });
    expect(deviceSchema.parse(first.json())).toMatchObject({ hasToken: false, permission: "prompt" });
    const granted = await app.inject({ method: "PUT", url: "/me/device", headers: { ...as(u), [INSTALL_ID_HEADER]: installA }, payload: body("tok-shared") });
    expect(granted.json()).toMatchObject({ hasToken: true, permission: "granted" });
    expect((await db.select().from(users).where(eq(users.id, u.id)))[0].timeZone).toBe("Africa/Accra");
    // The same phone, signed in to another account.
    await app.inject({ method: "PUT", url: "/me/device", headers: { ...as(v), [INSTALL_ID_HEADER]: installA }, payload: body("tok-shared") });
    const rows = await db.select().from(deviceTokens).where(inArray(deviceTokens.userId, [u.id, v.id]));
    expect(rows.find((d) => d.userId === u.id)!.token).toBeNull();
    expect(rows.find((d) => d.userId === v.id)!.token).toBe("tok-shared");
  });

  it("unregister and sign-out remove this install's; account deletion removes them all and withdraws what's pending", async () => {
    const u = await person("du");
    for (const install of [installA, installB]) await app.inject({ method: "PUT", url: "/me/device", headers: { ...as(u), [INSTALL_ID_HEADER]: install }, payload: body(`t-${install}-${u.id}`) });
    expect((await app.inject({ method: "DELETE", url: "/me/device", headers: { ...as(u), [INSTALL_ID_HEADER]: installA } })).json()).toEqual({ removed: true });
    expect((await app.inject({ method: "POST", url: "/me/sign-out", headers: { ...as(u), [INSTALL_ID_HEADER]: installB } })).json()).toEqual({ devicesRemoved: 1 });
    await device(u);
    await nudge(db, { userId: u.id, kind: "streak_risk", data: { days: 3 }, dedupeKey: "d", dueAt: new Date(Date.now() + HOUR) });
    const [fresh] = await db.select().from(users).where(eq(users.id, u.id));
    await db.transaction((tx) => archiveAccount(tx, fresh, null));
    expect(await db.select().from(deviceTokens).where(eq(deviceTokens.userId, u.id))).toHaveLength(0);
    expect((await one(u)).status).toBe("withdrawn");
  });
});

describe("asking players to follow your corner", () => {
  it("only recent players who don't follow, each once per corner ever, within the host's daily limit", async () => {
    await setNudgeConfig({ ...(await getNudgeConfig()), followAsksPerDay: 2 });
    const host = await person("ah");
    const [p1, p2, p3, follower, old] = [await person("a1"), await person("a2"), await person("a3"), await person("af"), await person("ao")];
    const [c] = await db.insert(corners).values({ ownerUserId: host.id, name: "Corner", status: "unlocked", unlockedAt: new Date() }).returning();
    await db.insert(follows).values({ followerId: follower.id, cornerId: c.id });
    await seat(await party(host, { status: "finished", endedAt: new Date() }), p1, p2, p3, follower);
    await seat(await party(host, { status: "finished", endedAt: new Date(Date.now() - 60 * DAY) }), old);
    const options = followerInviteOptionsSchema.parse((await app.inject({ url: "/me/corner/invite-followers", headers: as(host) })).json());
    expect(options.players.map((p) => p.id).sort()).toEqual([p1.id, p2.id, p3.id].sort());
    expect(options.players.every((p) => !p.alreadyAsked)).toBe(true);
    expect(options.remainingToday).toBe(2);

    const ask = (ids: string[]) => app.inject({ method: "POST", url: "/me/corner/invite-followers", headers: as(host), payload: { userIds: ids } });
    expect((await ask([p1.id])).json()).toEqual({ asked: 1, remainingToday: 1 });
    // Still listed, now marked: each person once per corner, ever.
    const after = followerInviteOptionsSchema.parse((await app.inject({ url: "/me/corner/invite-followers", headers: as(host) })).json());
    expect(after.players.find((p) => p.id === p1.id)?.alreadyAsked).toBe(true);
    const again = await ask([p1.id]);
    expect([again.statusCode, again.json().error, again.json().details]).toEqual([422, "not_eligible", { userIds: [p1.id], reasons: { [p1.id]: "already_asked" } }]);
    expect((await ask([follower.id])).json().details.reasons).toEqual({ [follower.id]: "already_following" });
    const over = await ask([p2.id, p3.id]);
    expect([over.statusCode, over.json().error, over.json().details.remainingToday]).toEqual([429, "follow_asks_limit", 1]);
    expect(await rowsOf(p2)).toHaveLength(0); // nothing half-sent
    expect((await ask([p2.id])).json().remainingToday).toBe(0);
    expect((await one(p1, "corner_follow_ask")).title).toBe(`${host.displayName} asked you to follow Corner`);
    expect((await app.inject({ url: "/me/corner/invite-followers", headers: as(await person("nocorner")) })).json().error).toBe("no_corner");
  });
});

describe("asking anyone to follow your corner", () => {
  async function hostWithCorner(name: string) {
    const host = await person(name);
    const [c] = await db.insert(corners).values({ ownerUserId: host.id, name: `Corner ${seq}`, status: "unlocked", unlockedAt: new Date() }).returning();
    return { host, c };
  }
  const W = `Kúnlé${randomUUID().slice(0, 6)}`; // a word only this test's people have
  const plain = W.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const named = (role: string, extra: Partial<typeof users.$inferInsert> = {}) =>
    makeUser(`${W} ${role}`, { handle: `fa${++seq}${randomUUID().slice(0, 6)}`, email: `fa${seq}${randomUUID().slice(0, 6)}@test.contestly.invalid`, ...extra });
  const options = (host: User, q?: string) =>
    app.inject({ url: `/me/corner/invite-followers${q ? `?q=${encodeURIComponent(q)}` : ""}`, headers: as(host) });

  it("search finds anyone signed up who can be asked, never followers, blocked (either way), banned, deleted or guests", async () => {
    const { host, c } = await hostWithCorner("fsh");
    const [stranger, follower, blockedByHost, blockerOfHost, banned, gone, guest] = await Promise.all([
      named("Stranger"), named("Follower"), named("Blocked"), named("Blocker"), named("Banned", { bannedAt: new Date() }),
      named("Gone", { deletedAt: new Date() }), named("Guest", { isGuest: true }),
    ]);
    await db.insert(follows).values({ cornerId: c.id, followerId: follower.id });
    await db.insert(blocks).values([{ blockerId: host.id, blockedId: blockedByHost.id }, { blockerId: blockerOfHost.id, blockedId: host.id }]);
    const res = followerInviteOptionsSchema.parse((await options(host, plain)).json());
    expect(res.players.map((p) => p.id)).toEqual([stranger.id]);
    expect(res.players[0].alreadyAsked).toBe(false);

    const ask = (ids: string[]) => app.inject({ method: "POST", url: "/me/corner/invite-followers", headers: as(host), payload: { userIds: ids } });
    // None of them can be asked, and a blocked or missing account looks the same as one that isn't there.
    for (const u of [blockedByHost, blockerOfHost, banned, gone, guest]) {
      const r = await ask([u.id]);
      expect([r.statusCode, r.json().details.reasons[u.id]]).toEqual([422, "not_found"]);
    }
    expect((await ask([stranger.id])).json()).toMatchObject({ asked: 1 });
    expect(followerInviteOptionsSchema.parse((await options(host, plain)).json()).players[0]).toMatchObject({ id: stranger.id, alreadyAsked: true });
    expect((await options(host, "a")).statusCode).toBe(400);
  });

  it("once per corner, ever: another corner may still ask the same person", async () => {
    const a = await hostWithCorner("fsa");
    const b = await hostWithCorner("fsb");
    const target = await named("Target");
    const ask = (host: User) => app.inject({ method: "POST", url: "/me/corner/invite-followers", headers: as(host), payload: { userIds: [target.id] } });
    expect((await ask(a.host)).statusCode).toBe(200);
    await db.update(nudges).set({ status: "skipped", skipReason: "kind_cap", decidedAt: new Date() }).where(eq(nudges.userId, target.id));
    expect((await ask(a.host)).json().details.reasons).toEqual({ [target.id]: "already_asked" });
    expect((await ask(b.host)).statusCode).toBe(200);
    expect(await rowsOf(target, "corner_follow_ask")).toHaveLength(2);
  });

  it("the daily limit is per corner", async () => {
    await setNudgeConfig({ ...(await getNudgeConfig()), followAsksPerDay: 1 });
    try {
      const { host } = await hostWithCorner("fsd");
      const [x, y] = [await named("X"), await named("Y")];
      const ask = (ids: string[]) => app.inject({ method: "POST", url: "/me/corner/invite-followers", headers: as(host), payload: { userIds: ids } });
      expect((await ask([x.id])).json()).toEqual({ asked: 1, remainingToday: 0 });
      const over = await ask([y.id]);
      expect([over.statusCode, over.json().error]).toEqual([429, "follow_asks_limit"]);
      const other = await hostWithCorner("fse");
      expect((await app.inject({ method: "POST", url: "/me/corner/invite-followers", headers: as(other.host), payload: { userIds: [y.id] } })).statusCode).toBe(200);
    } finally {
      await setNudgeConfig({ ...(await getNudgeConfig()), followAsksPerDay: DEFAULT_NUDGE_CONFIG.followAsksPerDay });
    }
  });

  it("with Corners notifications off, the ask is in Activity and nothing is pushed", async () => {
    const { host } = await hostWithCorner("fst");
    const target = await named("Quiet", { nudgesOff: ["corners"] });
    await device(target);
    await app.inject({ method: "POST", url: "/me/corner/invite-followers", headers: as(host), payload: { userIds: [target.id] } });
    const w = world();
    await deliver(w);
    expect(await one(target, "corner_follow_ask")).toMatchObject({ status: "skipped", skipReason: "toggle_off" });
    expect(w.push.sent.filter((m) => m.data.kind === "corner_follow_ask")).toEqual([]);
    const activity = activityPageSchema.parse((await app.inject({ url: "/me/activity", headers: as(target) })).json());
    expect(activity.items).toHaveLength(1);
    expect(activity.items[0]).toMatchObject({ kind: "corner_follow_ask", category: "corners", unread: true, people: [{ id: host.id }] });
    // Blocked since: it leaves Activity too.
    await db.insert(blocks).values({ blockerId: target.id, blockedId: host.id });
    expect(activityPageSchema.parse((await app.inject({ url: "/me/activity", headers: as(target) })).json()).items).toEqual([]);
  });
});

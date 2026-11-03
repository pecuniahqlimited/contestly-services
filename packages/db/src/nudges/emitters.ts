/**
 * Who gets which nudge, and when (the triggers of CLAUDE.md's table, with ADR 0012's "your people" and
 * per-corner alerts). Each emitter only records (record.ts); delivery decides the rest. Events arrive as worker
 * jobs or inside the transaction that caused them; times come from the worker's sweeps. All idempotent: a
 * replayed job or a second sweep finds the dedupe key taken.
 */
import { and, count, desc, eq, gt, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import {
  CLIMB_TIME_ZONE, DEEP_LINKS, addDays, lagosDay, localClock, mentionedHandles, type NudgeActor, type NudgeConfig,
} from "@contestly/shared";
import { db, type Tx } from "../client.js";
import { getNudgeConfig } from "../config.js";
import { liveUser } from "../accounts.js";
import { yourPeople } from "../social.js";
import {
  chatThreads, climbRuns, cornerPosts, corners, crews, follows, parties, partyPlayers, users, type Party,
} from "../schema.js";
import { cornerShown } from "../corners.js";
import { nudge } from "./record.js";

type Conn = Tx | typeof db;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const actorOf = async (conn: Conn, userId: string): Promise<NudgeActor | null> => {
  const [u] = await conn.select({ id: users.id, name: users.displayName, isGuest: users.isGuest }).from(users).where(eq(users.id, userId));
  return u ? { id: u.id, name: u.name } : null;
};
const seatsOf = async (conn: Conn, partyId: string) =>
  (await conn.select({ id: partyPlayers.userId }).from(partyPlayers).where(eq(partyPlayers.partyId, partyId))).map((r) => r.id);
/** The people a party's nudges go to: everyone seated, and its host. */
const seatsAndHost = async (conn: Conn, p: Party) => [...new Set([p.createdByUserId, ...(await seatsOf(conn, p.id))])];

// ---- parties ---------------------------------------------------------------------------

/**
 * Every minute: "starts in 5" for parties 4–6 minutes out (due at T-5; someone who joins inside the last four
 * minutes doesn't need it) and "starts in a minute" for parties 30 s–2 min out (due at T-1), to everyone seated
 * and the host. A cancel or a leave before they're due withdraws them (checks.ts).
 */
export async function emitPartyStarting(now = new Date()): Promise<number> {
  let n = 0;
  for (const minutes of [5, 1] as const) {
    const [from, to] = minutes === 5 ? [4 * MINUTE, 6 * MINUTE] : [MINUTE / 2, 2 * MINUTE];
    const due = await db.select().from(parties)
      .where(and(eq(parties.status, "open"), gt(parties.startsAt, new Date(now.getTime() + from)), lte(parties.startsAt, new Date(now.getTime() + to))));
    for (const p of due) {
      for (const userId of await seatsAndHost(db, p)) {
        const r = await nudge(db, {
          userId, kind: "party_starting", data: { partyId: p.id, title: p.title, minutes }, ref: { type: "party", id: p.id },
          dedupeKey: `party_starting:${minutes}:${p.id}`, dueAt: new Date(p.startsAt.getTime() - minutes * MINUTE),
        }, now);
        if (r === "recorded") n++;
      }
    }
  }
  return n;
}

/** The party went live: seated players who aren't in the room a little later hear it (once per party). */
export async function emitPartyLive(partyId: string, cfg?: NudgeConfig): Promise<number> {
  const [p] = await db.select().from(parties).where(eq(parties.id, partyId));
  if (!p || p.status !== "live" || !p.liveAt) return 0;
  const { liveNudgeDelaySeconds } = cfg ?? (await getNudgeConfig());
  let n = 0;
  for (const userId of await seatsOf(db, p.id)) {
    const r = await nudge(db, {
      userId, kind: "party_live", data: { partyId: p.id, title: p.title }, ref: { type: "party", id: p.id },
      dedupeKey: `party_live:${p.id}`, dueAt: new Date(p.liveAt.getTime() + liveNudgeDelaySeconds * 1000),
    });
    if (r === "recorded") n++;
  }
  return n;
}

/** The backstop for emitPartyLive: parties that went live in the last few minutes (the start job's own call can be lost). */
export async function emitRecentlyLive(now = new Date()): Promise<number> {
  const cfg = await getNudgeConfig();
  const live = await db.select({ id: parties.id }).from(parties).where(and(eq(parties.status, "live"), gt(parties.liveAt, new Date(now.getTime() - 5 * MINUTE))));
  let n = 0;
  for (const p of live) n += await emitPartyLive(p.id, cfg);
  return n;
}

/** Someone joined: the host and the seated players they're one of the people of hear it, batched per party per hour. */
export async function emitPeopleJoined(partyId: string, joinerId: string): Promise<number> {
  const [p] = await db.select().from(parties).where(eq(parties.id, partyId));
  const actor = await actorOf(db, joinerId);
  const [joiner] = await db.select({ isGuest: users.isGuest }).from(users).where(eq(users.id, joinerId));
  if (!p || p.status !== "open" || !actor || joiner.isGuest) return 0;
  const theirs = await yourPeople(joinerId);
  let n = 0;
  for (const userId of (await seatsAndHost(db, p)).filter((id) => id !== joinerId && theirs.has(id))) {
    await nudge(db, { userId, kind: "people_joined", data: { partyId: p.id, title: p.title }, ref: { type: "party", id: p.id }, batchKey: `people_joined:${p.id}`, actor });
    n++;
  }
  return n;
}

/**
 * Every minute: public parties starting within fillingUpMinutes with fillingUpShare of their seats taken tell
 * people in their lane (not in it already; most recently seen first, up to fillingUpMaxAudience). Once per
 * party; delivery holds each person to one a day and skips anyone with a party of their own within the hour.
 * A sim's party is only for sim accounts, and a real one only for real accounts.
 */
export async function emitFillingUp(now = new Date()): Promise<number> {
  const cfg = await getNudgeConfig();
  const soon = await db.select().from(parties).where(and(
    eq(parties.status, "open"), eq(parties.visibility, "public"), gt(parties.startsAt, now),
    lte(parties.startsAt, new Date(now.getTime() + cfg.fillingUpMinutes * MINUTE)),
  ));
  if (!soon.length) return 0;
  const taken = new Map((await db.select({ id: partyPlayers.partyId, n: count() }).from(partyPlayers)
    .where(inArray(partyPlayers.partyId, soon.map((p) => p.id))).groupBy(partyPlayers.partyId)).map((r) => [r.id, Number(r.n)]));
  const filling = soon.filter((p) => {
    const n = taken.get(p.id) ?? 0;
    return n >= Math.ceil(p.maxPlayers * cfg.fillingUpShare) && n < p.maxPlayers;
  });
  let n = 0;
  for (const p of filling) {
    const audience = await db.select({ id: users.id }).from(users).where(and(
      liveUser, isNull(users.bannedAt), eq(users.isGuest, false), eq(users.isSystem, false), eq(users.isSim, p.isSim),
      sql`${p.category} = any(${users.interests})`, ne(users.id, p.createdByUserId),
      sql`not exists (select 1 from ${partyPlayers} s where s.party_id = ${p.id} and s.user_id = ${users.id})`,
    )).orderBy(sql`${users.lastSeenAt} desc nulls last`).limit(cfg.fillingUpMaxAudience);
    for (const u of audience) {
      const r = await nudge(db, {
        userId: u.id, kind: "party_filling", data: { partyId: p.id, title: p.title, lane: p.category }, ref: { type: "party", id: p.id },
        dedupeKey: `party_filling:${p.id}`,
      }, now);
      if (r === "recorded") n++;
    }
  }
  return n;
}

/** A public party opened: its host's corner followers with alerts on (ADR 0012). Delivery caps alerts per corner a day. */
export async function emitCornerParty(partyId: string, hostId: string): Promise<number> {
  const [p] = await db.select().from(parties).where(eq(parties.id, partyId));
  const [c] = await db.select().from(corners).where(and(eq(corners.ownerUserId, hostId), cornerShown));
  if (!p || !c || p.visibility !== "public") return 0;
  const followers = await db.select({ id: follows.followerId }).from(follows).innerJoin(users, eq(users.id, follows.followerId))
    .where(and(eq(follows.cornerId, c.id), eq(follows.notify, true), liveUser));
  let n = 0;
  for (const f of followers) {
    const r = await nudge(db, {
      userId: f.id, kind: "corner_party", data: { partyId: p.id, title: p.title, cornerId: c.id, cornerName: c.name }, ref: { type: "corner", id: c.id },
      dedupeKey: `corner_party:${p.id}`,
    });
    if (r === "recorded") n++;
  }
  return n;
}

/** The host cancelled: everyone who was seated (the job carries them, as they were). */
export async function emitHostCancelled(partyId: string, toUserIds: string[], entryBack: boolean): Promise<number> {
  const [p] = await db.select().from(parties).where(eq(parties.id, partyId));
  if (!p) return 0;
  for (const userId of toUserIds) {
    await nudge(db, { userId, kind: "host_cancelled", data: { partyId: p.id, title: p.title, entryBack }, ref: { type: "party", id: p.id }, dedupeKey: `host_cancelled:${p.id}` });
  }
  return toUserIds.length;
}

// ---- chat and corners ------------------------------------------------------------------

/** Where a thread is, as a mention says it. */
async function threadPlace(threadId: string): Promise<string> {
  const [t] = await db.select({ kind: chatThreads.kind, party: parties.title, crew: crews.name }).from(chatThreads)
    .leftJoin(parties, eq(parties.id, chatThreads.partyId)).leftJoin(crews, eq(crews.id, chatThreads.crewId)).where(eq(chatThreads.id, threadId));
  if (t?.kind === "party" && t.party) return `${t.party} chat`;
  if (t?.kind === "crew" && t.crew) return t.crew;
  return "a message";
}

/** @mentions in a party chat, a DM or a crew: always, batched per thread. */
export async function emitMentions(threadId: string, fromUserId: string, toUserIds: string[]): Promise<number> {
  const actor = await actorOf(db, fromUserId);
  if (!actor) return 0;
  const where = await threadPlace(threadId);
  for (const userId of toUserIds.filter((id) => id !== fromUserId)) {
    await nudge(db, { userId, kind: "mention", data: { threadId, where, link: DEEP_LINKS.thread(threadId) }, ref: { type: "thread", id: threadId }, batchKey: `mention:${threadId}`, actor });
  }
  return toUserIds.length;
}

/**
 * A reply to a corner post: the host hears it (batched per post), and anyone @mentioned in it gets a mention
 * (batched per post too). A muted follower's replies never get here.
 */
export async function emitCornerReply(postId: string, fromUserId: string, text: string): Promise<number> {
  const [post] = await db.select({ p: cornerPosts, owner: corners.ownerUserId }).from(cornerPosts).innerJoin(corners, eq(corners.id, cornerPosts.cornerId))
    .where(and(eq(cornerPosts.id, postId), isNull(cornerPosts.deletedAt)));
  const actor = await actorOf(db, fromUserId);
  if (!post || !actor) return 0;
  let n = 0;
  if (post.owner !== fromUserId) {
    await nudge(db, { userId: post.owner, kind: "corner_reply", data: { cornerId: post.p.cornerId, postId }, ref: { type: "post", id: postId }, batchKey: `corner_reply:${postId}`, actor });
    n++;
  }
  const handles = mentionedHandles(text);
  if (handles.length) {
    const mentioned = await db.select({ id: users.id }).from(users).where(and(inArray(users.handle, handles), liveUser, eq(users.isSystem, false), ne(users.id, fromUserId)));
    for (const m of mentioned) {
      await nudge(db, {
        userId: m.id, kind: "mention", data: { threadId: postId, where: "a corner post", link: DEEP_LINKS.cornerPost(post.p.cornerId, postId) },
        ref: { type: "post", id: postId }, batchKey: `mention:post:${postId}`, actor,
      });
      n++;
    }
  }
  return n;
}

// ---- rivals ------------------------------------------------------------------------------

/**
 * After a party's progress is recorded: for each pair of signed-up players who'd played together before, if one
 * now leads the head-to-head and didn't before this party, the other hears it. (One party moves a head-to-head
 * by one, so a lead can't flip outright in one go: "took the lead" is going from level or behind to ahead.)
 */
export async function emitHeadToHeadRivals(tx: Tx, partyId: string): Promise<number> {
  const rows = await tx.execute(sql`
    with seats as (
      select pp.user_id, pp.rank from ${partyPlayers} pp join ${users} u on u.id = pp.user_id
      where pp.party_id = ${partyId} and pp.rank is not null and not u.is_guest and u.deleted_at is null
    )
    select a.user_id as a, b.user_id as b, a.rank as a_rank, b.rank as b_rank,
      count(*) filter (where pa.rank < pb.rank) as a_wins, count(*) filter (where pb.rank < pa.rank) as b_wins, count(*) as played
    from seats a join seats b on a.user_id < b.user_id
    join ${partyPlayers} pa on pa.user_id = a.user_id and pa.rank is not null
    join ${partyPlayers} pb on pb.party_id = pa.party_id and pb.user_id = b.user_id and pb.rank is not null
    join ${parties} p on p.id = pa.party_id and p.status = 'finished'
    group by a.user_id, b.user_id, a.rank, b.rank`);
  const pairs = rows as unknown as { a: string; b: string; a_rank: number; b_rank: number; a_wins: string; b_wins: string; played: string }[];
  const people = new Map<string, NudgeActor & { handle: string }>();
  const personOf = async (id: string) => {
    if (!people.has(id)) {
      const [u] = await tx.select({ id: users.id, name: users.displayName, handle: users.handle }).from(users).where(eq(users.id, id));
      people.set(id, u);
    }
    return people.get(id)!;
  };
  let n = 0;
  for (const r of pairs) {
    if (Number(r.played) < 2 || r.a_rank === r.b_rank) continue; // a first meeting isn't a rivalry; a tie moves nothing
    const [winner, loser, winnerWins, loserWins] = r.a_rank < r.b_rank ? [r.a, r.b, Number(r.a_wins), Number(r.b_wins)] : [r.b, r.a, Number(r.b_wins), Number(r.a_wins)];
    const ledBefore = winnerWins - 1 > loserWins;
    if (winnerWins <= loserWins || ledBefore) continue;
    const w = await personOf(winner);
    await nudge(tx, {
      userId: loser, kind: "rival", data: { by: "head_to_head", rivalHandle: w.handle, rivalName: w.name, them: winnerWins, you: loserWins },
      ref: { type: "party", id: partyId }, dedupeKey: `rival:h2h:${partyId}:${winner}`,
    });
    n++;
  }
  return n;
}

/** A Climb run ended: each of the runner's people whose best stage it passed (and the runner's own best didn't already) hears it. */
export async function emitClimbRivals(tx: Tx, run: { id: string; userId: string; stagesCleared: number }): Promise<number> {
  if (run.stagesCleared <= 0) return 0;
  const [runner] = await tx.select({ name: users.displayName, handle: users.handle, isGuest: users.isGuest }).from(users).where(eq(users.id, run.userId));
  if (!runner || runner.isGuest) return 0;
  const [prev] = await tx.select({ best: sql<number>`coalesce(max(${climbRuns.stagesCleared}), 0)`.mapWith(Number) }).from(climbRuns)
    .where(and(eq(climbRuns.userId, run.userId), ne(climbRuns.id, run.id)));
  const people = [...(await yourPeople(run.userId, tx))];
  if (!people.length) return 0;
  const bests = await tx.select({ userId: climbRuns.userId, best: sql<number>`max(${climbRuns.stagesCleared})`.mapWith(Number) }).from(climbRuns)
    .where(inArray(climbRuns.userId, people)).groupBy(climbRuns.userId);
  let n = 0;
  for (const b of bests.filter((x) => x.best > 0 && prev.best <= x.best && x.best < run.stagesCleared)) {
    await nudge(tx, {
      userId: b.userId, kind: "rival", data: { by: "climb", rivalHandle: runner.handle, rivalName: runner.name, stage: run.stagesCleared },
      dedupeKey: `rival:climb:${run.id}`,
    });
    n++;
  }
  return n;
}

// ---- the hourly sweep: streaks, guests, win-back ---------------------------------------

/**
 * Streak at risk. A streak is kept by starting a Climb run on a Lagos day (recordRunStarted), so it breaks at
 * Lagos midnight. Each hour: people on a streak of 2+ who haven't run today hear it when it's
 * streakRiskHoursBefore hours to midnight where they are, or to Lagos midnight, whichever comes first, so
 * it never arrives after the streak is gone. Once a Lagos day.
 */
export async function emitStreakRisk(now = new Date()): Promise<number> {
  const cfg = await getNudgeConfig();
  const today = lagosDay(now);
  const atHour = 24 - cfg.streakRiskHoursBefore;
  const lagosHour = localClock(now, CLIMB_TIME_ZONE).hour;
  const onStreak = await db.select({ id: users.id, days: users.streakDays, tz: users.timeZone }).from(users)
    .where(and(liveUser, eq(users.isGuest, false), sql`${users.streakDays} >= 2`, eq(users.lastPlayedOn, addDays(today, -1))));
  let n = 0;
  for (const u of onStreak) {
    const local = localClock(now, u.tz).hour;
    if (local !== atHour && lagosHour !== atHour) continue;
    if (lagosHour < atHour && local < atHour) continue;
    const r = await nudge(db, { userId: u.id, kind: "streak_risk", data: { days: u.days }, dedupeKey: `streak_risk:${today}` }, now);
    if (r === "recorded") n++;
  }
  return n;
}

/** A guest's first game was guestFollowUpHours ago (within the next day of that), and they haven't signed up: once. */
export async function emitGuestFollowUps(now = new Date()): Promise<number> {
  const cfg = await getNudgeConfig();
  const to = new Date(now.getTime() - cfg.guestFollowUpHours * HOUR);
  const from = new Date(to.getTime() - DAY);
  const firsts = await db.select({ userId: partyPlayers.userId, first: sql<Date>`min(${parties.endedAt})`.mapWith((v) => new Date(v)) })
    .from(partyPlayers).innerJoin(parties, eq(parties.id, partyPlayers.partyId)).innerJoin(users, eq(users.id, partyPlayers.userId))
    .where(and(eq(users.isGuest, true), liveUser, eq(parties.status, "finished")))
    .groupBy(partyPlayers.userId).having(sql`min(${parties.endedAt}) > ${from.toISOString()}::timestamptz and min(${parties.endedAt}) <= ${to.toISOString()}::timestamptz`);
  let n = 0;
  for (const g of firsts) {
    const [p] = await db.select({ id: parties.id, title: parties.title }).from(parties).innerJoin(partyPlayers, eq(partyPlayers.partyId, parties.id))
      .where(and(eq(partyPlayers.userId, g.userId), eq(parties.status, "finished"))).orderBy(parties.endedAt).limit(1);
    const r = await nudge(db, { userId: g.userId, kind: "guest_follow_up", data: { partyId: p.id, title: p.title }, dedupeKey: "guest_follow_up" }, now);
    if (r === "recorded") n++;
  }
  return n;
}

/**
 * Win-back: on each of winBackDays days without a session (counted in their own days from lastSeenAt), at
 * winBackLocalHour where they are, what one of their people did since: hosted parties, else played them, else
 * climbed. Nothing true to say, nothing sent. Twice per absence (one per day in winBackDays), then it stops.
 */
export async function emitWinBack(now = new Date()): Promise<number> {
  const cfg = await getNudgeConfig();
  const longest = Math.max(0, ...cfg.winBackDays);
  if (!longest) return 0;
  const away = await db.select({ id: users.id, tz: users.timeZone, seen: users.lastSeenAt }).from(users).where(and(
    liveUser, isNull(users.bannedAt), eq(users.isGuest, false), eq(users.isSystem, false),
    lte(users.lastSeenAt, new Date(now.getTime() - (Math.min(...cfg.winBackDays) - 1) * DAY)),
    gt(users.lastSeenAt, new Date(now.getTime() - (longest + 1) * DAY)),
  ));
  let n = 0;
  for (const u of away) {
    const here = localClock(now, u.tz);
    if (here.hour !== cfg.winBackLocalHour) continue;
    const seenDay = localClock(u.seen!, u.tz).day;
    const daysAway = Math.round((Date.parse(`${here.day}T00:00:00Z`) - Date.parse(`${seenDay}T00:00:00Z`)) / DAY);
    if (!cfg.winBackDays.includes(daysAway)) continue;
    const what = await whatYourPeopleDid(u.id, u.seen!);
    if (!what) continue;
    const r = await nudge(db, { userId: u.id, kind: "win_back", data: what, dedupeKey: `win_back:${daysAway}:${seenDay}` }, now);
    if (r === "recorded") n++;
  }
  return n;
}

const times = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

/** The most active of their people since `since`: who hosted the most parties, else played the most, else climbed highest. */
async function whatYourPeopleDid(userId: string, since: Date): Promise<{ personName: string; personHandle: string; what: string } | null> {
  const people = [...(await yourPeople(userId))];
  if (!people.length) return null;
  const finishedSince = and(eq(parties.status, "finished"), gt(parties.endedAt, since));
  const [hosted] = await db.select({ id: parties.createdByUserId, n: count() }).from(parties)
    .where(and(inArray(parties.createdByUserId, people), finishedSince)).groupBy(parties.createdByUserId).orderBy(desc(count())).limit(1);
  const [played] = hosted ? [] : await db.select({ id: partyPlayers.userId, n: count() }).from(partyPlayers).innerJoin(parties, eq(parties.id, partyPlayers.partyId))
    .where(and(inArray(partyPlayers.userId, people), finishedSince)).groupBy(partyPlayers.userId).orderBy(desc(count())).limit(1);
  const [climbed] = hosted || played ? [] : await db.select({ id: climbRuns.userId, best: sql<number>`max(${climbRuns.stagesCleared})`.mapWith(Number) }).from(climbRuns)
    .where(and(inArray(climbRuns.userId, people), gt(climbRuns.startedAt, since), gt(climbRuns.stagesCleared, 0))).groupBy(climbRuns.userId)
    .orderBy(desc(sql`max(${climbRuns.stagesCleared})`)).limit(1);
  const pick = hosted ? { id: hosted.id, what: `hosted ${times(Number(hosted.n), "a party", "parties")}` }
    : played ? { id: played.id, what: `played ${times(Number(played.n), "a party", "parties")}` }
    : climbed ? { id: climbed.id, what: `reached stage ${climbed.best} on The Climb` } : null;
  if (!pick) return null;
  const [p] = await db.select({ name: users.displayName, handle: users.handle }).from(users).where(eq(users.id, pick.id));
  return { personName: p.name, personHandle: p.handle, what: pick.what };
}

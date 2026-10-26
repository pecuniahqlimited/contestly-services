/**
 * Crews (row 6b; decided in CLAUDE.md): private, invite-only, up to crewMaxMembers. The creator and admins
 * invite people they're connected to; the invitee accepts. The creator promotes, demotes and removes; when
 * they leave, the crew goes to the longest-standing admin, else the longest-standing member (nextCreator).
 * Only members see a crew: to anyone else it doesn't exist (404). Every change that people should see
 * leaves a line in the crew's chat; callers publish the returned lines after the reply.
 */
import { and, asc, count, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  chatMembers, climbRuns, climbWeekResults, crewInvites, crewLine, crewMembers, crewThreadId, crews, db, getSocialConfig, joinThread, ladderAt,
  parties, partyPlayers, socialScores, users, type Crew, type Tx, type User,
} from "@contestly/db";
import { socialBoardRanks } from "@contestly/game";
import { addDays, lagosDay, nextCreator, weekOf, type ChatMessage, type CreateCrewInput, type CrewRecords, type CrewRole, type Person } from "@contestly/shared";
import { httpError } from "./httpError.js";
import { connectedTo } from "./invites.js";
import { personColumns } from "./people.js";
import { threadsFor } from "./chats.js";

const notFound = () => httpError(404, "not_found");

/** The crew and the viewer's role in it; 404 to anyone who isn't a member (crews are private). */
export async function membership(q: Tx | typeof db, crewId: string, userId: string): Promise<{ crew: Crew; role: CrewRole }> {
  const [row] = await q.select({ crew: crews, role: crewMembers.role }).from(crews)
    .innerJoin(crewMembers, and(eq(crewMembers.crewId, crews.id), eq(crewMembers.userId, userId)))
    .where(and(eq(crews.id, crewId), isNull(crews.archivedAt)));
  if (!row) throw notFound();
  return row;
}

const membersCount = async (q: Tx, crewId: string) => Number((await q.select({ n: count() }).from(crewMembers).where(eq(crewMembers.crewId, crewId)))[0].n);
const pendingCount = async (q: Tx, crewId: string) => Number((await q.select({ n: count() }).from(crewInvites).where(and(eq(crewInvites.crewId, crewId), eq(crewInvites.status, "pending"))))[0].n);

/** Ask people to join: only people the inviter is connected to; already in or already asked are skipped; members plus pending stay within the cap. */
async function invite(tx: Tx, crewId: string, inviter: User, ids: string[]): Promise<string[]> {
  const wanted = [...new Set(ids)].filter((id) => id !== inviter.id);
  if (!wanted.length) return [];
  const connected = await connectedTo(tx, inviter.id, wanted);
  if (wanted.some((id) => !connected.has(id))) throw httpError(403, "cannot_invite");
  const [members, pending] = await Promise.all([
    tx.select({ id: crewMembers.userId }).from(crewMembers).where(and(eq(crewMembers.crewId, crewId), inArray(crewMembers.userId, wanted))),
    tx.select({ id: crewInvites.inviteeId }).from(crewInvites).where(and(eq(crewInvites.crewId, crewId), inArray(crewInvites.inviteeId, wanted), eq(crewInvites.status, "pending"))),
  ]);
  const skip = new Set([...members, ...pending].map((r) => r.id));
  const fresh = wanted.filter((id) => !skip.has(id));
  const { crewMaxMembers } = await getSocialConfig();
  if ((await membersCount(tx, crewId)) + (await pendingCount(tx, crewId)) + fresh.length > crewMaxMembers) throw httpError(409, "crew_full");
  for (const inviteeId of fresh) {
    await tx.insert(crewInvites).values({ crewId, inviteeId, inviterId: inviter.id })
      .onConflictDoUpdate({ target: [crewInvites.crewId, crewInvites.inviteeId], set: { status: "pending", inviterId: inviter.id, createdAt: new Date(), respondedAt: null } });
  }
  return fresh;
}

/** Lock the crew row so membership changes (joins against the cap, creator hand-over) happen one at a time. */
const lockCrew = (tx: Tx, crewId: string) => tx.select({ id: crews.id }).from(crews).where(eq(crews.id, crewId)).for("update");

export async function createCrew(me: User, input: CreateCrewInput) {
  return db.transaction(async (tx) => {
    const [crew] = await tx.insert(crews).values({ name: input.name, emoji: input.emoji, color: input.color, createdByUserId: me.id }).returning();
    await tx.insert(crewMembers).values({ crewId: crew.id, userId: me.id, role: "creator" });
    await joinThread(tx, await crewThreadId(tx, crew.id), me.id);
    const invited = await invite(tx, crew.id, me, input.inviteUserIds);
    const line = await crewLine(tx, crew.id, `${me.displayName} started ${crew.name}.`);
    return { crewId: crew.id, invited: invited.length, lines: [line] };
  });
}

export async function updateCrew(me: User, crewId: string, patch: Partial<Pick<Crew, "name" | "emoji" | "color">>) {
  const { role } = await membership(db, crewId, me.id);
  if (role === "member") throw httpError(403, "crew_admins_only");
  await db.update(crews).set(patch).where(eq(crews.id, crewId));
}

export async function inviteToCrew(me: User, crewId: string, ids: string[]) {
  return db.transaction(async (tx) => {
    await lockCrew(tx, crewId);
    const { role } = await membership(tx, crewId, me.id);
    if (role === "member") throw httpError(403, "crew_admins_only");
    return { invited: (await invite(tx, crewId, me, ids)).length };
  });
}

/** The invitee answers. Accepting joins the crew and its chat. Guests can't be in crews. */
export async function answerCrewInvite(me: User, crewId: string, accept: boolean) {
  return db.transaction(async (tx) => {
    await lockCrew(tx, crewId);
    const [inv] = await tx.select().from(crewInvites).where(and(eq(crewInvites.crewId, crewId), eq(crewInvites.inviteeId, me.id), eq(crewInvites.status, "pending")));
    const [crew] = await tx.select().from(crews).where(and(eq(crews.id, crewId), isNull(crews.archivedAt)));
    if (!inv || !crew) throw httpError(404, "no_pending_invite");
    await tx.update(crewInvites).set({ status: accept ? "accepted" : "dismissed", respondedAt: new Date() }).where(and(eq(crewInvites.crewId, crewId), eq(crewInvites.inviteeId, me.id)));
    if (!accept) return { joined: false, lines: [] as ChatMessage[] };
    // Pending invites were counted against the cap when sent; this one is now a member instead.
    if ((await membersCount(tx, crewId)) >= (await getSocialConfig()).crewMaxMembers) throw httpError(409, "crew_full");
    await tx.insert(crewMembers).values({ crewId, userId: me.id }).onConflictDoNothing();
    await joinThread(tx, await crewThreadId(tx, crewId), me.id);
    return { joined: true, lines: [await crewLine(tx, crewId, `${me.displayName} joined the crew.`)] };
  });
}

/** Creator only: make someone an admin, or a member again. */
export async function setCrewRole(me: User, crewId: string, userId: string, role: "admin" | "member") {
  const { role: mine } = await membership(db, crewId, me.id);
  if (mine !== "creator") throw httpError(403, "creator_only");
  const [row] = await db.update(crewMembers).set({ role }).where(and(eq(crewMembers.crewId, crewId), eq(crewMembers.userId, userId), ne(crewMembers.role, "creator"))).returning();
  if (!row) throw notFound();
  return { role: row.role };
}

/** Out of the crew and its chat. */
async function dropMember(tx: Tx, crewId: string, userId: string) {
  await tx.delete(crewMembers).where(and(eq(crewMembers.crewId, crewId), eq(crewMembers.userId, userId)));
  await tx.delete(chatMembers).where(and(eq(chatMembers.threadId, await crewThreadId(tx, crewId)), eq(chatMembers.userId, userId)));
}

/** Creator only: remove someone (not themselves; they leave instead). */
export async function removeFromCrew(me: User, crewId: string, userId: string) {
  return db.transaction(async (tx) => {
    await lockCrew(tx, crewId);
    const { role } = await membership(tx, crewId, me.id);
    if (role !== "creator") throw httpError(403, "creator_only");
    if (userId === me.id) throw httpError(409, "leave_instead");
    const [them] = await tx.select({ name: users.displayName }).from(crewMembers).innerJoin(users, eq(users.id, crewMembers.userId))
      .where(and(eq(crewMembers.crewId, crewId), eq(crewMembers.userId, userId)));
    if (!them) throw notFound();
    await dropMember(tx, crewId, userId);
    return { lines: [await crewLine(tx, crewId, `${them.name} is no longer in the crew.`)] };
  });
}

/** Leave. A leaving creator hands the crew over (nextCreator); the last one out archives it. */
export async function leaveCrew(me: User, crewId: string) {
  return db.transaction(async (tx) => {
    await lockCrew(tx, crewId);
    const { role } = await membership(tx, crewId, me.id);
    await dropMember(tx, crewId, me.id);
    const remaining = await tx.select({ userId: crewMembers.userId, role: crewMembers.role, joinedAt: crewMembers.joinedAt, name: users.displayName })
      .from(crewMembers).innerJoin(users, eq(users.id, crewMembers.userId)).where(eq(crewMembers.crewId, crewId));
    if (!remaining.length) {
      await tx.update(crews).set({ archivedAt: new Date() }).where(eq(crews.id, crewId));
      await tx.update(crewInvites).set({ status: "dismissed", respondedAt: new Date() }).where(and(eq(crewInvites.crewId, crewId), eq(crewInvites.status, "pending")));
      return { archived: true, lines: [] as ChatMessage[] };
    }
    let text = `${me.displayName} left the crew.`;
    if (role === "creator") {
      const next = nextCreator(remaining)!;
      await tx.update(crewMembers).set({ role: "creator" }).where(and(eq(crewMembers.crewId, crewId), eq(crewMembers.userId, next.userId)));
      text += ` ${next.name} runs it now.`;
    }
    return { archived: false, lines: [await crewLine(tx, crewId, text)] };
  });
}

// ---- reading ---------------------------------------------------------------------------

/** Last week's first place on this crew's board: they wear the crown this week. */
export async function championOf(crewId: string, today = lagosDay()): Promise<string | null> {
  const [row] = await db.select({ userId: climbWeekResults.userId }).from(climbWeekResults)
    .where(and(eq(climbWeekResults.week, addDays(weekOf(today), -7)), eq(climbWeekResults.scope, "crew"), eq(climbWeekResults.scopeId, crewId), eq(climbWeekResults.place, 1)));
  return row?.userId ?? null;
}

export async function crewMemberIds(crewId: string): Promise<string[]> {
  return (await db.select({ id: crewMembers.userId }).from(crewMembers).where(eq(crewMembers.crewId, crewId))).map((r) => r.id);
}

/** Records among current members: best climb (stages, then points, then first there), most crew-party wins, longest streak. */
export async function crewRecords(crewId: string): Promise<CrewRecords> {
  const inCrew = eq(crewMembers.crewId, crewId);
  const [[climb], [wins], [streak]] = await Promise.all([
    db.select({ person: personColumns, stagesCleared: climbRuns.stagesCleared, points: climbRuns.points, ladderVersion: climbRuns.ladderVersion }).from(climbRuns)
      .innerJoin(crewMembers, and(eq(crewMembers.userId, climbRuns.userId), inCrew)).innerJoin(users, eq(users.id, climbRuns.userId))
      .where(sql`${climbRuns.stagesCleared} > 0`)
      .orderBy(desc(climbRuns.stagesCleared), desc(climbRuns.points), asc(climbRuns.endedAt)).limit(1),
    db.select({ person: personColumns, wins: count() }).from(partyPlayers)
      .innerJoin(parties, and(eq(parties.id, partyPlayers.partyId), eq(parties.crewId, crewId), eq(parties.status, "finished")))
      .innerJoin(crewMembers, and(eq(crewMembers.userId, partyPlayers.userId), inCrew)).innerJoin(users, eq(users.id, partyPlayers.userId))
      .where(eq(partyPlayers.rank, 1)).groupBy(users.id).orderBy(desc(count()), asc(users.handle)).limit(1),
    db.select({ person: personColumns, days: users.bestStreakDays }).from(crewMembers).innerJoin(users, eq(users.id, crewMembers.userId))
      .where(and(inCrew, sql`${users.bestStreakDays} > 0`)).orderBy(desc(users.bestStreakDays), asc(crewMembers.joinedAt)).limit(1),
  ]);
  const stageCount = climb ? (await ladderAt(climb.ladderVersion)).stages.length : 0;
  return {
    bestClimb: climb ? { person: climb.person, stagesCleared: climb.stagesCleared, points: climb.points, clearedAll: climb.stagesCleared === stageCount } : null,
    mostCrewPartyWins: wins ? { person: wins.person, wins: Number(wins.wins) } : null,
    longestStreak: streak ? { person: streak.person, days: streak.days } : null,
  };
}

export async function crewDetail(me: User, crewId: string) {
  const { crew, role } = await membership(db, crewId, me.id);
  const [members, pending, champion, records, threadId, { crewMaxMembers }] = await Promise.all([
    db.select({ person: personColumns, role: crewMembers.role, joinedAt: crewMembers.joinedAt }).from(crewMembers).innerJoin(users, eq(users.id, crewMembers.userId))
      .where(eq(crewMembers.crewId, crewId)).orderBy(asc(crewMembers.joinedAt)),
    role === "member" ? [] : db.select(personColumns).from(crewInvites).innerJoin(users, eq(users.id, crewInvites.inviteeId))
      .where(and(eq(crewInvites.crewId, crewId), eq(crewInvites.status, "pending"))).orderBy(asc(crewInvites.createdAt)),
    championOf(crewId),
    crewRecords(crewId),
    crewThreadId(db, crewId),
    getSocialConfig(),
  ]);
  const championPerson = members.find((m) => m.person.id === champion)?.person ?? null;
  return {
    id: crew.id, name: crew.name, emoji: crew.emoji, color: crew.color, memberCount: members.length, myRole: role, threadId, maxMembers: crewMaxMembers,
    members: members.map((m) => ({ person: m.person, role: m.role, joinedAt: m.joinedAt.toISOString(), crowned: m.person.id === champion })),
    champion: championPerson, records, pendingInvites: pending,
  };
}

/** Chats › Crews: each of my crews with my place this week, who leads, the chat's last line and unread. */
export async function myCrews(me: User) {
  const rows = await db.select({ crew: crews, role: crewMembers.role }).from(crewMembers)
    .innerJoin(crews, and(eq(crews.id, crewMembers.crewId), isNull(crews.archivedAt))).where(eq(crewMembers.userId, me.id));
  if (!rows.length) return [];
  const threads = await threadsFor("crew", rows.map((r) => r.crew.id), me.id);
  return Promise.all(rows.map(async ({ crew, role }) => {
    const ids = await crewMemberIds(crew.id);
    const ranked = socialBoardRanks((await socialScores(ids, "week")).filter((s) => s.climb + s.parties > 0));
    const leaderId = ranked.find((r) => r.rank === 1)?.userId;
    const [leader] = leaderId ? await db.select(personColumns).from(users).where(eq(users.id, leaderId)) : [];
    const chat = threads.get(crew.id)!;
    return {
      id: crew.id, name: crew.name, emoji: crew.emoji, color: crew.color, memberCount: ids.length, role,
      threadId: chat.threadId, lastMessage: chat.lastLine, unread: chat.unread,
      myRank: ranked.find((r) => r.userId === me.id)?.rank ?? null, leader: (leader as Person | undefined) ?? null,
    };
  })).then((list) => list.sort((a, b) => (b.lastMessage?.createdAt ?? "").localeCompare(a.lastMessage?.createdAt ?? "")));
}

/** Crews I've been asked to join, newest first. */
export async function myCrewInvites(me: User) {
  const inviter = users;
  const rows = await db.select({ crew: crews, invitedBy: personColumns, createdAt: crewInvites.createdAt }).from(crewInvites)
    .innerJoin(crews, and(eq(crews.id, crewInvites.crewId), isNull(crews.archivedAt))).innerJoin(inviter, eq(inviter.id, crewInvites.inviterId))
    .where(and(eq(crewInvites.inviteeId, me.id), eq(crewInvites.status, "pending"))).orderBy(desc(crewInvites.createdAt));
  return Promise.all(rows.map(async (r) => ({
    crew: { id: r.crew.id, name: r.crew.name, emoji: r.crew.emoji, color: r.crew.color, memberCount: (await crewMemberIds(r.crew.id)).length },
    invitedBy: r.invitedBy, createdAt: r.createdAt.toISOString(),
  })));
}

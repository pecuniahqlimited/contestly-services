/**
 * Corners in the API (ADR 0012): the corner page, follows and the public follower list, host posts with
 * reactions and one level of replies, mutes, and the progress view. Who can see a corner is cornerShown
 * (packages/db); unlocking is decided there too. Muted followers are never told: what they write reaches
 * only themselves.
 */
import { and, asc, count, desc, eq, inArray, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import {
  cornerMutes, cornerNewPlayers, cornerParties, cornerPostReactions, cornerPostReplies, cornerPosts, corners, cornerShown, currentCornerConfig, db, follows, getChatConfig,
  getSocialConfig, hostCounts, liveUser, moderationItems, parties, partyPlayers, publiclyHostedBy, users, addFeedEvent, cornerOf, refreshDefaultLane, simVisibleTo, type Corner, type User,
} from "@contestly/db";
import { notifyQueue, valkeyCounter } from "@contestly/queue";
import {
  CORNER_REGULARS_SHOWN, CORNER_UP_NEXT_SHOWN, CORNER_WINNERS_SHOWN, POST_REPLIES_INLINE, YOUR_PEOPLE_FACES, chatRateCheck, isBraggingRights, lagosDay, maskProfanity,
  partyPointsFor, unlockProgress, weekOf, type CornerPost, type CornerProgress, type CornerReaction, type CornerUpdate, type Person, type SuggestedCorners,
} from "@contestly/shared";
import { httpError } from "./httpError.js";
import { peopleOf, personColumns } from "./people.js";
import { partySummaries } from "./partySummaries.js";
import { rateLimited, valkey } from "./redis.js";

// ---- finding a corner ------------------------------------------------------------------

/** A corner people can see, with its owner, or 404. */
export async function shownCorner(id: string) {
  const [row] = await db.select({ c: corners, owner: personColumns }).from(corners).innerJoin(users, eq(users.id, corners.ownerUserId))
    .where(and(eq(corners.id, id), cornerShown));
  if (!row) throw httpError(404, "not_found");
  return row;
}

const followerCount = async (cornerId: string) => {
  const [{ n }] = await db.select({ n: count() }).from(follows).innerJoin(users, eq(users.id, follows.followerId)).where(and(eq(follows.cornerId, cornerId), liveUser));
  return Number(n);
};

async function followOf(viewerId: string | undefined, cornerId: string) {
  if (!viewerId) return null;
  const [f] = await db.select().from(follows).where(and(eq(follows.followerId, viewerId), eq(follows.cornerId, cornerId)));
  return f ?? null;
}

/** The host's corner as a profile or a lobby shows it ("Follow corner"), or null when they have none to show. */
export async function hostCornerOf(hostId: string, viewerId: string | undefined) {
  const [c] = await db.select({ id: corners.id, name: corners.name, color: corners.color, lane: corners.lane }).from(corners).where(and(eq(corners.ownerUserId, hostId), cornerShown));
  if (!c) return null;
  return { ...c, following: !!(await followOf(viewerId, c.id)) };
}

// ---- follows ---------------------------------------------------------------------------

export async function follow(me: User, cornerId: string) {
  const { c } = await shownCorner(cornerId);
  if (c.ownerUserId === me.id) throw httpError(409, "cannot_follow_own_corner");
  await db.insert(follows).values({ followerId: me.id, cornerId }).onConflictDoNothing();
  const f = await followOf(me.id, cornerId);
  return { following: true, notify: f!.notify, followerCount: await followerCount(cornerId) };
}

export async function unfollow(me: User, cornerId: string) {
  await db.delete(follows).where(and(eq(follows.followerId, me.id), eq(follows.cornerId, cornerId)));
  return { following: false, notify: false, followerCount: await followerCount(cornerId) };
}

/** Per-corner party alerts (on by default). Only the toggle is stored; nudges are row 9. */
export async function setAlerts(me: User, cornerId: string, notify: boolean) {
  const [row] = await db.update(follows).set({ notify }).where(and(eq(follows.followerId, me.id), eq(follows.cornerId, cornerId))).returning();
  if (!row) throw httpError(404, "not_following");
  return { following: true, notify: row.notify, followerCount: await followerCount(cornerId) };
}

/** "N of your people follow this": how many, and the first few faces. */
async function yourPeopleFollowing(cornerId: string, people: Set<string>) {
  if (!people.size) return { count: 0, faces: [] as Person[] };
  const rows = await db.select(personColumns).from(follows).innerJoin(users, eq(users.id, follows.followerId))
    .where(and(eq(follows.cornerId, cornerId), inArray(follows.followerId, [...people]), liveUser)).orderBy(desc(follows.createdAt));
  return { count: rows.length, faces: rows.slice(0, YOUR_PEOPLE_FACES) };
}

/** Cursor for the follower list: when they followed and who, so a page boundary never skips or repeats. */
const followerCursor = (at: Date, id: string) => `${at.toISOString()}_${id}`;

/** The public follower list, newest first, a page at a time, with how many of the viewer's people are in it on top. */
export async function followersPage(cornerId: string, viewerId: string | undefined, opts: { before?: string; limit: number }) {
  await shownCorner(cornerId);
  let cursor: SQL | undefined;
  if (opts.before) {
    const [at, id] = opts.before.split("_");
    const when = new Date(at);
    if (Number.isNaN(when.getTime()) || !id) throw httpError(400, "bad_cursor");
    cursor = or(lt(follows.createdAt, when), and(eq(follows.createdAt, when), lt(follows.followerId, id)));
  }
  const people = await peopleOf(viewerId);
  const [rows, total, mine] = await Promise.all([
    db.select({ person: personColumns, followedAt: follows.createdAt }).from(follows).innerJoin(users, eq(users.id, follows.followerId))
      .where(and(eq(follows.cornerId, cornerId), liveUser, cursor)).orderBy(desc(follows.createdAt), desc(follows.followerId)).limit(opts.limit + 1),
    followerCount(cornerId),
    yourPeopleFollowing(cornerId, people),
  ]);
  const page = rows.slice(0, opts.limit);
  const last = page.at(-1);
  return {
    total, yourPeople: mine,
    followers: page.map((r) => ({ person: r.person, followedAt: r.followedAt.toISOString(), isYourPerson: people.has(r.person.id) })),
    before: rows.length > opts.limit && last ? followerCursor(last.followedAt, last.person.id) : null,
  };
}

/** GET /me/follows: the corners you follow that are shown, newest follow first. */
export async function myFollows(me: User) {
  const rows = await db.select({ c: corners, owner: personColumns, notify: follows.notify, followedAt: follows.createdAt }).from(follows)
    .innerJoin(corners, eq(corners.id, follows.cornerId)).innerJoin(users, eq(users.id, corners.ownerUserId))
    .where(and(eq(follows.followerId, me.id), cornerShown)).orderBy(desc(follows.createdAt));
  const counts = await followerCounts(rows.map((r) => r.c.id));
  return rows.map((r) => ({ corner: cornerRef(r.c, r.owner, counts.get(r.c.id) ?? 0), notify: r.notify, followedAt: r.followedAt.toISOString() }));
}

async function followerCounts(ids: string[]) {
  if (!ids.length) return new Map<string, number>();
  const rows = await db.select({ id: follows.cornerId, n: count() }).from(follows).innerJoin(users, eq(users.id, follows.followerId))
    .where(and(inArray(follows.cornerId, ids), liveUser)).groupBy(follows.cornerId);
  return new Map(rows.map((r) => [r.id, Number(r.n)]));
}

const cornerRef = (c: Corner, owner: Person, followerCount: number) => ({ id: c.id, name: c.name, owner, level: c.level, followerCount, lane: c.lane, color: c.color });

/** Most corners the interim suggestions look at; plenty while corners are few, and row 7 replaces it. */
const SUGGESTION_POOL = 500;

/**
 * Corners to follow (interim, until row 7): shown corners in the viewer's lanes by followers, then the most
 * followed others, leaving out their own and those they follow; never empty while any corner is shown.
 */
export async function suggestedCorners(viewer: User | undefined, limit: number): Promise<SuggestedCorners> {
  const n = sql<number>`(select count(*) from ${follows} f join ${users} fu on fu.id = f.follower_id and fu.deleted_at is null where f.corner_id = ${corners.id})`.mapWith(Number);
  const pool = await db.select({ c: corners, owner: personColumns, followers: n }).from(corners).innerJoin(users, eq(users.id, corners.ownerUserId))
    .where(and(cornerShown, simVisibleTo(viewer, corners.isSim))).orderBy(desc(n), asc(corners.unlockedAt), asc(corners.id)).limit(SUGGESTION_POOL);
  const followed = new Set(viewer ? (await db.select({ id: follows.cornerId }).from(follows).where(eq(follows.followerId, viewer.id))).map((r) => r.id) : []);
  const lanes = new Set<string>(viewer?.interests ?? []);
  const open = pool.filter((r) => r.c.ownerUserId !== viewer?.id && !followed.has(r.c.id));
  const yours = (r: (typeof pool)[number]) => !!r.c.lane && lanes.has(r.c.lane);
  const picked = [
    ...open.filter(yours).map((r) => ({ r, reason: "your_lane" as const })),
    ...open.filter((r) => !yours(r)).map((r) => ({ r, reason: "popular" as const })),
  ];
  const fallback = picked.length ? picked : pool.filter((r) => r.c.ownerUserId !== viewer?.id).map((r) => ({ r, reason: "popular" as const }));
  return {
    corners: fallback.slice(0, limit).map(({ r, reason }) => ({ corner: cornerRef(r.c, r.owner, r.followers), reason, following: followed.has(r.c.id) })),
  };
}

/** The corners the viewer follows (for the feed and the Parties tab's "following" filter). */
export async function followedCornerIds(viewerId: string) {
  const rows = await db.select({ id: follows.cornerId, ownerId: corners.ownerUserId }).from(follows).innerJoin(corners, eq(corners.id, follows.cornerId))
    .where(and(eq(follows.followerId, viewerId), cornerShown));
  return rows;
}

// ---- mutes -----------------------------------------------------------------------------

const isMuted = async (cornerId: string, userId: string) =>
  !!(await db.select({ u: cornerMutes.userId }).from(cornerMutes).where(and(eq(cornerMutes.cornerId, cornerId), eq(cornerMutes.userId, userId))))[0];

async function ownedCorner(me: User, cornerId: string) {
  const { c } = await shownCorner(cornerId);
  if (c.ownerUserId !== me.id) throw httpError(403, "not_corner_owner");
  return c;
}

export async function mute(me: User, cornerId: string, userId: string) {
  await ownedCorner(me, cornerId);
  if (userId === me.id) throw httpError(409, "cannot_mute_self");
  await db.insert(cornerMutes).values({ cornerId, userId, mutedByUserId: me.id }).onConflictDoNothing();
  return { muted: true };
}

export async function unmute(me: User, cornerId: string, userId: string) {
  await ownedCorner(me, cornerId);
  await db.delete(cornerMutes).where(and(eq(cornerMutes.cornerId, cornerId), eq(cornerMutes.userId, userId)));
  return { muted: false };
}

export async function mutesOf(me: User, cornerId: string) {
  await ownedCorner(me, cornerId);
  const rows = await db.select({ person: personColumns, at: cornerMutes.createdAt }).from(cornerMutes).innerJoin(users, eq(users.id, cornerMutes.userId))
    .where(eq(cornerMutes.cornerId, cornerId)).orderBy(desc(cornerMutes.createdAt));
  return rows.map((r) => ({ person: r.person, mutedAt: r.at.toISOString() }));
}

// ---- posts -----------------------------------------------------------------------------

/** The owner posts text, capped by social config, masked like chat. It goes in their followers' feeds. */
export async function createPost(me: User, cornerId: string, text: string) {
  const c = await ownedCorner(me, cornerId);
  const { cornerPostMaxChars } = await getSocialConfig();
  if (text.length > cornerPostMaxChars) throw httpError(422, "post_too_long", { max: cornerPostMaxChars });
  const clean = maskProfanity(text);
  const post = await db.transaction(async (tx) => {
    const [p] = await tx.insert(cornerPosts).values({ cornerId: c.id, authorUserId: me.id, text: clean }).returning();
    await addFeedEvent(tx, me.id, "corner_post", { cornerId: c.id, postId: p.id, text: clean }, { cornerPostId: p.id });
    return p;
  });
  return (await postViews([post], me.id))[0];
}

async function livePost(postId: string) {
  const [row] = await db.select({ p: cornerPosts }).from(cornerPosts).innerJoin(corners, eq(corners.id, cornerPosts.cornerId))
    .where(and(eq(cornerPosts.id, postId), isNull(cornerPosts.deletedAt), cornerShown));
  if (!row) throw httpError(404, "not_found");
  return row.p;
}

export async function deletePost(me: User, postId: string) {
  const post = await livePost(postId);
  await ownedCorner(me, post.cornerId);
  await db.update(cornerPosts).set({ deletedAt: new Date(), deletedByUserId: me.id }).where(eq(cornerPosts.id, postId));
  return { deleted: true };
}

/** Followers (and the owner) may react and reply. */
async function assertMayTakePart(me: User, cornerId: string) {
  const [c] = await db.select({ ownerUserId: corners.ownerUserId }).from(corners).where(eq(corners.id, cornerId));
  if (c.ownerUserId === me.id) return;
  if (!(await followOf(me.id, cornerId))) throw httpError(403, "follow_to_take_part");
}

/** One reaction per person per post; a second replaces the first. A muted follower's reaction counts only for them. */
export async function react(me: User, postId: string, emoji: CornerReaction) {
  const post = await livePost(postId);
  await assertMayTakePart(me, post.cornerId);
  const muted = await isMuted(post.cornerId, me.id);
  await db.insert(cornerPostReactions).values({ postId, userId: me.id, emoji, muted })
    .onConflictDoUpdate({ target: [cornerPostReactions.postId, cornerPostReactions.userId], set: { emoji, muted, createdAt: new Date() } });
  return (await postViews([post], me.id))[0];
}

export async function unreact(me: User, postId: string) {
  const post = await livePost(postId);
  await db.delete(cornerPostReactions).where(and(eq(cornerPostReactions.postId, postId), eq(cornerPostReactions.userId, me.id)));
  return (await postViews([post], me.id))[0];
}

let counter: ReturnType<typeof valkeyCounter> | undefined;

/**
 * A reply, one level deep, through the chat pipeline: the per-user chat rate limit (shared with every chat
 * line), the profanity mask, and the client message id (a repeat returns the first). A muted follower's reply
 * is kept and shown back to them only.
 */
let notifications: ReturnType<typeof notifyQueue> | undefined;
const notifyJobs = () => (notifications ??= notifyQueue());

export async function reply(me: User, postId: string, text: string, clientMsgId: string) {
  const post = await livePost(postId);
  await assertMayTakePart(me, post.cornerId);
  const [dup] = await db.select().from(cornerPostReplies).where(and(eq(cornerPostReplies.userId, me.id), eq(cornerPostReplies.clientMsgId, clientMsgId)));
  if (dup) return { reply: await replyView(dup.id), duplicate: true };
  const limited = await chatRateCheck((counter ??= valkeyCounter(valkey())), me.id, await getChatConfig());
  if (limited) throw rateLimited("rate_limited", limited.retryAfter, "chat");
  const muted = await isMuted(post.cornerId, me.id);
  const [row] = await db.insert(cornerPostReplies).values({ postId, userId: me.id, text: maskProfanity(text), clientMsgId, muted })
    .onConflictDoNothing().returning();
  const id = row?.id ?? (await db.select().from(cornerPostReplies).where(and(eq(cornerPostReplies.userId, me.id), eq(cornerPostReplies.clientMsgId, clientMsgId))))[0].id;
  // The host hears about it, and anyone @mentioned (row 9); a muted follower's reply reaches nobody.
  if (row && !muted) await notifyJobs().add("corner_reply", { kind: "corner_reply", postId, replyId: row.id, fromUserId: me.id });
  return { reply: await replyView(id), duplicate: !row };
}

async function replyView(id: string) {
  const [r] = await db.select({ id: cornerPostReplies.id, person: personColumns, text: cornerPostReplies.text, createdAt: cornerPostReplies.createdAt })
    .from(cornerPostReplies).innerJoin(users, eq(users.id, cornerPostReplies.userId)).where(eq(cornerPostReplies.id, id));
  return { ...r, createdAt: r.createdAt.toISOString() };
}

/** The host deletes a reply in their corner. */
export async function deleteReply(me: User, replyId: string) {
  const [r] = await db.select({ r: cornerPostReplies, cornerId: cornerPosts.cornerId }).from(cornerPostReplies).innerJoin(cornerPosts, eq(cornerPosts.id, cornerPostReplies.postId))
    .where(and(eq(cornerPostReplies.id, replyId), isNull(cornerPostReplies.deletedAt)));
  if (!r) throw httpError(404, "not_found");
  await ownedCorner(me, r.cornerId);
  await db.update(cornerPostReplies).set({ deletedAt: new Date(), deletedByUserId: me.id }).where(eq(cornerPostReplies.id, replyId));
  return { deleted: true };
}

/** Anyone who can see a reply can report it: it goes to the moderation queue (one item per reply, every report kept). */
export async function reportReply(me: User, replyId: string, reason: string | undefined) {
  const [r] = await db.select({ r: cornerPostReplies }).from(cornerPostReplies).innerJoin(cornerPosts, eq(cornerPosts.id, cornerPostReplies.postId))
    .innerJoin(corners, eq(corners.id, cornerPosts.cornerId)).where(and(eq(cornerPostReplies.id, replyId), isNull(cornerPostReplies.deletedAt), cornerShown));
  if (!r || (r.r.muted && r.r.userId !== me.id)) throw httpError(404, "not_found");
  const report = { by: me.id, reason: reason ?? null, at: new Date().toISOString() };
  await db.insert(moderationItems).values({ kind: "corner_reply", refId: replyId, userId: r.r.userId, transcript: r.r.text, detail: { reports: [report] } })
    .onConflictDoUpdate({
      target: [moderationItems.kind, moderationItems.refId],
      set: { detail: sql`jsonb_set(coalesce(${moderationItems.detail}, '{}'::jsonb), '{reports}', coalesce(${moderationItems.detail} -> 'reports', '[]'::jsonb) || ${JSON.stringify([report])}::jsonb)` },
    });
  return { reported: true };
}

/** What the viewer may see of a corner's replies: not deleted, and not muted unless they wrote it. */
const visibleReply = (viewerId: string | undefined) =>
  and(isNull(cornerPostReplies.deletedAt), viewerId ? or(eq(cornerPostReplies.muted, false), eq(cornerPostReplies.userId, viewerId)) : eq(cornerPostReplies.muted, false));

/** Posts as the viewer sees them: reaction counts (a muted follower's only for themselves), their reaction, reply count and the newest replies. */
async function postViews(posts: (typeof cornerPosts.$inferSelect)[], viewerId: string | undefined): Promise<CornerPost[]> {
  if (!posts.length) return [];
  const ids = posts.map((p) => p.id);
  const reactionVisible = viewerId ? or(eq(cornerPostReactions.muted, false), eq(cornerPostReactions.userId, viewerId)) : eq(cornerPostReactions.muted, false);
  const [reactions, mine, replyCounts, replies] = await Promise.all([
    db.select({ postId: cornerPostReactions.postId, emoji: cornerPostReactions.emoji, n: count() }).from(cornerPostReactions)
      .where(and(inArray(cornerPostReactions.postId, ids), reactionVisible)).groupBy(cornerPostReactions.postId, cornerPostReactions.emoji),
    viewerId ? db.select().from(cornerPostReactions).where(and(inArray(cornerPostReactions.postId, ids), eq(cornerPostReactions.userId, viewerId))) : [],
    db.select({ postId: cornerPostReplies.postId, n: count() }).from(cornerPostReplies).where(and(inArray(cornerPostReplies.postId, ids), visibleReply(viewerId))).groupBy(cornerPostReplies.postId),
    db.execute(sql`select * from (
        select r.id, r.post_id, r.text, r.created_at, u.id as uid, u.handle, u.display_name, u.avatar_emoji, u.is_verified,
          row_number() over (partition by r.post_id order by r.created_at desc) as n
        from ${cornerPostReplies} r join ${users} u on u.id = r.user_id
        where r.post_id in ${ids} and r.deleted_at is null and (not r.muted ${viewerId ? sql`or r.user_id = ${viewerId}` : sql``})
      ) x where n <= ${POST_REPLIES_INLINE} order by created_at asc`),
  ]);
  type Row = { id: string; post_id: string; text: string; created_at: Date | string; uid: string; handle: string; display_name: string; avatar_emoji: string; is_verified: boolean };
  return posts.map((p) => ({
    id: p.id, cornerId: p.cornerId, text: p.text, createdAt: p.createdAt.toISOString(),
    reactions: reactions.filter((r) => r.postId === p.id).map((r) => ({ emoji: r.emoji as CornerReaction, count: Number(r.n) })),
    mine: ((mine as { postId: string; emoji: string }[]).find((m) => m.postId === p.id)?.emoji ?? null) as CornerReaction | null,
    replyCount: Number(replyCounts.find((r) => r.postId === p.id)?.n ?? 0),
    replies: (replies as unknown as Row[]).filter((r) => r.post_id === p.id).map((r) => ({
      id: r.id, text: r.text, createdAt: new Date(r.created_at).toISOString(),
      person: { id: r.uid, handle: r.handle, displayName: r.display_name, avatarEmoji: r.avatar_emoji, isVerified: r.is_verified },
    })),
  }));
}

/** A corner's posts, newest first, a page at a time (before = a post id). */
export async function postsPage(cornerId: string, viewerId: string | undefined, opts: { before?: string; limit: number }) {
  let cursor: SQL | undefined;
  if (opts.before) {
    const [b] = await db.select({ createdAt: cornerPosts.createdAt, id: cornerPosts.id }).from(cornerPosts).where(and(eq(cornerPosts.id, opts.before), eq(cornerPosts.cornerId, cornerId)));
    if (!b) throw httpError(400, "bad_cursor");
    cursor = or(lt(cornerPosts.createdAt, b.createdAt), and(eq(cornerPosts.createdAt, b.createdAt), lt(cornerPosts.id, b.id)));
  }
  const rows = await db.select().from(cornerPosts).where(and(eq(cornerPosts.cornerId, cornerId), isNull(cornerPosts.deletedAt), cursor))
    .orderBy(desc(cornerPosts.createdAt), desc(cornerPosts.id)).limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit);
  return { posts: await postViews(page, viewerId), before: rows.length > opts.limit ? page.at(-1)!.id : null };
}

/** A post's replies, oldest first within a page, paging back with `before` (a reply id), like chat. */
export async function repliesPage(postId: string, viewerId: string | undefined, opts: { before?: string; limit: number }) {
  await livePost(postId);
  let cursor: SQL | undefined;
  if (opts.before) {
    const [b] = await db.select({ createdAt: cornerPostReplies.createdAt, id: cornerPostReplies.id }).from(cornerPostReplies).where(and(eq(cornerPostReplies.id, opts.before), eq(cornerPostReplies.postId, postId)));
    if (!b) throw httpError(400, "bad_cursor");
    cursor = or(lt(cornerPostReplies.createdAt, b.createdAt), and(eq(cornerPostReplies.createdAt, b.createdAt), lt(cornerPostReplies.id, b.id)));
  }
  const rows = await db.select({ id: cornerPostReplies.id, person: personColumns, text: cornerPostReplies.text, createdAt: cornerPostReplies.createdAt })
    .from(cornerPostReplies).innerJoin(users, eq(users.id, cornerPostReplies.userId))
    .where(and(eq(cornerPostReplies.postId, postId), visibleReply(viewerId), cursor)).orderBy(desc(cornerPostReplies.createdAt), desc(cornerPostReplies.id)).limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit).reverse();
  return { replies: page.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })), before: rows.length > opts.limit ? page[0].id : null };
}

// ---- the corner page -------------------------------------------------------------------

/** Recent winners of the host's public parties: who placed first, newest first. */
async function winners(hostId: string) {
  const rows = await db.select({ id: parties.id, title: parties.title, endedAt: parties.endedAt, startsAt: parties.startsAt, person: personColumns }).from(parties)
    .innerJoin(partyPlayers, and(eq(partyPlayers.partyId, parties.id), eq(partyPlayers.rank, 1))).innerJoin(users, eq(users.id, partyPlayers.userId))
    .where(and(publiclyHostedBy(hostId), eq(parties.status, "finished"), eq(parties.visibility, "public"), liveUser))
    .orderBy(desc(sql`coalesce(${parties.endedAt}, ${parties.startsAt})`)).limit(CORNER_WINNERS_SHOWN);
  return rows.map((r) => ({ party: { id: r.id, title: r.title, endedAt: (r.endedAt ?? r.startsAt).toISOString() }, person: r.person }));
}

/**
 * Regulars: this week's board of party points earned in this host's parties (bragging-rights ones only, ADR
 * 0008), each finish scored with partyPointsFor. Ranked by points, then wins, then name.
 */
async function regulars(hostId: string) {
  const week = weekOf(lagosDay());
  const cfg = await getSocialConfig();
  const finished = await db.select().from(parties).where(and(publiclyHostedBy(hostId), eq(parties.status, "finished"), sql`${parties.endedAt} >= now() - interval '8 days'`));
  const thisWeek = finished.filter((p) => p.endedAt && weekOf(lagosDay(p.endedAt)) === week && isBraggingRights(p));
  if (!thisWeek.length) return { week, rows: [] };
  const seats = await db.select({ partyId: partyPlayers.partyId, rank: partyPlayers.rank, person: personColumns, isGuest: users.isGuest }).from(partyPlayers)
    .innerJoin(users, eq(users.id, partyPlayers.userId)).where(and(inArray(partyPlayers.partyId, thisWeek.map((p) => p.id)), liveUser, isNull(users.bannedAt)));
  const sizeOf = new Map<string, number>();
  for (const s of seats) sizeOf.set(s.partyId, (sizeOf.get(s.partyId) ?? 0) + 1);
  const tally = new Map<string, { person: Person; points: number; parties: number; wins: number }>();
  for (const s of seats) {
    if (s.isGuest || s.rank === null || s.person.id === hostId) continue;
    const t = tally.get(s.person.id) ?? { person: s.person, points: 0, parties: 0, wins: 0 };
    t.points += partyPointsFor(s.rank, sizeOf.get(s.partyId)!, cfg);
    t.parties++;
    if (s.rank === 1) t.wins++;
    tally.set(s.person.id, t);
  }
  const sorted = [...tally.values()].sort((a, b) => b.points - a.points || b.wins - a.wins || a.person.displayName.localeCompare(b.person.displayName));
  let rank = 0;
  const rows = sorted.map((t, i) => {
    if (i === 0 || t.points !== sorted[i - 1].points || t.wins !== sorted[i - 1].wins) rank = i + 1;
    return { rank, ...t };
  });
  return { week, rows: rows.slice(0, CORNER_REGULARS_SHOWN) };
}

export async function cornerPage(cornerId: string, viewer: User | undefined) {
  const { c, owner } = await shownCorner(cornerId);
  const people = await peopleOf(viewer?.id);
  const upcoming = await db.select().from(parties).where(and(publiclyHostedBy(c.ownerUserId), inArray(parties.status, ["open", "live"]), eq(parties.visibility, "public")))
    .orderBy(asc(parties.startsAt)).limit(CORNER_UP_NEXT_SHOWN);
  const [upNext, win, regs, fc, mine, f, posts] = await Promise.all([
    partySummaries(upcoming, viewer?.id), winners(c.ownerUserId), regulars(c.ownerUserId), followerCount(c.id), yourPeopleFollowing(c.id, people),
    followOf(viewer?.id, c.id), postsPage(c.id, viewer?.id, { limit: 10 }),
  ]);
  return {
    corner: { ...cornerRef(c, owner, fc), bio: c.bio, status: c.status, unlockedAt: c.unlockedAt?.toISOString() ?? null },
    viewer: { following: !!f, notify: f?.notify ?? false, isOwner: viewer?.id === c.ownerUserId },
    yourPeopleFollowing: mine, upNext, winners: win, regulars: regs, posts,
  };
}

const myCorner = (c: Corner) => ({ id: c.id, name: c.name, bio: c.bio, lane: c.lane, laneChosen: !!c.laneChosenAt, color: c.color });

/**
 * The owner sets up their corner: name, bio, lane and colour. Picking a lane keeps it; `lane: null` hands it
 * back to the default (what their parties are mostly about).
 */
export async function updateMyCorner(me: User, body: CornerUpdate) {
  return db.transaction(async (tx) => {
    const c = await cornerOf(tx, me.id);
    if (!c || c.status !== "unlocked") throw httpError(409, "corner_not_unlocked");
    const lane = body.lane === undefined ? {} : body.lane === null ? { laneChosenAt: null } : { lane: body.lane, laneChosenAt: new Date() };
    await tx.update(corners).set({
      ...(body.name ? { name: body.name } : {}), ...(body.bio !== undefined ? { bio: body.bio } : {}), ...(body.color ? { color: body.color } : {}), ...lane,
    }).where(eq(corners.id, c.id));
    if (body.lane === null) await refreshDefaultLane(tx, me.id);
    return myCorner((await cornerOf(tx, me.id))!);
  });
}

/** The owner's app showed the unlock celebration: recorded once, so it never shows again (a repeat keeps the first time). */
export async function celebrationSeen(me: User) {
  const c = await cornerOf(db, me.id);
  if (!c || c.status !== "unlocked") throw httpError(409, "corner_not_unlocked");
  const [after] = await db.update(corners).set({ celebrationSeenAt: sql`coalesce(${corners.celebrationSeenAt}, now())` }).where(eq(corners.id, c.id)).returning();
  return { celebrationSeenAt: after.celebrationSeenAt!.toISOString() };
}

// ---- progress --------------------------------------------------------------------------

/** A host's progress toward unlocking: each threshold, the parties hosted (and whether each counted), and their new players. */
export async function progressOf(hostId: string): Promise<CornerProgress> {
  const [corner, cfg, counts, partiesHosted, newPlayers] = await Promise.all([
    cornerOf(db, hostId), currentCornerConfig(), hostCounts(db, hostId),
    db.select({ id: parties.id, title: parties.title, endedAt: cornerParties.finishedAt, realPlayers: cornerParties.realPlayers, counts: cornerParties.counts })
      .from(cornerParties).innerJoin(parties, eq(parties.id, cornerParties.partyId)).where(eq(cornerParties.hostUserId, hostId)).orderBy(desc(cornerParties.finishedAt)),
    db.select({ n: cornerNewPlayers, person: personColumns, bannedAt: users.bannedAt }).from(cornerNewPlayers).innerJoin(users, eq(users.id, cornerNewPlayers.userId))
      .where(and(eq(cornerNewPlayers.hostUserId, hostId), liveUser, ne(cornerNewPlayers.userId, hostId))).orderBy(desc(cornerNewPlayers.createdAt)),
  ]);
  const { thresholds, allMet } = unlockProgress(counts, cfg.config);
  return {
    corner: corner ? {
      id: corner.id, name: corner.name, bio: corner.bio, status: corner.status, level: corner.level,
      unlockedAt: corner.unlockedAt?.toISOString() ?? null, unlockConfigVersion: corner.unlockConfigVersion,
      celebrationSeenAt: corner.celebrationSeenAt?.toISOString() ?? null,
      lane: corner.lane, laneChosen: !!corner.laneChosenAt, color: corner.color,
    } : null,
    config: { ...cfg.config, version: cfg.version },
    thresholds, allMet,
    parties: partiesHosted.map((p) => ({ ...p, endedAt: p.endedAt.toISOString() })),
    newPlayers: newPlayers.map(({ n, person, bannedAt }) => ({
      person, via: n.via, status: n.status, reason: n.reason ?? null, banned: !!bannedAt, at: (n.decidedAt ?? n.createdAt).toISOString(),
    })),
  };
}

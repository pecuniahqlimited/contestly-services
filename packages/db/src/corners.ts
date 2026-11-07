/**
 * Corners (ADR 0012, row 6c): a host's home, unlocked by bringing people to play. This module keeps the
 * unlock read models (corner_parties, corner_party_players, corner_new_players) up to date as parties
 * finish and people sign up, decides unlocks, and raises the alert each unlock owes the admins. The rules
 * themselves (thresholds, the new-player verdict, clusters) are in @contestly/shared.
 */
import { and, asc, count, countDistinct, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import {
  clusteredPlayers, cornerUnlockConfigSchema, mostlyAbout, newPlayerVerdict, partyCountsForCorner, unlockProgress, UNLOCK_CLUSTER_MIN_PLAYERS,
  type CornerCounts, type CornerReach, type CornerUnlockConfig,
} from "@contestly/shared";
import { db, type Tx } from "./client.js";
import { nudge } from "./nudges/record.js";
import {
  cornerConfigs, cornerNewPlayers, cornerParties, cornerPartyPlayers, corners, follows, parties, partyAnswers, partyPlayers, userSignals, users, type Corner, type Party,
} from "./schema.js";
import { publicHostId, publiclyHostedBy } from "./host.js";
import { adminAlert } from "./alerts.js";
import { recordAdminAction } from "./admin.js";

type Conn = Tx | typeof db;
const httpError = (statusCode: number, code: string) => Object.assign(new Error(code), { statusCode });

// ---- config ----------------------------------------------------------------------------

export interface CornerConfigRow { version: number; config: CornerUnlockConfig; createdAt: Date }

/** The current thresholds: the newest version. Version 1 comes from migration 0038, so a missing row is a broken database. */
export async function currentCornerConfig(conn: Conn = db): Promise<CornerConfigRow> {
  const [row] = await conn.select().from(cornerConfigs).orderBy(desc(cornerConfigs.version)).limit(1);
  if (!row) throw new Error("corner_config_missing: no corner unlock config (run db:migrate)");
  return { version: row.version, config: cornerUnlockConfigSchema.parse(row.config), createdAt: row.createdAt };
}

/** Save the next version. Earlier versions stay as they were (each unlock names the one it met). */
export async function saveCornerConfig(tx: Tx, config: unknown, byUserId: string | null): Promise<CornerConfigRow> {
  const parsed = cornerUnlockConfigSchema.parse(config);
  const current = await currentCornerConfig(tx);
  const [row] = await tx.insert(cornerConfigs).values({ version: current.version + 1, config: parsed, createdByUserId: byUserId }).returning();
  return { version: row.version, config: parsed, createdAt: row.createdAt };
}

// ---- the corner row --------------------------------------------------------------------

/**
 * A corner people can see: unlocked, not archived, and its owner neither banned nor deleted. A ban hides the
 * corner and an unban brings it back, because this is read every time rather than written on a ban.
 */
export const cornerShown = and(
  eq(corners.status, "unlocked"), isNull(corners.archivedAt),
  sql`not exists (select 1 from users o where o.id = ${corners.ownerUserId} and (o.banned_at is not null or o.deleted_at is not null))`,
)!;

/** The parties a corner lists and pings for: public ones only (postsToCorner in shared, as a query condition). */
export const onCorner = eq(parties.visibility, "public");

/** The host's shown corner and how far a public party of theirs reaches; null without a shown corner. */
export async function cornerReach(hostId: string, q: Conn = db): Promise<CornerReach | null> {
  const [c] = await q.select({ id: corners.id }).from(corners).where(and(eq(corners.ownerUserId, hostId), cornerShown));
  if (!c) return null;
  const [r] = await q.select({
    all: sql<number>`count(*)::int`,
    pinged: sql<number>`(count(*) filter (where ${follows.notify}))::int`,
  }).from(follows).innerJoin(users, eq(users.id, follows.followerId)).where(and(eq(follows.cornerId, c.id), isNull(users.deletedAt)));
  return { cornerId: c.id, followerCount: Number(r?.all ?? 0), pingCount: Number(r?.pinged ?? 0) };
}

/** The account's corner, made locked (named after them) the first time it's needed. */
export async function ensureCorner(q: Conn, ownerUserId: string): Promise<Corner> {
  const [owner] = await q.select({ displayName: users.displayName, isSim: users.isSim }).from(users).where(eq(users.id, ownerUserId));
  await q.insert(corners).values({ ownerUserId, name: owner.displayName, isSim: owner.isSim }).onConflictDoNothing({ target: corners.ownerUserId });
  const [row] = await q.select().from(corners).where(eq(corners.ownerUserId, ownerUserId));
  return row;
}

export async function cornerOf(q: Conn, ownerUserId: string): Promise<Corner | null> {
  const [row] = await q.select().from(corners).where(eq(corners.ownerUserId, ownerUserId));
  return row ?? null;
}

/** The lane a host's finished parties are mostly about (mostlyAbout in shared), or null. */
export async function defaultLaneOf(q: Conn, hostId: string) {
  const rows = await q.select({ category: parties.category, endedAt: cornerParties.finishedAt }).from(cornerParties)
    .innerJoin(parties, eq(parties.id, cornerParties.partyId)).where(eq(cornerParties.hostUserId, hostId));
  return mostlyAbout(rows);
}

/** Until its owner picks a lane, a corner's lane follows what their parties are mostly about. */
export async function refreshDefaultLane(q: Conn, hostId: string): Promise<void> {
  const c = await cornerOf(q, hostId);
  if (!c || c.laneChosenAt) return;
  const lane = await defaultLaneOf(q, hostId);
  if (lane !== c.lane) await q.update(corners).set({ lane }).where(eq(corners.id, c.id));
}

/**
 * Row 8: a verified brand gets its corner on approval, level 1, with no unlock (ADR 0012 §4). Not called
 * from anywhere yet; brand verification will call it in its approval transaction. A revoked corner stays revoked.
 */
export async function createBrandCorner(tx: Tx, brandUserId: string, now = new Date()): Promise<Corner> {
  const corner = await ensureCorner(tx, brandUserId);
  if (corner.status !== "locked") return corner;
  const [row] = await tx.update(corners).set({ status: "unlocked", level: 1, unlockedAt: now }).where(eq(corners.id, corner.id)).returning();
  return row;
}

// ---- signals ---------------------------------------------------------------------------

/** Loopback addresses say nothing about who someone is (a dev box, a local proxy), so they aren't kept. */
const isLoopback = (ip: string) => ip === "::1" || ip.startsWith("127.") || ip.startsWith("::ffff:127.");

/**
 * Note the install id (a soft signal: the app makes it once per install, and a web build can lose it) and
 * the client IP an account was seen with: written the first time, and its last_seen_at moved on each time after.
 */
export async function recordSignals(userId: string, s: { installId?: string | null; ip?: string | null }) {
  const rows = [
    ...(s.installId ? [{ kind: "install" as const, value: s.installId, userId }] : []),
    ...(s.ip && !isLoopback(s.ip) ? [{ kind: "ip" as const, value: s.ip, userId }] : []),
  ];
  if (rows.length) await db.insert(userSignals).values(rows).onConflictDoUpdate({ target: [userSignals.kind, userSignals.value, userSignals.userId], set: { lastSeenAt: sql`now()` } });
}

// ---- new players -----------------------------------------------------------------------

/** Their seat in a finished party of this host where they answered at least once. */
const playedAFinishedPartyOf = (userId: string, hostId: string) => sql`exists (
  select 1 from ${partyPlayers} pp join ${parties} on ${parties.id} = pp.party_id
  where pp.user_id = ${userId} and ${parties.status} = 'finished' and ${publiclyHostedBy(hostId)}
    and exists (select 1 from ${partyAnswers} a where a.party_id = pp.party_id and a.user_id = ${userId} and a.answer is not null))`;

/** The first finished party they were seated in that they didn't host, oldest first. */
async function firstFinishedParty(q: Conn, userId: string): Promise<Party | null> {
  const [row] = await q.select({ p: parties }).from(partyPlayers).innerJoin(parties, eq(parties.id, partyPlayers.partyId))
    .where(and(eq(partyPlayers.userId, userId), eq(parties.status, "finished"), ne(parties.createdByUserId, userId)))
    .orderBy(asc(sql`coalesce(${parties.endedAt}, ${parties.startsAt})`)).limit(1);
  return row?.p ?? null;
}

async function attribute(q: Conn, userId: string, hostUserId: string, via: "first_party" | "invite", partyId: string) {
  if (hostUserId === userId) return;
  await q.insert(cornerNewPlayers).values({ userId, hostUserId, via, partyId }).onConflictDoNothing();
}

/**
 * At sign-up (becomeMember): if nobody has them yet, they belong to the host of the invite they signed up
 * from, else to the host of the first party they finished as a guest. Then decided, if they can be.
 */
export async function attributeAtSignUp(tx: Tx, userId: string): Promise<void> {
  const [u] = await tx.select({ invitePartyId: users.invitePartyId }).from(users).where(eq(users.id, userId));
  const [invite] = u.invitePartyId ? await tx.select().from(parties).where(eq(parties.id, u.invitePartyId)) : [];
  if (invite) await attribute(tx, userId, publicHostId(invite), "invite", invite.id);
  else {
    const first = await firstFinishedParty(tx, userId);
    if (first) await attribute(tx, userId, publicHostId(first), "first_party", first.id);
  }
  const host = await decideNewPlayer(tx, userId);
  if (host) await checkUnlock(tx, host);
}

/**
 * A pending new player is decided once they've finished one of their host's parties (and answered): they
 * count only with a verified email and an install id no other account has been seen with. Returns the host
 * when this call counted them.
 */
export async function decideNewPlayer(q: Conn, userId: string, now = new Date()): Promise<string | null> {
  const [row] = await q.select().from(cornerNewPlayers).where(and(eq(cornerNewPlayers.userId, userId), eq(cornerNewPlayers.status, "pending")));
  if (!row) return null;
  const [u] = await q.select({ isGuest: users.isGuest, emailVerifiedAt: users.emailVerifiedAt, finished: sql<boolean>`${playedAFinishedPartyOf(userId, row.hostUserId)}` })
    .from(users).where(eq(users.id, userId));
  if (u.isGuest || !u.finished) return null;
  const installs = await q.select({ value: userSignals.value }).from(userSignals).where(and(eq(userSignals.userId, userId), eq(userSignals.kind, "install")));
  const [seen] = installs.length
    ? await q.select({ id: userSignals.userId }).from(userSignals).innerJoin(users, eq(users.id, userSignals.userId))
      .where(and(eq(userSignals.kind, "install"), inArray(userSignals.value, installs.map((i) => i.value)), ne(userSignals.userId, userId), eq(users.isGuest, false))).limit(1)
    : [];
  const verdict = newPlayerVerdict({ emailVerified: !!u.emailVerifiedAt, hasInstallId: installs.length > 0, installSeenOnAnotherAccount: !!seen });
  await q.update(cornerNewPlayers).set({ status: verdict.counts ? "counted" : "excluded", reason: verdict.counts ? null : verdict.reason, decidedAt: now })
    .where(eq(cornerNewPlayers.userId, userId));
  return verdict.counts ? row.hostUserId : null;
}

// ---- after a party finishes ------------------------------------------------------------

export interface CornerSeat { userId: string; isGuest: boolean; bannedAt: Date | null }

/**
 * A party finished (in record_progress's transaction after settlement, partyProgress.ts): record it for its host's
 * progress with its real players (signed in, answered at least once, not the host, not banned), attribute and
 * decide any new players among them, and unlock whichever corners that completes. Idempotent on the party.
 */
export async function recordCornerProgress(tx: Tx, party: Party, seats: CornerSeat[], finishedAt = new Date()): Promise<void> {
  const hostId = publicHostId(party);
  const { config } = await currentCornerConfig(tx);
  const answered = new Set((await tx.selectDistinct({ userId: partyAnswers.userId }).from(partyAnswers)
    .where(and(eq(partyAnswers.partyId, party.id), isNotNull(partyAnswers.answer)))).map((r) => r.userId));
  const real = seats.filter((s) => !s.isGuest && !s.bannedAt && s.userId !== hostId && answered.has(s.userId)).map((s) => s.userId);
  const counts = partyCountsForCorner(real.length, config);
  const [recorded] = await tx.insert(cornerParties).values({ partyId: party.id, hostUserId: hostId, realPlayers: real.length, counts, finishedAt })
    .onConflictDoNothing().returning();
  if (!recorded) return;
  if (counts && real.length) await tx.insert(cornerPartyPlayers).values(real.map((userId) => ({ partyId: party.id, userId, hostUserId: hostId }))).onConflictDoNothing();
  await ensureCorner(tx, hostId);
  await refreshDefaultLane(tx, hostId);

  const hosts = new Set([hostId]);
  // Only players nobody has yet, or still pending, have anything to decide (one query for the rest).
  const known = new Map(real.length
    ? (await tx.select({ userId: cornerNewPlayers.userId, status: cornerNewPlayers.status }).from(cornerNewPlayers).where(inArray(cornerNewPlayers.userId, real))).map((r) => [r.userId, r.status])
    : []);
  for (const userId of real) {
    const status = known.get(userId);
    if (status && status !== "pending") continue;
    if (!status) {
      const first = await firstFinishedParty(tx, userId);
      if (first) await attribute(tx, userId, publicHostId(first), "first_party", first.id);
    }
    const host = await decideNewPlayer(tx, userId);
    if (host) hosts.add(host);
  }
  for (const h of hosts) await checkUnlock(tx, h);
}

// ---- counting and unlocking ------------------------------------------------------------

/** In good standing: not banned, not deleted. Banned players leave D and N (and come back on unban). */
const inGoodStanding = and(isNull(users.bannedAt), isNull(users.deletedAt));

/** P, D and N for a host, as of now. */
export async function hostCounts(q: Conn, hostId: string): Promise<CornerCounts> {
  const [[p], [d], [n]] = await Promise.all([
    q.select({ n: count() }).from(cornerParties).where(and(eq(cornerParties.hostUserId, hostId), eq(cornerParties.counts, true))),
    q.select({ n: countDistinct(cornerPartyPlayers.userId) }).from(cornerPartyPlayers).innerJoin(users, eq(users.id, cornerPartyPlayers.userId))
      .where(and(eq(cornerPartyPlayers.hostUserId, hostId), inGoodStanding)),
    q.select({ n: count() }).from(cornerNewPlayers).innerJoin(users, eq(users.id, cornerNewPlayers.userId))
      .where(and(eq(cornerNewPlayers.hostUserId, hostId), eq(cornerNewPlayers.status, "counted"), inGoodStanding)),
  ]);
  return { partiesHosted: Number(p.n), distinctPlayers: Number(d.n), newPlayers: Number(n.n) };
}

/** The new players counting for a host right now (who would make up N). */
async function countedNewPlayers(q: Conn, hostId: string) {
  return q.select({ id: users.id, handle: users.handle }).from(cornerNewPlayers).innerJoin(users, eq(users.id, cornerNewPlayers.userId))
    .where(and(eq(cornerNewPlayers.hostUserId, hostId), eq(cornerNewPlayers.status, "counted"), inGoodStanding)).orderBy(asc(cornerNewPlayers.decidedAt));
}

/**
 * Unlock the host's corner the moment all four thresholds are met (a locked one only: a revoked corner stays
 * revoked). Records who made up N, and raises an info alert, or a warning when several of them share an IP or
 * install id with each other or the host. Returns whether it unlocked.
 */
export async function checkUnlock(tx: Tx, hostId: string, now = new Date()): Promise<boolean> {
  const ensured = await ensureCorner(tx, hostId);
  const [corner] = await tx.select().from(corners).where(eq(corners.id, ensured.id)).for("update");
  if (corner.status !== "locked" || corner.archivedAt) return false;
  const [cfg, counts] = await Promise.all([currentCornerConfig(tx), hostCounts(tx, hostId)]);
  if (!unlockProgress(counts, cfg.config).allMet) return false;

  const contributors = await countedNewPlayers(tx, hostId);
  await tx.update(corners).set({ status: "unlocked", level: 1, unlockedAt: now, unlockConfigVersion: cfg.version, unlockContributors: contributors.map((c) => c.id) })
    .where(eq(corners.id, corner.id));
  // "Your corner is open": a push only (in the app, the celebration says it).
  await nudge(tx, { userId: hostId, kind: "corner_open", data: { cornerId: corner.id }, ref: { type: "corner", id: corner.id }, dedupeKey: `corner_open:${corner.id}` }, now);

  const [host] = await tx.select({ handle: users.handle }).from(users).where(eq(users.id, hostId));
  const ids = contributors.map((c) => c.id);
  const signals = await tx.select({ userId: userSignals.userId, kind: userSignals.kind, value: userSignals.value }).from(userSignals)
    .where(inArray(userSignals.userId, [...ids, hostId]));
  const clustered = clusteredPlayers(ids, hostId, signals);
  const warn = clustered.length >= UNLOCK_CLUSTER_MIN_PLAYERS;
  const handleOf = new Map(contributors.map((c) => [c.id, c.handle]));
  await adminAlert({
    kind: warn ? "corner.unlock_cluster" : "corner.unlocked",
    severity: warn ? "warning" : "info",
    subject: warn
      ? `@${host.handle}'s corner unlocked; ${clustered.length} of its new players share an IP or device`
      : `@${host.handle}'s corner unlocked`,
    details: { hostId, host: host.handle, cornerId: corner.id, configVersion: cfg.version, counts, newPlayers: contributors, clustered: clustered.map((id) => ({ id, handle: handleOf.get(id) })) },
    dedupeKey: `corner_unlock:${corner.id}`, refType: "corner", refId: corner.id,
  }, tx);
  return true;
}

/**
 * After a ban or unban: an unban can complete a host's thresholds (unlock now); a ban can take an unlocked
 * corner below them, which an admin should look at (a warning; corners aren't taken away automatically).
 */
export async function cornersAfterStandingChange(userId: string): Promise<void> {
  const hosts = await db.selectDistinct({ hostId: cornerNewPlayers.hostUserId }).from(cornerNewPlayers).where(and(eq(cornerNewPlayers.userId, userId), eq(cornerNewPlayers.status, "counted")))
    .union(db.selectDistinct({ hostId: cornerPartyPlayers.hostUserId }).from(cornerPartyPlayers).where(eq(cornerPartyPlayers.userId, userId)));
  for (const { hostId } of hosts) {
    await db.transaction(async (tx) => {
      if (await checkUnlock(tx, hostId)) return;
      const corner = await cornerOf(tx, hostId);
      if (corner?.status !== "unlocked" || !corner.unlockConfigVersion) return;
      const [cfg, counts] = await Promise.all([currentCornerConfig(tx), hostCounts(tx, hostId)]);
      if (unlockProgress(counts, cfg.config).allMet) return;
      await adminAlert({
        kind: "corner.below_threshold", severity: "warning",
        subject: `A corner is below its unlock thresholds after a ban`,
        details: { hostId, cornerId: corner.id, counts, config: cfg.config, bannedUserId: userId },
        dedupeKey: `corner_below:${corner.id}`, refType: "corner", refId: corner.id,
      }, tx);
    });
  }
}

/**
 * An admin grants a corner (ADR 0012 §4): unlocked at level 1 for a signed-up, unbanned account whatever its
 * progress, made if there isn't one (named after them, lane from their parties, the default colour). It's
 * marked granted (admin views only), logged with the reason, and raises an info alert like an earned unlock;
 * the host gets the celebration and "Your corner is open". Progress keeps being tracked. A revoked corner is
 * restored, not granted (409 corner_revoked); an unlocked one is 409 corner_already_unlocked.
 */
export async function grantCorner(adminUserId: string, userId: string, reason: string, now = new Date()): Promise<Corner> {
  return db.transaction(async (tx) => {
    const [u] = await tx.select().from(users).where(eq(users.id, userId));
    if (!u || u.deletedAt || u.isSystem) throw httpError(404, "not_found");
    if (u.isGuest) throw httpError(409, "guest_account");
    if (u.bannedAt) throw httpError(409, "account_banned");
    const made = await ensureCorner(tx, userId);
    const [c] = await tx.select().from(corners).where(eq(corners.id, made.id)).for("update");
    if (c.status === "unlocked") throw httpError(409, "corner_already_unlocked");
    if (c.status === "revoked") throw Object.assign(httpError(409, "corner_revoked"), { details: { message: "This corner was revoked: restore it instead (POST /admin/corners/:id/restore)." } });
    if (c.archivedAt) throw httpError(409, "corner_archived");
    await refreshDefaultLane(tx, userId);
    const [after] = await tx.update(corners).set({
      status: "unlocked", level: 1, unlockedAt: now, celebrationSeenAt: null, grantedByUserId: adminUserId, grantedAt: now, grantedReason: reason,
    }).where(eq(corners.id, c.id)).returning();
    await recordAdminAction(tx, { adminUserId, action: "corner.grant", targetType: "corner", targetId: c.id, reason, before: { status: c.status }, after: { status: after.status, ownerUserId: userId } });
    await adminAlert({
      kind: "corner.granted", severity: "info", subject: `@${u.handle}'s corner was granted by an admin`,
      details: { hostId: userId, cornerId: c.id, grantedBy: adminUserId, reason }, dedupeKey: `corner_granted:${c.id}`, refType: "corner", refId: c.id,
    }, tx);
    await nudge(tx, { userId, kind: "corner_open", data: { cornerId: c.id }, ref: { type: "corner", id: c.id }, dedupeKey: `corner_open:${c.id}` }, now);
    return after;
  });
}

/**
 * An admin revokes an unlocked corner (a farmed unlock), with a reason, logged. It's hidden from then on; its
 * follows, posts, reactions and replies are kept untouched, so a restore brings everything back.
 */
export async function revokeCorner(adminUserId: string, cornerId: string, reason: string, now = new Date()): Promise<Corner> {
  return db.transaction(async (tx) => {
    const [c] = await tx.select().from(corners).where(eq(corners.id, cornerId)).for("update");
    if (!c) throw httpError(404, "not_found");
    if (c.status !== "unlocked") throw httpError(409, "corner_not_unlocked");
    const [after] = await tx.update(corners).set({ status: "revoked", revokedByUserId: adminUserId, revokedAt: now, revokedReason: reason }).where(eq(corners.id, cornerId)).returning();
    await recordAdminAction(tx, { adminUserId, action: "corner.revoke", targetType: "corner", targetId: cornerId, reason, before: { status: c.status }, after: { status: after.status } });
    return after;
  });
}

/**
 * An admin undoes a revoke, with a reason, logged (the revoke's who, when and why go into the log's `before`).
 * The corner is unlocked again at the level it had, with its follows and posts as they were; its unlock
 * record (config version, who made up N) is unchanged.
 */
export async function restoreCorner(adminUserId: string, cornerId: string, reason: string): Promise<Corner> {
  return db.transaction(async (tx) => {
    const [c] = await tx.select().from(corners).where(eq(corners.id, cornerId)).for("update");
    if (!c) throw httpError(404, "not_found");
    if (c.status !== "revoked") throw httpError(409, "corner_not_revoked");
    const [after] = await tx.update(corners).set({ status: "unlocked", revokedByUserId: null, revokedAt: null, revokedReason: null }).where(eq(corners.id, cornerId)).returning();
    await recordAdminAction(tx, {
      adminUserId, action: "corner.restore", targetType: "corner", targetId: cornerId, reason,
      before: { status: c.status, revokedByUserId: c.revokedByUserId, revokedAt: c.revokedAt?.toISOString(), revokedReason: c.revokedReason },
      after: { status: after.status },
    });
    return after;
  });
}

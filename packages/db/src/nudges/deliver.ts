/**
 * Delivering due nudges (the worker's tick). The rules are the same for every kind, in this order:
 *  1. the account is gone or banned → skipped (unavailable); its category is off → skipped (toggle_off);
 *  2. the kind's own check (checks.ts): no longer true → withdrawn (a cancelled party) or skipped (not_needed);
 *     due too long ago → skipped (stale); the kind's cap for the person's day → skipped (kind_cap);
 *  3. the app is open (their inbox room is up) → a banner instead of the push (a push-only kind: skipped, in_app);
 *  4. a push: quiet hours where they are, then the daily push cap (live-party events are outside both),
 *     then their devices with push allowed (none → no_device). FCM's "not registered" clears that token.
 * Every outcome is written on the record: what the recommendation service will tune from.
 */
import { and, count, eq, gte, inArray, isNotNull, lt, ne, notInArray, sql } from "drizzle-orm";
import {
  NUDGE_KINDS, inQuietHours, startOfLocalDay, type NudgeConfig, type NudgeKind, type NudgeKindDef, type NudgeMessage, type NudgeSkipReason,
} from "@contestly/shared";
import { db } from "../client.js";
import { getNudgeConfig } from "../config.js";
import { deviceTokens, nudges, users, type NudgeRow, type User } from "../schema.js";
import { nudgeChecks, type CheckDeps } from "./checks.js";

/** One push to one device, vendor-neutral. `data` rides along for the app (all strings, as FCM wants). */
export type PushMessage = {
  token: string;
  platform: "ios" | "android" | "web";
  title: string;
  body: string;
  data: { nudgeId: string; kind: string; deepLink: string; reason: string };
};
export type PushResult = { ok: true } | { ok: false; invalidToken: boolean; error: string };
/** The push provider (apps/worker/src/push: log for dev and tests, fcm for real). */
export interface PushSender {
  readonly name: string;
  send(message: PushMessage): Promise<PushResult>;
}

export interface DeliveryDeps extends CheckDeps {
  push: PushSender;
  /** The app is open: the user's inbox room is up. */
  connected(userId: string): Promise<boolean>;
  /** Show the banner; true when an open app received it. */
  banner(userId: string, message: NudgeMessage): Promise<boolean>;
  now?: () => Date;
}

export type Delivered = { id: string; kind: NudgeKind; userId: string; status: "sent" | "skipped" | "withdrawn"; channel?: "push" | "banner"; skipReason?: NudgeSkipReason; pushes?: number };

/** Live-party events don't count towards the daily push cap. */
const LIVE_PARTY_KINDS = (Object.keys(NUDGE_KINDS) as NudgeKind[]).filter((k) => NUDGE_KINDS[k].livePartyEvent);
/** A claimed row this long past due was abandoned by a worker that died mid-tick. */
const ABANDONED_MS = 10 * 60_000;
export const NUDGES_PER_TICK = 200;

export async function deliverDueNudges(deps: DeliveryDeps, limit = NUDGES_PER_TICK): Promise<Delivered[]> {
  const now = deps.now?.() ?? new Date();
  await db.update(nudges).set({ status: "skipped", skipReason: "stale", decidedAt: now })
    .where(and(eq(nudges.status, "sending"), lt(nudges.dueAt, new Date(now.getTime() - ABANDONED_MS))));
  // Claim what's due, so two workers never deliver the same row.
  const claimed = await db.update(nudges).set({ status: "sending" })
    .where(sql`${nudges.id} in (select id from ${nudges} where status = 'pending' and due_at <= ${now.toISOString()}::timestamptz order by due_at limit ${limit} for update skip locked)`)
    .returning();
  if (!claimed.length) return [];
  const cfg = await getNudgeConfig();
  const out: Delivered[] = [];
  for (const row of claimed.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())) out.push(await deliverOne(deps, cfg, row, now));
  return out;
}

async function deliverOne(deps: DeliveryDeps, cfg: NudgeConfig, row: NudgeRow, now: Date): Promise<Delivered> {
  const def = NUDGE_KINDS[row.kind] as NudgeKindDef<NudgeKind>;
  const [user] = await db.select().from(users).where(eq(users.id, row.userId));
  const outcome = await decide(deps, cfg, def, row, user, now);
  await db.update(nudges).set({
    status: outcome.status, decidedAt: now, channel: outcome.channel ?? null, skipReason: outcome.skipReason ?? null, pushes: outcome.pushes ?? 0,
  }).where(eq(nudges.id, row.id));
  return { id: row.id, kind: row.kind, userId: row.userId, ...outcome };
}

type Outcome = Omit<Delivered, "id" | "kind" | "userId">;
const skip = (skipReason: NudgeSkipReason): Outcome => ({ status: "skipped", skipReason });

async function decide(deps: DeliveryDeps, cfg: NudgeConfig, def: NudgeKindDef<NudgeKind>, row: NudgeRow, user: User | undefined, now: Date): Promise<Outcome> {
  if (!user || user.deletedAt || user.bannedAt) return skip("unavailable");
  if (user.nudgesOff.includes(row.category)) return skip("toggle_off");
  const verdict = await nudgeChecks[row.kind]?.(row, deps);
  if (verdict === "withdraw") return { status: "withdrawn" };
  if (verdict) return skip(verdict);
  if (def.staleAfterSeconds && now.getTime() - row.dueAt.getTime() > def.staleAfterSeconds * 1000) return skip("stale");
  const dayStart = startOfLocalDay(now, user.timeZone);
  if (def.perDay && (await sentToday(row, def, dayStart)) >= capOf(def, cfg)) return skip("kind_cap");

  if (await deps.connected(row.userId)) {
    if (def.pushOnly) return skip("in_app");
    if (await deps.banner(row.userId, bannerOf(row))) return { status: "sent", channel: "banner" };
    // The room went away between the two: fall through to a push.
  }
  if (!def.livePartyEvent && inQuietHours(now, user.timeZone, cfg.quietHours)) return skip("quiet_hours");
  if (!def.livePartyEvent && (await pushesToday(row.userId, dayStart)) >= cfg.dailyPushCap) return skip("daily_cap");
  return push(deps, row);
}

const capOf = (def: NudgeKindDef<NudgeKind>, cfg: NudgeConfig) => (typeof def.perDay!.max === "number" ? def.perDay!.max : (cfg[def.perDay!.max] as number));

/** This kind (per thing, for a per-ref cap) sent to them since their day began, either channel. */
async function sentToday(row: NudgeRow, def: NudgeKindDef<NudgeKind>, dayStart: Date): Promise<number> {
  const [r] = await db.select({ n: count() }).from(nudges).where(and(
    eq(nudges.userId, row.userId), eq(nudges.kind, row.kind), eq(nudges.status, "sent"), gte(nudges.decidedAt, dayStart),
    def.perDay!.per === "ref" && row.refId ? eq(nudges.refId, row.refId) : undefined,
  ));
  return Number(r.n);
}

/** Pushes sent to them since their day began, live-party events left out. */
async function pushesToday(userId: string, dayStart: Date): Promise<number> {
  const [r] = await db.select({ n: count() }).from(nudges).where(and(
    eq(nudges.userId, userId), eq(nudges.status, "sent"), eq(nudges.channel, "push"), gte(nudges.decidedAt, dayStart),
    LIVE_PARTY_KINDS.length ? notInArray(nudges.kind, LIVE_PARTY_KINDS) : undefined,
  ));
  return Number(r.n);
}

const bannerOf = (row: NudgeRow): NudgeMessage => ({
  id: row.id, kind: row.kind, category: row.category, title: row.title, body: row.body, deepLink: row.deepLink, reason: row.reason, createdAt: row.createdAt.toISOString(),
});

async function push(deps: DeliveryDeps, row: NudgeRow): Promise<Outcome> {
  const devices = await db.select().from(deviceTokens)
    .where(and(eq(deviceTokens.userId, row.userId), eq(deviceTokens.permission, "granted"), isNotNull(deviceTokens.token)));
  if (!devices.length) return skip("no_device");
  let sent = 0;
  const invalid: string[] = [];
  for (const d of devices) {
    const res = await deps.push.send({
      token: d.token!, platform: d.platform, title: row.title, body: row.body,
      data: { nudgeId: row.id, kind: row.kind, deepLink: row.deepLink, reason: row.reason },
    });
    if (res.ok) sent++;
    else if (res.invalidToken) invalid.push(d.id);
  }
  if (invalid.length) await db.update(deviceTokens).set({ token: null }).where(inArray(deviceTokens.id, invalid));
  if (sent) return { status: "sent", channel: "push", pushes: sent };
  return skip(invalid.length === devices.length ? "no_device" : "push_failed");
}

/** The app reports a nudge opened (tapped) or dismissed. The first report of each sticks. Null when it isn't theirs. */
export async function reportNudge(userId: string, id: string, what: "opened" | "dismissed", now = new Date()) {
  const column = what === "opened" ? nudges.openedAt : nudges.dismissedAt;
  await db.update(nudges).set(what === "opened" ? { openedAt: now } : { dismissedAt: now })
    .where(and(eq(nudges.id, id), eq(nudges.userId, userId), sql`${column} is null`, ne(nudges.status, "pending")));
  const [row] = await db.select({ id: nudges.id, openedAt: nudges.openedAt, dismissedAt: nudges.dismissedAt }).from(nudges)
    .where(and(eq(nudges.id, id), eq(nudges.userId, userId)));
  return row ? { id: row.id, openedAt: row.openedAt?.toISOString() ?? null, dismissedAt: row.dismissedAt?.toISOString() ?? null } : null;
}

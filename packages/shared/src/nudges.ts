/**
 * Nudges (row 9): every push and in-app banner the worker sends. Each kind is one entry in NUDGE_KINDS: its
 * category (the toggle that silences it), whether it's a live-party event (outside the daily push cap; inside
 * quiet hours), its own cap, how it batches, and its copy. The engine (packages/db/src/nudges) applies the rules
 * the same way to every kind; adding a kind is an entry here and an emitter there.
 *
 * Copy never mentions money: every rendering goes through assertNoMoney().
 */
import { z } from "zod";
import { CLIMB_TIME_ZONE } from "./climb.js";
import { personSchema } from "./person.js";

// ---- categories and toggles ------------------------------------------------------------

/** What a person can turn off in Me, one toggle each, all on by default. */
export const NUDGE_CATEGORIES = ["parties", "corners", "people", "mentions", "climb", "account"] as const;
export type NudgeCategory = (typeof NUDGE_CATEGORIES)[number];
export const nudgeTogglesSchema = z.object(Object.fromEntries(NUDGE_CATEGORIES.map((c) => [c, z.boolean()])) as Record<NudgeCategory, z.ZodBoolean>);
export type NudgeToggles = z.infer<typeof nudgeTogglesSchema>;
/** Stored as the categories turned off; this is what Me shows. */
export const togglesFromOff = (off: readonly string[]): NudgeToggles =>
  Object.fromEntries(NUDGE_CATEGORIES.map((c) => [c, !off.includes(c)])) as NudgeToggles;

// ---- time zones and quiet hours --------------------------------------------------------

/** Everyone's zone until the app sends theirs. */
export const DEFAULT_TIME_ZONE = CLIMB_TIME_ZONE;
export const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false; // not an IANA zone this runtime knows
  }
};
/** An IANA zone (e.g. "Africa/Lagos", "Europe/London"), as the app reads it from the device. */
export const timeZoneSchema = z.string().min(1).max(64).refine(isTimeZone, { message: "an IANA time zone" });

/** The wall clock in a zone: hour 0–23 and the local date (YYYY-MM-DD). */
export function localClock(at: Date, tz: string): { day: string; hour: number; minute: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(at).map((p) => [p.type, p.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) };
}

/** The instant the local day containing `at` began in `tz` (what "a day" means for caps). */
export function startOfLocalDay(at: Date, tz: string): Date {
  const { hour, minute } = localClock(at, tz);
  const s = at.getUTCSeconds() * 1000 + at.getUTCMilliseconds();
  return new Date(at.getTime() - (hour * 60 + minute) * 60_000 - s);
}

/** Quiet hours wrap midnight (23:00–07:00 by default): from `startHour` until `endHour` the next morning. */
export function inQuietHours(at: Date, tz: string, q: { startHour: number; endHour: number }): boolean {
  const { hour } = localClock(at, tz);
  return q.startHour > q.endHour ? hour >= q.startHour || hour < q.endHour : hour >= q.startHour && hour < q.endHour;
}

// ---- the no-money guard ----------------------------------------------------------------

/**
 * A nudge never leads with money (the Home rule, and a store-review one): no currency, no amounts, no money
 * words. Counts ("Ada and 2 others", "starts in 5") are fine. Copy can carry what people typed (a party's
 * title); a nudge whose copy fails is recorded as skipped ("money"), never sent.
 */
const MONEY = [
  /[₦$£€]/,
  /\b(ngn|usd|naira|kobo)\b/i,
  /\b(cash|money|refund(ed|s)?|payout|withdraw(al)?|jackpot)\b/i,
  /\b\d{1,3}(,\d{3})+\b/, // 10,000
  /\b\d+(\.\d+)?\s?[km]\b/i, // 50k, 1.5m
];
export const mentionsMoney = (text: string) => MONEY.some((re) => re.test(text));
export class MoneyInNudge extends Error {
  constructor(public readonly text: string) {
    super(`nudge copy mentions money: "${text}"`);
  }
}
export function assertNoMoney(c: Pick<NudgeContent, "title" | "body" | "reason">): void {
  for (const text of [c.title, c.body, c.reason]) if (mentionsMoney(text)) throw new MoneyInNudge(text);
}

// ---- content ---------------------------------------------------------------------------

/** What every nudge carries, the same in the push and the banner. `reason` is the short "why you got this". */
export const nudgeContentSchema = z.object({ title: z.string(), body: z.string(), deepLink: z.string(), reason: z.string() });
export type NudgeContent = z.infer<typeof nudgeContentSchema>;

/** Someone a batched nudge is about ("Ada and 2 others"). */
export type NudgeActor = { id: string; name: string };
/** "Ada", "Ada and Kemi", "Ada and 2 others". */
export function actorsLine(actors: readonly NudgeActor[]): string {
  const [first, second] = actors;
  if (!first) return "Someone";
  if (actors.length === 1) return first.name;
  if (actors.length === 2) return `${first.name} and ${second.name}`;
  return `${first.name} and ${actors.length - 1} others`;
}

/**
 * A thread a nudge opens, by what the app looks it up by: a DM by the other person's handle, a crew by its id, a
 * party's chat by the party's id, a corner post's replies by the post's id (GET /corner-posts/:id/replies).
 */
export const NUDGE_THREAD_KINDS = ["dm", "crew", "party", "corner_post"] as const;
export const nudgeThreadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("dm"), handle: z.string().min(1) }),
  z.object({ kind: z.literal("crew"), crewId: z.string().uuid() }),
  z.object({ kind: z.literal("party"), partyId: z.string().uuid() }),
  z.object({ kind: z.literal("corner_post"), postId: z.string().uuid() }),
]);
export type NudgeThread = z.infer<typeof nudgeThreadSchema>;
const threadRef = (t: NudgeThread) =>
  t.kind === "dm" ? t.handle : t.kind === "crew" ? t.crewId : t.kind === "party" ? t.partyId : t.postId;
const THREAD_LINK = /^contestly:\/\/chats\/(dm|crew|party|corner_post)\/([^/?#]+)$/;

/** A thread deep link back into its kind and reference (null if it isn't one): the one parser, for the app. */
export function parseThreadLink(link: string): NudgeThread | null {
  const m = THREAD_LINK.exec(link);
  if (!m) return null;
  const ref = decodeURIComponent(m[2]);
  const t = m[1] === "dm" ? { kind: "dm", handle: ref } : m[1] === "crew" ? { kind: "crew", crewId: ref } : m[1] === "party" ? { kind: "party", partyId: ref } : { kind: "corner_post", postId: ref };
  const parsed = nudgeThreadSchema.safeParse(t);
  return parsed.success ? parsed.data : null;
}

/** Deep links (the app's scheme). */
export const DEEP_LINKS = {
  party: (id: string) => `contestly://party/${id}`,
  partyRoom: (id: string) => `contestly://party/${id}/room`,
  /** contestly://chats/<kind>/<reference>, e.g. contestly://chats/dm/kemz; parseThreadLink() reads it back. */
  thread: (t: NudgeThread) => `contestly://chats/${t.kind}/${encodeURIComponent(threadRef(t))}`,
  corner: (id: string) => `contestly://corner/${id}`,
  profile: (handle: string) => `contestly://u/${handle}`,
  climb: () => "contestly://climb",
  home: () => "contestly://home",
  signUp: () => "contestly://sign-up",
} as const;

// ---- the kinds ------------------------------------------------------------------------

/** Each kind's data, as the emitter records it; the copy is rendered from it (and from the batch's actors). */
export type NudgeData = {
  party_starting: { partyId: string; title: string; minutes: 5 | 1 };
  party_live: { partyId: string; title: string };
  people_joined: { partyId: string; title: string };
  party_filling: { partyId: string; title: string; lane: string };
  corner_party: { partyId: string; title: string; cornerId: string; cornerName: string };
  mention: { thread: NudgeThread; where: string };
  corner_reply: { cornerId: string; postId: string };
  corner_follow_ask: { cornerId: string; cornerName: string; hostName: string };
  corner_open: { cornerId: string };
  rival: { by: "head_to_head"; rivalHandle: string; rivalName: string; them: number; you: number } | { by: "climb"; rivalHandle: string; rivalName: string; stage: number };
  streak_risk: { days: number };
  host_cancelled: { partyId: string; title: string; entryBack: boolean };
  guest_follow_up: { partyId: string; title: string };
  win_back: { personName: string; personHandle: string; what: string };
};
export type NudgeKind = keyof NudgeData;

export interface NudgeKindDef<K extends NudgeKind> {
  category: NudgeCategory;
  /** A party the person joined or hosts, about to start or running: outside the daily push cap and quiet hours. */
  livePartyEvent?: boolean;
  /** Only worth a push: when the app is open something else already shows it (the unlock celebration), so no banner. */
  pushOnly?: boolean;
  /** At most this many sent a local day; `per: "ref"` counts per thing (a corner), else per kind. A config key, or a number. */
  perDay?: { max: number | keyof NudgeConfig; per?: "ref" };
  /** Batched: nudges with the same batch key wait so that at most one goes out every this many seconds, merged. */
  batchGap?: keyof NudgeConfig;
  /** Past this many seconds after it was due, it's no longer true ("starts in 5"): skipped as stale. */
  staleAfterSeconds?: number;
  render(data: NudgeData[K], actors: readonly NudgeActor[]): NudgeContent;
}

const kinds: { [K in NudgeKind]: NudgeKindDef<K> } = {
  party_starting: {
    category: "parties", livePartyEvent: true, staleAfterSeconds: 90,
    render: (d) => ({
      title: d.minutes === 5 ? `${d.title} starts in 5 minutes` : `${d.title} starts in a minute`,
      body: d.minutes === 5 ? "Get ready. The room opens soon." : "Everyone's gathering. Jump in now.",
      deepLink: DEEP_LINKS.partyRoom(d.partyId), reason: "You're in this party",
    }),
  },
  party_live: {
    category: "parties", livePartyEvent: true, staleAfterSeconds: 300,
    render: (d) => ({ title: `${d.title} is live`, body: "The first question is up. Join the round.", deepLink: DEEP_LINKS.partyRoom(d.partyId), reason: "You're in this party" }),
  },
  people_joined: {
    category: "people", batchGap: "peopleJoinedGapSeconds",
    render: (d, actors) => ({ title: `${actorsLine(actors)} joined ${d.title}`, body: "Your people are in. See who else is coming.", deepLink: DEEP_LINKS.party(d.partyId), reason: "Your people joined your party" }),
  },
  party_filling: {
    category: "parties", perDay: { max: 1 },
    render: (d) => ({ title: `${d.title} is filling up`, body: "It starts in a few minutes and seats are going.", deepLink: DEEP_LINKS.party(d.partyId), reason: `${d.lane}, your lane` }),
  },
  corner_party: {
    category: "corners", perDay: { max: "cornerPartyAlertsPerDay", per: "ref" },
    render: (d) => ({ title: `New party in ${d.cornerName}`, body: d.title, deepLink: DEEP_LINKS.party(d.partyId), reason: `You follow ${d.cornerName}` }),
  },
  mention: {
    category: "mentions", batchGap: "mentionBatchSeconds",
    render: (d, actors) => ({ title: `${actorsLine(actors)} mentioned you`, body: `In ${d.where}`, deepLink: DEEP_LINKS.thread(d.thread), reason: "You were mentioned" }),
  },
  corner_reply: {
    category: "corners", batchGap: "replyBatchSeconds",
    render: (d, actors) => ({ title: `${actorsLine(actors)} replied to your post`, body: "See what they said.", deepLink: DEEP_LINKS.thread({ kind: "corner_post", postId: d.postId }), reason: "Replies to your corner post" }),
  },
  corner_follow_ask: {
    category: "corners",
    render: (d) => ({ title: `${d.hostName} asked you to follow ${d.cornerName}`, body: "Follow to hear when they open a party.", deepLink: DEEP_LINKS.corner(d.cornerId), reason: "You've played in their parties" }),
  },
  corner_open: {
    category: "account", pushOnly: true,
    render: (d) => ({ title: "Your corner is open", body: "People can follow you now. Set it up and say hello.", deepLink: DEEP_LINKS.corner(d.cornerId), reason: "You unlocked your corner" }),
  },
  rival: {
    category: "people", perDay: { max: 1 },
    render: (d) => d.by === "head_to_head"
      ? { title: `${d.rivalName} took the lead on you`, body: `Head to head: ${d.them}–${d.you}. Time for a rematch?`, deepLink: DEEP_LINKS.profile(d.rivalHandle), reason: "Your rival" }
      : { title: `${d.rivalName} climbed past your best`, body: `They reached stage ${d.stage}. Can you beat it?`, deepLink: DEEP_LINKS.climb(), reason: "One of your people" },
  },
  streak_risk: {
    category: "climb",
    render: (d) => ({ title: `Your ${d.days}-day streak ends at midnight`, body: "One run on The Climb keeps it going.", deepLink: DEEP_LINKS.climb(), reason: "Your streak" }),
  },
  host_cancelled: {
    category: "parties",
    render: (d) => ({ title: `The host cancelled ${d.title}`, body: d.entryBack ? "Your entry is back in your wallet." : "Find another party to play.", deepLink: DEEP_LINKS.party(d.partyId), reason: "You'd joined this party" }),
  },
  guest_follow_up: {
    category: "account",
    render: (d) => ({ title: "Keep your score next time", body: `You played ${d.title} as a guest. Sign up to save your scores and play with friends.`, deepLink: DEEP_LINKS.signUp(), reason: "You played as a guest" }),
  },
  win_back: {
    category: "people",
    render: (d) => ({ title: `${d.personName} ${d.what}`, body: "Your people are playing. Come back for a round.", deepLink: DEEP_LINKS.home(), reason: "What your people did" }),
  },
};
export const NUDGE_KINDS = kinds as { [K in NudgeKind]: NudgeKindDef<K> };
export const NUDGE_KIND_NAMES = Object.keys(kinds) as NudgeKind[];
export const nudgeKindSchema = z.enum(NUDGE_KIND_NAMES as [NudgeKind, ...NudgeKind[]]);

/** The copy for a kind, guarded: copy that mentions money throws. */
export function renderNudge<K extends NudgeKind>(kind: K, data: NudgeData[K], actors: readonly NudgeActor[] = []): NudgeContent {
  const content = (NUDGE_KINDS[kind] as NudgeKindDef<K>).render(data, actors);
  assertNoMoney(content);
  return content;
}

// ---- outcomes --------------------------------------------------------------------------

export const NUDGE_STATUSES = ["pending", "sending", "sent", "skipped", "withdrawn"] as const;
export type NudgeStatus = (typeof NUDGE_STATUSES)[number];
export const NUDGE_CHANNELS = ["push", "banner"] as const;
export type NudgeChannel = (typeof NUDGE_CHANNELS)[number];
/**
 * Why a nudge wasn't sent, logged on its record: the recommendation service tunes from these.
 * - toggle_off: its category is off. kind_cap: the kind's own cap. daily_cap: 3 pushes today already.
 * - quiet_hours: 23:00–07:00 where they are. no_device: no device with push allowed. push_failed: every send failed.
 * - not_needed: no longer true for them (in the room already; has a party within the hour). stale: due too long ago.
 * - in_app: a push-only nudge while the app is open. unavailable: the account is banned or deleted.
 * - money: its copy mentioned money (a party title, say), so it never goes out.
 */
export const NUDGE_SKIP_REASONS = ["toggle_off", "kind_cap", "daily_cap", "quiet_hours", "no_device", "push_failed", "not_needed", "stale", "in_app", "unavailable", "money"] as const;
export type NudgeSkipReason = (typeof NUDGE_SKIP_REASONS)[number];

// ---- config ----------------------------------------------------------------------------

/** app_config "nudges". */
export const nudgeConfigSchema = z.object({
  /** Pushes a day (the person's local day) outside live-party events. */
  dailyPushCap: z.number().int().min(0).max(50),
  quietHours: z.object({ startHour: z.number().int().min(0).max(23), endHour: z.number().int().min(0).max(23) }),
  /** People joining your party: at most one nudge per party this often, the rest merged ("Ada and 2 others"). */
  peopleJoinedGapSeconds: z.number().int().min(0),
  mentionBatchSeconds: z.number().int().min(0),
  replyBatchSeconds: z.number().int().min(0),
  /** New-party alerts from one corner a day. */
  cornerPartyAlertsPerDay: z.number().int().min(1).max(20),
  /** After a party goes live, how long to wait before telling seated players who aren't in the room. */
  liveNudgeDelaySeconds: z.number().int().min(0).max(600),
  /** Filling up: share of seats taken, minutes to start, and the most people one party tells. */
  fillingUpShare: z.number().min(0.1).max(1),
  fillingUpMinutes: z.number().int().min(1).max(120),
  fillingUpMaxAudience: z.number().int().min(1).max(10_000),
  /** Asking players to follow your corner: how many a day, from players of your parties in this many days. */
  followAsksPerDay: z.number().int().min(0).max(500),
  followAskRecentDays: z.number().int().min(1).max(365),
  /** Win-back on these days without a session. */
  winBackDays: z.array(z.number().int().min(1).max(60)).max(4),
  /** The local hour the hourly sweep sends win-backs. */
  winBackLocalHour: z.number().int().min(0).max(23),
  guestFollowUpHours: z.number().int().min(1).max(168),
  /** Streak at risk this many hours before the streak's day ends. */
  streakRiskHoursBefore: z.number().int().min(1).max(12),
});
export type NudgeConfig = z.infer<typeof nudgeConfigSchema>;
export const DEFAULT_NUDGE_CONFIG: NudgeConfig = {
  dailyPushCap: 3,
  quietHours: { startHour: 23, endHour: 7 },
  peopleJoinedGapSeconds: 3600,
  mentionBatchSeconds: 60,
  replyBatchSeconds: 300,
  cornerPartyAlertsPerDay: 2,
  liveNudgeDelaySeconds: 20,
  fillingUpShare: 0.6,
  fillingUpMinutes: 10,
  fillingUpMaxAudience: 500,
  followAsksPerDay: 20,
  followAskRecentDays: 30,
  winBackDays: [3, 7],
  winBackLocalHour: 18,
  guestFollowUpHours: 24,
  streakRiskHoursBefore: 3,
};

// ---- the API and the socket ------------------------------------------------------------

export const DEVICE_PLATFORMS = ["ios", "android", "web"] as const;
/** The OS's answer: granted, denied, or not asked yet (the app asks at the first concrete moment, never at launch). */
export const PUSH_PERMISSIONS = ["granted", "denied", "prompt"] as const;
/**
 * PUT /me/device: this install (the x-install-id header, required). Send it at launch and whenever the token
 * or the permission changes; `token` is null until push is allowed. `timeZone` updates the account's zone.
 */
export const deviceRegisterSchema = z.object({
  platform: z.enum(DEVICE_PLATFORMS),
  token: z.string().min(1).max(4096).nullable(),
  appVersion: z.string().min(1).max(40),
  permission: z.enum(PUSH_PERMISSIONS),
  timeZone: timeZoneSchema.optional(),
});
export type DeviceRegister = z.infer<typeof deviceRegisterSchema>;
export const deviceSchema = z.object({
  installId: z.string(), platform: z.enum(DEVICE_PLATFORMS), hasToken: z.boolean(), appVersion: z.string(),
  permission: z.enum(PUSH_PERMISSIONS), lastSeenAt: z.string().datetime(),
});

/**
 * The quiet hours in effect for a person: from `start` until `end` (the next morning when it wraps midnight), as
 * "HH:MM" on their own clock in `timeZone`. Null when the config has none (start and end the same hour). Pushes
 * hold back in them, except a party they're in starting or going live; banners in the open app don't.
 */
export const quietHoursSchema = z.object({ start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/), timeZone: z.string() });
export type QuietHours = z.infer<typeof quietHoursSchema>;
const hhmm = (hour: number) => `${String(hour).padStart(2, "0")}:00`;
export function quietHoursIn(q: NudgeConfig["quietHours"], timeZone: string): QuietHours | null {
  return q.startHour === q.endHour ? null : { start: hhmm(q.startHour), end: hhmm(q.endHour), timeZone };
}

/** GET /me/notifications, and what PATCH answers. PATCH takes any of the toggles and/or the zone. */
export const notificationSettingsSchema = z.object({ toggles: nudgeTogglesSchema, timeZone: z.string(), quietHours: quietHoursSchema.nullable() });
export const notificationSettingsPatchSchema = z.object({ toggles: nudgeTogglesSchema.partial().optional(), timeZone: timeZoneSchema.optional() })
  .refine((p) => p.toggles !== undefined || p.timeZone !== undefined, { message: "toggles or timeZone" });

/**
 * The in-app banner (MSG.nudge on the inbox room), the same content and deep link as the push would have had.
 * The push's data carries `nudgeId`, `kind` and `deepLink` too, so either way the app reports
 * POST /me/nudges/:id/opened (tapped) or /dismissed (swiped away or closed).
 */
export const nudgeMessageSchema = nudgeContentSchema.extend({
  id: z.string().uuid(), kind: nudgeKindSchema, category: z.enum(NUDGE_CATEGORIES), createdAt: z.string().datetime(),
});
export type NudgeMessage = z.infer<typeof nudgeMessageSchema>;
export const nudgeReportSchema = z.object({ id: z.string().uuid(), openedAt: z.string().datetime().nullable(), dismissedAt: z.string().datetime().nullable() });

/** The base name of a user's nudge channel; publish and subscribe with @contestly/queue's nudgeChannel(), which carries PUBSUB_PREFIX. */
export const nudgeUserChannel = (userId: string) => `nudge:user:${userId}`;
/** Realtime keeps a hash per party of who's connected to its room (user id → connections), for "not in the room". */
export const partyHereKey = (partyId: string) => `party:here:${partyId}`;

/**
 * Asking players to follow your corner (corner setup and the corner page). GET /me/corner/invite-followers:
 * recent players of your parties who don't follow and were never asked, and how many more you can ask today.
 * POST it with the chosen ids: 422 not_eligible (details.userIds) or 429 follow_asks_limit (details.remainingToday)
 * refuse the whole request.
 */
export const FOLLOW_ASK_MAX_PER_REQUEST = 50;
export const followerInviteOptionsSchema = z.object({ players: z.array(personSchema), remainingToday: z.number().int(), dailyLimit: z.number().int() });
export const followerInviteSchema = z.object({ userIds: z.array(z.string().uuid()).min(1).max(FOLLOW_ASK_MAX_PER_REQUEST) });
export const followerInviteResultSchema = z.object({ asked: z.number().int(), remainingToday: z.number().int() });

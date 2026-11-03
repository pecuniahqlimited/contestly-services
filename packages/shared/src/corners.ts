/**
 * Corners (ADR 0012, row 6c): a host's home, earned by bringing people to play. The unlock rules, the
 * new-player rule and the interim Parties tab order live here, once; packages/db loads the facts.
 * Nothing on a corner leads with money.
 */
import { z } from "zod";
import { personSchema } from "./person.js";
import { laneSchema } from "./about.js";
import { CATEGORIES, type Category } from "./categories.js";

export const CORNER_STATUSES = ["locked", "unlocked", "revoked"] as const;
export type CornerStatus = (typeof CORNER_STATUSES)[number];

// ---- setup -----------------------------------------------------------------------------

/** The colours an owner picks for their corner: a fixed palette, so every one reads on the app's surfaces. The first is the default. */
export const CORNER_COLORS = ["#0B64FC", "#7C3AED", "#DB2777", "#EA580C", "#16A34A", "#0891B2", "#CA8A04", "#475569"] as const;
export type CornerColor = (typeof CORNER_COLORS)[number];
export const cornerColorSchema = z.enum(CORNER_COLORS);

/**
 * A corner's lane until its owner picks one: the lane most of the host's finished parties were tagged with
 * (ties to the most recent), or null when none of them is a lane.
 */
export function mostlyAbout(parties: { category: string; endedAt: Date }[]): Category | null {
  const tally = new Map<Category, { n: number; last: number }>();
  for (const p of parties) {
    const lane = (CATEGORIES as readonly string[]).includes(p.category) ? (p.category as Category) : null;
    if (!lane) continue;
    const t = tally.get(lane) ?? { n: 0, last: 0 };
    tally.set(lane, { n: t.n + 1, last: Math.max(t.last, p.endedAt.getTime()) });
  }
  let best: [Category, { n: number; last: number }] | null = null;
  for (const e of tally) if (!best || e[1].n > best[1].n || (e[1].n === best[1].n && e[1].last > best[1].last)) best = e;
  return best?.[0] ?? null;
}

// ---- unlocking -------------------------------------------------------------------------

/** The four thresholds, all over all time. Versioned admin config (corner_configs); an unlock keeps the version it met. */
export const cornerUnlockConfigSchema = z.object({
  /** P: finished parties hosted that count. */
  partiesHosted: z.number().int().min(1).max(1000),
  /** R: real players a party needs to count (signed in, actually played, host excluded). */
  realPlayersPerParty: z.number().int().min(1).max(500),
  /** D: distinct real players across the counted parties. */
  distinctPlayers: z.number().int().min(1).max(100_000),
  /** N: new players brought. */
  newPlayers: z.number().int().min(0).max(10_000),
});
export type CornerUnlockConfig = z.infer<typeof cornerUnlockConfigSchema>;
export const DEFAULT_CORNER_UNLOCK: CornerUnlockConfig = { partiesHosted: 5, realPlayersPerParty: 4, distinctPlayers: 20, newPlayers: 5 };

/** Counted so far: P, D and N (R is per party, so it's in which parties counted). */
export interface CornerCounts { partiesHosted: number; distinctPlayers: number; newPlayers: number }

export const cornerThresholdSchema = z.object({ need: z.number().int(), have: z.number().int(), met: z.boolean() });
export type CornerThreshold = z.infer<typeof cornerThresholdSchema>;

/** Each threshold against what's counted, and whether all of them are met (what unlocks a corner). */
export function unlockProgress(counts: CornerCounts, cfg: CornerUnlockConfig) {
  const t = (need: number, have: number): CornerThreshold => ({ need, have, met: have >= need });
  const thresholds = {
    partiesHosted: t(cfg.partiesHosted, counts.partiesHosted),
    distinctPlayers: t(cfg.distinctPlayers, counts.distinctPlayers),
    newPlayers: t(cfg.newPlayers, counts.newPlayers),
  };
  return { thresholds, allMet: Object.values(thresholds).every((x) => x.met) };
}

/** A party counts toward P (and its players toward D) with at least R real players. */
export const partyCountsForCorner = (realPlayers: number, cfg: Pick<CornerUnlockConfig, "realPlayersPerParty">) => realPlayers >= cfg.realPlayersPerParty;

/** How someone came to be a host's new player: their first finished party was the host's, or they signed up from the host's invite. */
export const NEW_PLAYER_VIA = ["first_party", "invite"] as const;
export type NewPlayerVia = (typeof NEW_PLAYER_VIA)[number];
/** pending: attributed, but hasn't finished one of the host's parties yet. counted / excluded: decided, once. */
export const NEW_PLAYER_STATUSES = ["pending", "counted", "excluded"] as const;
export type NewPlayerStatus = (typeof NEW_PLAYER_STATUSES)[number];
export const NEW_PLAYER_EXCLUSIONS = ["email_not_verified", "no_install_id", "install_seen_on_another_account"] as const;
export type NewPlayerExclusion = (typeof NEW_PLAYER_EXCLUSIONS)[number];

/**
 * Whether a new player counts, decided once they've finished the host's party: only with a verified email
 * and an install id not seen on another account. The install id is a soft signal (a web build can reset
 * it); the unlock alert and an admin's revoke are what catch the rest.
 */
export function newPlayerVerdict(f: { emailVerified: boolean; hasInstallId: boolean; installSeenOnAnotherAccount: boolean }): { counts: true } | { counts: false; reason: NewPlayerExclusion } {
  if (!f.emailVerified) return { counts: false, reason: "email_not_verified" };
  if (!f.hasInstallId) return { counts: false, reason: "no_install_id" };
  if (f.installSeenOnAnotherAccount) return { counts: false, reason: "install_seen_on_another_account" };
  return { counts: true };
}

/** How many of the N must share an IP or install id (with each other or the host) for an unlock to raise a warning instead of info. */
export const UNLOCK_CLUSTER_MIN_PLAYERS = 2;

/**
 * Of an unlock's new players, the ones who share any signal (an IP or install id) with another of them or
 * with the host. `signals` is every (user, kind, value) seen for those people.
 */
export function clusteredPlayers(newPlayerIds: string[], hostId: string, signals: { userId: string; kind: string; value: string }[]): string[] {
  const people = new Set([...newPlayerIds, hostId]);
  const holders = new Map<string, Set<string>>();
  for (const s of signals) {
    if (!people.has(s.userId)) continue;
    const key = `${s.kind}:${s.value}`;
    holders.set(key, (holders.get(key) ?? new Set()).add(s.userId));
  }
  const clustered = new Set<string>();
  for (const who of holders.values()) if (who.size > 1) for (const id of who) if (id !== hostId) clustered.add(id);
  return newPlayerIds.filter((id) => clustered.has(id));
}

// ---- the install id --------------------------------------------------------------------

/**
 * The app makes a random id once per install and sends it on every request (sign-up included). A soft
 * signal only: it says "this device has been seen on another account", never proves who someone is.
 */
export const INSTALL_ID_HEADER = "x-install-id";
export const installIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);

// ---- the Parties tab, until recommendations (row 7) ------------------------------------

/** A party at least this full (seats taken / max)… */
export const FILLING_UP_SHARE = 0.6;
/** …and starting within this many minutes is pinned to the top of the Parties tab. */
export const FILLING_UP_WITHIN_MINUTES = 60;

type TabCard = { status: string; startsAt: string | Date; playerCount: number; maxPlayers: number };
const startOf = (c: TabCard) => new Date(c.startsAt).getTime();
/** Open and filling up: over FILLING_UP_SHARE full and starting within FILLING_UP_WITHIN_MINUTES. */
export const isFillingUp = (c: TabCard, now: Date) => {
  const toStart = startOf(c) - now.getTime();
  return c.status === "open" && c.maxPlayers > 0 && c.playerCount / c.maxPlayers > FILLING_UP_SHARE && toStart >= 0 && toStart <= FILLING_UP_WITHIN_MINUTES * 60_000;
};
/** The interim Parties tab: filling-up parties pinned on top, then everything by starting soonest (live ones, already started, first). */
export function partiesTabOrder<T extends TabCard>(cards: T[], now: Date): T[] {
  const soonest = (a: T, b: T) => startOf(a) - startOf(b);
  return [...cards.filter((c) => isFillingUp(c, now)).sort(soonest), ...cards.filter((c) => !isFillingUp(c, now)).sort(soonest)];
}

// ---- posts -----------------------------------------------------------------------------

/** The fixed reactions on a host post. One per person per post; changing it replaces it. */
export const CORNER_REACTIONS = ["🔥", "😂", "👏", "😮", "❤️"] as const;
export type CornerReaction = (typeof CORNER_REACTIONS)[number];

/** Replies on a post are capped like a chat line. */
export const MAX_CORNER_REPLY_TEXT = 500;

export const cornerPostBodySchema = z.object({ text: z.string().trim().min(1).max(5000) });
export const cornerReplyBodySchema = z.object({ text: z.string().trim().min(1).max(MAX_CORNER_REPLY_TEXT), clientMsgId: z.string().uuid() });
export const cornerReactionBodySchema = z.object({ emoji: z.enum(CORNER_REACTIONS) });
export const cornerReportBodySchema = z.object({ reason: z.string().trim().max(200).optional() });
export const cornerMuteBodySchema = z.object({ userId: z.string().uuid() });
/** PATCH /me/corner. `lane: null` goes back to the default (what the host's parties are mostly about). */
export const cornerUpdateSchema = z.object({
  name: z.string().trim().min(2).max(40).optional(),
  bio: z.string().trim().max(280).nullable().optional(),
  lane: laneSchema.nullable().optional(),
  color: cornerColorSchema.optional(),
});
export type CornerUpdate = z.infer<typeof cornerUpdateSchema>;
/** What PATCH /me/corner answers. `laneChosen`: the owner picked the lane (false: it follows their parties). */
export const myCornerSchema = z.object({
  id: z.string().uuid(), name: z.string(), bio: z.string().nullable(), lane: z.enum(CATEGORIES).nullable(), laneChosen: z.boolean(), color: cornerColorSchema,
});
export const cornerFollowAlertSchema = z.object({ notify: z.boolean() });

export const cornerReplySchema = z.object({ id: z.string().uuid(), person: personSchema, text: z.string(), createdAt: z.string().datetime() });
export const cornerPostSchema = z.object({
  id: z.string().uuid(),
  cornerId: z.string().uuid(),
  text: z.string(),
  createdAt: z.string().datetime(),
  /** Each reaction with how many; `mine` is the viewer's own (null if none). */
  reactions: z.array(z.object({ emoji: z.enum(CORNER_REACTIONS), count: z.number().int() })),
  mine: z.enum(CORNER_REACTIONS).nullable(),
  replyCount: z.number().int(),
  /** The newest few replies, oldest first; the rest page in from GET /corner-posts/:id/replies. */
  replies: z.array(cornerReplySchema),
});
export type CornerPost = z.infer<typeof cornerPostSchema>;
export const PAGE_DEFAULT = 20;
export const cornerPageQuerySchema = z.object({ before: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(50).default(PAGE_DEFAULT) });
export const cornerPostsPageSchema = z.object({ posts: z.array(cornerPostSchema), before: z.string().uuid().nullable() });
export const cornerRepliesPageSchema = z.object({ replies: z.array(cornerReplySchema), before: z.string().uuid().nullable() });
/** Replies a post carries inline. */
export const POST_REPLIES_INLINE = 3;

// ---- the corner, its follows and followers ---------------------------------------------

/** A corner as a card, a profile or a party shows it. Only unlocked corners of hosts in good standing are ever shown. */
export const cornerRefSchema = z.object({
  id: z.string().uuid(), name: z.string(), owner: personSchema, level: z.number().int(), followerCount: z.number().int(),
  lane: z.enum(CATEGORIES).nullable(), color: cornerColorSchema,
});
export type CornerRef = z.infer<typeof cornerRefSchema>;
/** The viewer and a corner: following it (with party alerts on or off). All false signed out. */
export const cornerViewerSchema = z.object({ following: z.boolean(), notify: z.boolean() });
/** On a profile and in a party's lobby: the host's corner, if they have one (its colour and lane to dress the link), and whether the viewer follows it. */
export const hostCornerSchema = cornerRefSchema.pick({ id: true, name: true, color: true, lane: true }).extend({ following: z.boolean() });
/** POST/DELETE/PATCH /corners/:id/follow. */
export const cornerFollowStateSchema = cornerViewerSchema.extend({ followerCount: z.number().int() });

/** "N of your people follow this": how many, and the first few. */
export const yourPeopleFollowingSchema = z.object({ count: z.number().int(), faces: z.array(personSchema) });
export const YOUR_PEOPLE_FACES = 3;

/** GET /corners/:id/followers: public, newest first, a page at a time, with your people who follow it on top. */
export const cornerFollowersPageSchema = z.object({
  total: z.number().int(),
  yourPeople: yourPeopleFollowingSchema,
  followers: z.array(z.object({ person: personSchema, followedAt: z.string().datetime(), isYourPerson: z.boolean() })),
  before: z.string().nullable(),
});
export const cornerFollowersQuerySchema = z.object({ before: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });

/**
 * GET /corners/suggested (interim until recommendations, row 7): unlocked corners in the viewer's lanes, most
 * followed first, then the most-followed others, never one they follow or their own; if that leaves none
 * (they follow every corner), the most followed anyway. Empty only when no corner is unlocked at all.
 * `reason` is why it's there, for the UI to say ("Football, your lane" / "popular").
 */
export const CORNER_SUGGESTION_REASONS = ["your_lane", "popular"] as const;
export const SUGGESTED_CORNERS_DEFAULT = 10;
export const suggestedCornersQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(30).default(SUGGESTED_CORNERS_DEFAULT) });
export const suggestedCornersSchema = z.object({
  corners: z.array(z.object({ corner: cornerRefSchema, reason: z.enum(CORNER_SUGGESTION_REASONS), following: z.boolean() })),
});
export type SuggestedCorners = z.infer<typeof suggestedCornersSchema>;

/** GET /me/follows: the corners you follow, newest first. */
export const myFollowsSchema = z.array(z.object({ corner: cornerRefSchema, notify: z.boolean(), followedAt: z.string().datetime() }));

/** A corner's weekly Regulars board: party points earned in this host's parties this week. */
export const cornerRegularSchema = z.object({ rank: z.number().int(), person: personSchema, points: z.number().int(), parties: z.number().int(), wins: z.number().int() });
/** Recent winners of the host's public parties. */
export const cornerWinnerSchema = z.object({ party: z.object({ id: z.string().uuid(), title: z.string(), endedAt: z.string().datetime() }), person: personSchema });
export const CORNER_WINNERS_SHOWN = 5;
export const CORNER_REGULARS_SHOWN = 10;
export const CORNER_UP_NEXT_SHOWN = 10;

// ---- progress --------------------------------------------------------------------------

export const progressPartySchema = z.object({ id: z.string().uuid(), title: z.string(), endedAt: z.string().datetime(), realPlayers: z.number().int(), counts: z.boolean() });
export const progressNewPlayerSchema = z.object({
  person: personSchema,
  via: z.enum(NEW_PLAYER_VIA),
  status: z.enum(NEW_PLAYER_STATUSES),
  reason: z.enum(NEW_PLAYER_EXCLUSIONS).nullable(),
  /** Banned since: no longer counted. */
  banned: z.boolean(),
  at: z.string().datetime(),
});

/**
 * GET /me/corner/progress (and the admin's view of any host): each threshold, how far along, and what counted.
 * `parties` lists the finished parties hosted, newest first, with whether each counted (R real players).
 */
export const cornerProgressSchema = z.object({
  corner: z.object({
    id: z.string().uuid(), name: z.string(), bio: z.string().nullable(), status: z.enum(CORNER_STATUSES), level: z.number().int(),
    unlockedAt: z.string().datetime().nullable(), unlockConfigVersion: z.number().int().nullable(),
    /** Null until the owner's app has shown the unlock celebration: show it when unlocked and this is null. */
    celebrationSeenAt: z.string().datetime().nullable(),
    lane: z.enum(CATEGORIES).nullable(), laneChosen: z.boolean(), color: cornerColorSchema,
  }).nullable(),
  config: cornerUnlockConfigSchema.extend({ version: z.number().int() }),
  thresholds: z.object({ partiesHosted: cornerThresholdSchema, distinctPlayers: cornerThresholdSchema, newPlayers: cornerThresholdSchema }),
  allMet: z.boolean(),
  parties: z.array(progressPartySchema),
  newPlayers: z.array(progressNewPlayerSchema),
});
export type CornerProgress = z.infer<typeof cornerProgressSchema>;
/** POST /me/corner/celebration-seen: when it was first seen (a repeat keeps the first time). */
export const celebrationSeenSchema = z.object({ celebrationSeenAt: z.string().datetime() });

/** The admin's view adds who made up N at unlock, whether an admin granted it instead (ADR 0012 §4), and how a revoke went. */
export const adminCornerViewSchema = cornerProgressSchema.extend({
  host: personSchema,
  unlockContributors: z.array(personSchema),
  granted: z.object({ by: personSchema, at: z.string().datetime(), reason: z.string() }).nullable(),
  revoked: z.object({ by: personSchema, at: z.string().datetime(), reason: z.string() }).nullable(),
});
/** POST /admin/corners/grant: unlock a corner for a signed-up, unbanned account, whatever its progress. */
export const adminCornerGrantSchema = z.object({ userId: z.string().uuid(), reason: z.string().trim().min(1).max(500) });
export const adminCornerConfigSchema = cornerUnlockConfigSchema.extend({ version: z.number().int(), updatedAt: z.string().datetime() });
export const adminCornerConfigBodySchema = z.object({ config: cornerUnlockConfigSchema, reason: z.string().trim().min(1).max(500) });

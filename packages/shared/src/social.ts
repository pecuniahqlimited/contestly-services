/**
 * The social layer (row 6b): profiles from real results, the friends and crew boards (Climb points plus
 * party points, ADR 0008), the feed of what your people did, crews, Challenge and rematch. Nothing here
 * leads with money: boards and feeds count play, never prizes.
 */
import { z } from "zod";
import { personSchema } from "./person.js";
import { chatPreviewSchema } from "./chat.js";

// ---- config ----------------------------------------------------------------------------

/** Admin-editable social settings (app_config "social"). */
export const socialConfigSchema = z.object({
  /** Members a crew may have, pending invites included. */
  crewMaxMembers: z.number().int().min(2).max(500),
  /** Party points for finishing a bragging-rights party (free, no prize) with at least partyPointsMinPlayers players. */
  partyFinishPoints: z.number().int().min(0),
  /** Extra points by place: 1st, 2nd, 3rd… */
  partyPlacePoints: z.array(z.number().int().min(0)).max(10),
  partyPointsMinPlayers: z.number().int().min(2),
  /** Parties a day that earn points, per player (Lagos day). */
  partyPointsDailyCap: z.number().int().min(1),
  /** One-tap challenges a person may send a day. */
  challengesPerDay: z.number().int().min(1),
  /** Streak lengths that show up in the feed. */
  streakMilestones: z.array(z.number().int().min(2)),
});
export type SocialConfig = z.infer<typeof socialConfigSchema>;
export const DEFAULT_SOCIAL_CONFIG: SocialConfig = {
  crewMaxMembers: 50,
  partyFinishPoints: 10,
  partyPlacePoints: [40, 20, 10],
  partyPointsMinPlayers: 3,
  partyPointsDailyCap: 5,
  challengesPerDay: 10,
  streakMilestones: [7, 14, 30, 50, 100, 365],
};

/**
 * A bragging-rights party: nothing to pay in and nothing to win. Only these earn party points on the friends
 * and crew boards; a party with an entry fee or a prize of any kind (cash or goods) earns none.
 */
export const isBraggingRights = (p: { entryKobo: number; funding: string; prizeKind: string; hostPoolKobo: number }) =>
  p.entryKobo === 0 && !(p.funding === "host" && (p.hostPoolKobo > 0 || p.prizeKind !== "cash"));

/** Party points for one finish: the finish points plus the place's, or 0 when the party was too small. Daily cap applied by the caller. */
export function partyPointsFor(rank: number, playerCount: number, cfg: Pick<SocialConfig, "partyFinishPoints" | "partyPlacePoints" | "partyPointsMinPlayers">): number {
  if (playerCount < cfg.partyPointsMinPlayers || rank < 1) return 0;
  return cfg.partyFinishPoints + (cfg.partyPlacePoints[rank - 1] ?? 0);
}

// ---- boards ----------------------------------------------------------------------------

export const BOARD_PERIODS = ["week", "all"] as const;
export type BoardPeriod = (typeof BOARD_PERIODS)[number];
export const boardQuerySchema = z.object({ period: z.enum(BOARD_PERIODS).default("week") });

/** One row of a friends or crew board. `prevRank`: where they stood when today began (week only; null if they weren't on it). */
export const socialBoardRowSchema = z.object({
  rank: z.number().int(),
  prevRank: z.number().int().nullable(),
  person: personSchema,
  climb: z.number().int(),
  parties: z.number().int(),
  total: z.number().int(),
  isMe: z.boolean(),
  /** Last week's crew champion (crew boards only). */
  crowned: z.boolean(),
});
export type SocialBoardRow = z.infer<typeof socialBoardRowSchema>;

/** GET /leaderboards/friends and GET /crews/:id/board. `endsAt`: when this week closes (week only). */
export const socialBoardSchema = z.object({
  period: z.enum(BOARD_PERIODS),
  week: z.string(),
  endsAt: z.string().datetime().nullable(),
  rows: z.array(socialBoardRowSchema),
  me: socialBoardRowSchema.nullable(),
});
export type SocialBoard = z.infer<typeof socialBoardSchema>;

// ---- feed ------------------------------------------------------------------------------

export const FEED_KINDS = ["party_finished", "climb_best", "streak"] as const;
export type FeedKind = (typeof FEED_KINDS)[number];
/** What each kind carries. Never an amount of money. */
export const feedDataSchemas = {
  party_finished: z.object({ partyId: z.string().uuid(), title: z.string(), rank: z.number().int().nullable(), playerCount: z.number().int() }),
  climb_best: z.object({ points: z.number().int(), stagesCleared: z.number().int(), stageCount: z.number().int(), clearedAll: z.boolean() }),
  streak: z.object({ days: z.number().int() }),
} as const;
export type FeedData<K extends FeedKind> = z.infer<(typeof feedDataSchemas)[K]>;
export const feedEventSchema = z.discriminatedUnion("kind", FEED_KINDS.map((kind) =>
  z.object({ id: z.string().uuid(), kind: z.literal(kind), person: personSchema, data: feedDataSchemas[kind], createdAt: z.string().datetime() })) as unknown as [z.ZodDiscriminatedUnionOption<"kind">, ...z.ZodDiscriminatedUnionOption<"kind">[]]);
export type FeedEvent = z.infer<typeof feedEventSchema>;
/** GET /feed and GET /users/:handle/activity: newest first; `before` pages further back (null at the end). */
export const FEED_PAGE_DEFAULT = 20;
export const feedQuerySchema = z.object({ before: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(50).default(FEED_PAGE_DEFAULT) });
export const feedPageSchema = z.object({ events: z.array(feedEventSchema), before: z.string().uuid().nullable() });
export type FeedPage = z.infer<typeof feedPageSchema>;

// ---- profiles --------------------------------------------------------------------------

/** What GET /users/:handle adds for row 6b. No money anywhere on a profile. */
export const profileSocialSchema = z.object({
  climb: z.object({ bestRunPoints: z.number().int(), bestStagesCleared: z.number().int(), clearedAll: z.boolean() }),
  streak: z.object({ current: z.number().int(), best: z.number().int() }),
  /** People the viewer follows who follow this person: how many, and the first few. */
  mutuals: z.object({ count: z.number().int(), faces: z.array(personSchema) }),
  /** Whether the viewer can message them: direct, a request, or not at all. Null signed out or on your own profile. */
  canMessage: z.enum(["direct", "request", "refused"]).nullable(),
  /** A live party they're playing that the viewer can see. */
  playingNow: z.object({ id: z.string().uuid(), title: z.string() }).nullable(),
});

/** POST /users/:id/challenge → 201: the party made for the two of you; they're invited and it's in your DM. */
export const challengeResponseSchema = z.object({ partyId: z.string().uuid(), threadId: z.string().uuid() });
/** POST /parties/:id/rematch → the rematch everyone from that party lands in (`created`: this call made it). Joining is a separate POST /parties/:id/join. */
export const rematchResponseSchema = z.object({ partyId: z.string().uuid(), created: z.boolean() });

// ---- crews -----------------------------------------------------------------------------

export const CREW_ROLES = ["creator", "admin", "member"] as const;
export type CrewRole = (typeof CREW_ROLES)[number];

export const crewFaceSchema = z.object({ emoji: z.string().min(1).max(8), color: z.string().regex(/^#[0-9a-fA-F]{6}$/) });
export const createCrewSchema = z.object({
  name: z.string().trim().min(2).max(40),
  emoji: z.string().min(1).max(8).default("🏆"),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#0B64FC"),
  inviteUserIds: z.array(z.string().uuid()).max(100).default([]),
});
export const updateCrewSchema = createCrewSchema.pick({ name: true, emoji: true, color: true }).partial();
export const crewInviteSchema = z.object({ userIds: z.array(z.string().uuid()).min(1).max(100) });
export const crewRoleSchema = z.object({ role: z.enum(["admin", "member"]) });
export type CreateCrewInput = z.infer<typeof createCrewSchema>;

export const crewSchema = z.object({ id: z.string().uuid(), name: z.string(), emoji: z.string(), color: z.string(), memberCount: z.number().int() });

/** GET /crews: Chats › Crews. Your place this week and who leads, the chat's last line and unread. */
export const crewListItemSchema = crewSchema.extend({
  role: z.enum(CREW_ROLES),
  threadId: z.string().uuid(),
  lastMessage: chatPreviewSchema.nullable(),
  unread: z.number().int(),
  myRank: z.number().int().nullable(),
  leader: personSchema.nullable(),
});
export const crewListSchema = z.array(crewListItemSchema);

export const crewMemberSchema = z.object({ person: personSchema, role: z.enum(CREW_ROLES), joinedAt: z.string().datetime(), crowned: z.boolean() });
/** Crew records among current members: best climb (most stages, then points), most crew-party wins, longest streak. */
export const crewRecordsSchema = z.object({
  bestClimb: z.object({ person: personSchema, stagesCleared: z.number().int(), points: z.number().int(), clearedAll: z.boolean() }).nullable(),
  mostCrewPartyWins: z.object({ person: personSchema, wins: z.number().int() }).nullable(),
  longestStreak: z.object({ person: personSchema, days: z.number().int() }).nullable(),
});
export type CrewRecords = z.infer<typeof crewRecordsSchema>;
/** GET /crews/:id (members only). Pending invites are listed for the creator and admins. */
export const crewDetailSchema = crewSchema.extend({
  myRole: z.enum(CREW_ROLES),
  threadId: z.string().uuid(),
  members: z.array(crewMemberSchema),
  champion: personSchema.nullable(),
  records: crewRecordsSchema,
  pendingInvites: z.array(personSchema),
  maxMembers: z.number().int(),
});
export type CrewDetail = z.infer<typeof crewDetailSchema>;
export type CrewMember = z.infer<typeof crewMemberSchema>;

/** POST /crews → 201 and POST /crews/:id/invites → 201: the crew as you now see it, and how many new invites went out (already in or already asked are skipped). */
export const crewInvitedResponseSchema = crewDetailSchema.extend({ invited: z.number().int() });
/** POST /crews/:id/invite/accept | decline. Accepting returns the crew you just joined. */
export const crewInviteAnswerResponseSchema = z.discriminatedUnion("joined", [
  z.object({ joined: z.literal(true), crew: crewDetailSchema }),
  z.object({ joined: z.literal(false) }),
]);
/** PATCH /crews/:id/members/:userId: the member with their new role. */
export const crewRoleResponseSchema = crewMemberSchema;
/** DELETE /crews/:id/members/:userId: the crew without them. */
export const crewRemoveResponseSchema = z.object({ removed: z.literal(true), crew: crewDetailSchema });
/** POST /crews/:id/leave. `newCreator`: who runs it now when the creator left; null otherwise, and when the last one out archived it. */
export const crewLeaveResponseSchema = z.object({ left: z.literal(true), archived: z.boolean(), newCreator: personSchema.nullable() });
export type CrewInvitedResponse = z.infer<typeof crewInvitedResponseSchema>;
export type CrewInviteAnswerResponse = z.infer<typeof crewInviteAnswerResponseSchema>;
export type CrewRemoveResponse = z.infer<typeof crewRemoveResponseSchema>;
export type CrewLeaveResponse = z.infer<typeof crewLeaveResponseSchema>;

/** GET /me/crew-invites: crews you've been asked to join. */
export const crewInviteItemSchema = z.object({ crew: crewSchema, invitedBy: personSchema, createdAt: z.string().datetime() });
export const crewInvitesSchema = z.array(crewInviteItemSchema);

/**
 * Who takes over when the creator leaves: the longest-standing admin, else the longest-standing member.
 * Null when nobody's left (the crew is archived).
 */
export function nextCreator<T extends { userId: string; role: CrewRole; joinedAt: Date }>(remaining: readonly T[]): T | null {
  const byTenure = [...remaining].sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime() || (a.userId < b.userId ? -1 : 1));
  return byTenure.find((m) => m.role === "admin") ?? byTenure[0] ?? null;
}

/** The brief a one-tap challenge starts from: the lanes you share, else yours, else general knowledge. */
export function challengeBrief(mine: readonly string[], theirs: readonly string[]): { brief: string; lanes: string[] } {
  const shared = mine.filter((l) => theirs.includes(l));
  const lanes = (shared.length ? shared : mine).slice(0, 3);
  if (!lanes.length) return { brief: "A head-to-head general knowledge quiz", lanes: [] };
  const list = lanes.length === 1 ? lanes[0] : `${lanes.slice(0, -1).join(", ")} and ${lanes.at(-1)}`;
  return { brief: `A head-to-head quiz on ${list}`, lanes };
}

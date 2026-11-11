/**
 * Challenges (ADR 0019): a party made through POST /parties with `challenge`, to people the DM rule lets you
 * message. The preset is the builder's defaults; the card's state is what each person sees in their DM; the ranges
 * are admin config. Nothing here leads with money.
 */
import { z } from "zod";
import { CATEGORIES } from "./categories.js";
import { personSchema } from "./person.js";
import { reasonSchema } from "./admin.js";

// ---- config ----------------------------------------------------------------------------

/** An admin-set range for something the challenger picks, with the default the preset offers. */
const pickRangeSchema = (outerMin: number, outerMax: number) => z.object({
  min: z.number().int().min(outerMin).max(outerMax),
  max: z.number().int().min(outerMin).max(outerMax),
  default: z.number().int().min(outerMin).max(outerMax),
}).refine((r) => r.min <= r.default && r.default <= r.max, { message: "min ≤ default ≤ max" });
export type PickRange = { min: number; max: number; default: number };

/** app_config "challenges": how long an invite waits for an answer, and how long the lobby waits once someone accepts. */
export const challengeConfigSchema = z.object({
  /** Minutes an invite stays open before it expires (1–48 hours by default). */
  inviteExpiryMinutes: pickRangeSchema(10, 7 * 24 * 60),
  /** Minutes the lobby waits after the first accept (5–60 by default). */
  joinWindowMinutes: pickRangeSchema(1, 120),
});
export type ChallengeConfig = z.infer<typeof challengeConfigSchema>;
export const DEFAULT_CHALLENGE_CONFIG: ChallengeConfig = {
  inviteExpiryMinutes: { min: 60, max: 48 * 60, default: 24 * 60 },
  joinWindowMinutes: { min: 5, max: 60, default: 10 },
};
/** PUT /admin/challenges/config { config, reason }: logged with the reason. */
export const adminChallengeConfigUpdateSchema = z.object({ config: challengeConfigSchema, reason: reasonSchema });

/** A challenge needs this many players in the room to go ahead. */
export const CHALLENGE_MIN_PLAYERS = 2;
/** The most people one challenge asks. */
export const CHALLENGE_MAX_INVITEES = 19;
export const CHALLENGE_MESSAGE_MAX_CHARS = 140;
/** The preset's quick length. */
export const CHALLENGE_PRESET_QUESTIONS = 5;

// ---- errors ----------------------------------------------------------------------------

/** 403: this person can't be challenged (the DM rule refuses, blocked, a brand, a guest, banned). details: { userId }. */
export const CANNOT_CHALLENGE = "cannot_challenge";
/** 422: the expiry or join window is outside the admin's range. details: { field, min, max }. */
export const CHALLENGE_OUT_OF_RANGE = "challenge_out_of_range";
/** 422: what a challenge can't be. details: { reason }. */
export const CHALLENGE_NOT_ALLOWED = "challenge_not_allowed";
export const CHALLENGE_REFUSALS = ["as_brand", "curate", "stakes", "crew", "invite_list"] as const;
/** 409: the invite expired, or the join window closed, before this answer. */
export const CHALLENGE_EXPIRED = "challenge_expired";
/** 409: already answered the other way. details: { answer }. */
export const CHALLENGE_ANSWERED = "challenge_answered";
/** 409: a challenge is joined by accepting it (POST /challenges/:partyId/accept), not through /join or extra invites. */
export const CHALLENGE_ACCEPT_REQUIRED = "challenge_accept_required";
/** 429: the daily send limit (social config challengesPerDay). */
export const TOO_MANY_CHALLENGES = "too_many_challenges";

/** The party chat's line when a challenge ends without being played, and the card's line on a decline. */
export const CHALLENGE_EXPIRED_MESSAGE = "Challenge expired.";
export const CHALLENGE_DECLINED_LINE = "Not this time";

// ---- creating ---------------------------------------------------------------------------

/** A challenge's party chat opens with who challenged whom ("Ada challenged Kemi, Tolu and Zee"), not the private party's share line. */
export function challengeOpeningLine(challengerName: string, inviteeNames: readonly string[]): string {
  const names = inviteeNames.length > 1 ? `${inviteeNames.slice(0, -1).join(", ")} and ${inviteeNames.at(-1)}` : (inviteeNames[0] ?? "");
  return `${challengerName} challenged ${names}`;
}

/** POST /parties `challenge`: who, how long the invite waits, how long the lobby waits once someone accepts. */
export const challengeFieldsSchema = z.object({
  invitees: z.array(z.string().uuid()).min(1).max(CHALLENGE_MAX_INVITEES).refine((ids) => new Set(ids).size === ids.length, { message: "each invitee once" }),
  inviteExpiresInMinutes: z.number().int(),
  joinWindowMinutes: z.number().int(),
  message: z.string().trim().min(1).max(CHALLENGE_MESSAGE_MAX_CHARS).optional(),
});
export type ChallengeFields = z.infer<typeof challengeFieldsSchema>;

/** The field outside its range, or null: the server's check, and the builder's explanation. */
export function challengeRangeProblem(f: Pick<ChallengeFields, "inviteExpiresInMinutes" | "joinWindowMinutes">, cfg: ChallengeConfig) {
  for (const [field, value, range] of [["inviteExpiresInMinutes", f.inviteExpiresInMinutes, cfg.inviteExpiryMinutes], ["joinWindowMinutes", f.joinWindowMinutes, cfg.joinWindowMinutes]] as const) {
    if (value < range.min || value > range.max) return { field, min: range.min, max: range.max };
  }
  return null;
}

// ---- the preset ------------------------------------------------------------------------

export const challengePresetQuerySchema = z.object({
  userIds: z.string().transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)).pipe(z.array(z.string().uuid()).min(1).max(CHALLENGE_MAX_INVITEES)),
});
export const CHALLENGE_TOPIC_REASONS = ["shared_lane", "last_party", "their_recent"] as const;
export type ChallengeTopicReason = (typeof CHALLENGE_TOPIC_REASONS)[number];
/** A topic to start from: the brief the builder fills in, and why it's suggested ("You both like it"). */
export const challengeTopicSchema = z.object({
  reason: z.enum(CHALLENGE_TOPIC_REASONS),
  label: z.string(),
  brief: z.string(),
  category: z.enum(CATEGORIES).nullable(),
});
export type ChallengeTopic = z.infer<typeof challengeTopicSchema>;
/** GET /challenges/preset?userIds=a,b: the builder's defaults for a challenge. Creates nothing. */
export const challengePresetSchema = z.object({
  invitees: z.array(z.object({ person: personSchema, canChallenge: z.boolean() })),
  topics: z.array(challengeTopicSchema),
  /** A createPartySchema body to start from (title, brief, 5 questions, free, private, sealed), minus `challenge`. No category: inferred from the brief. */
  party: z.object({
    title: z.string(), brief: z.string(), category: z.enum(CATEGORIES).optional(), questionCount: z.number().int(), entryKobo: z.literal(0),
    funding: z.literal("pooled"), visibility: z.literal("private"), mode: z.literal("sealed"), maxPlayers: z.number().int(), split: z.string(),
  }),
  challenge: z.object({ inviteExpiresInMinutes: z.number().int(), joinWindowMinutes: z.number().int() }),
  ranges: challengeConfigSchema,
});
export type ChallengePreset = z.infer<typeof challengePresetSchema>;

// ---- the card --------------------------------------------------------------------------

/**
 * An invitee's answer. no_answer: never answered before the invite expired (or the window closed); no_show: accepted,
 * but not in the lobby when the window closed; left: accepted, then left before the start.
 */
export const CHALLENGE_ANSWERS = ["pending", "accepted", "declined", "no_answer", "no_show", "left"] as const;
export type ChallengeAnswer = (typeof CHALLENGE_ANSWERS)[number];
/** How a challenge ended without being played, kept on it: nobody (enough) came, or everyone said no. */
export const CHALLENGE_ENDINGS = ["expired", "declined"] as const;
export type ChallengeEnding = (typeof CHALLENGE_ENDINGS)[number];

/**
 * The card, from the viewer's side: pending (time left to answer), accepted (the join countdown and who's in),
 * live, finished, expired (it ended unplayed: nobody accepted in time, or too few came), declined (everyone said no,
 * or the viewer did), cancelled (the challenger called it off), and the viewer's own ends: no_answer (they never
 * answered in time), no_show (they accepted but weren't in the lobby when the window closed), left (they accepted,
 * then left before the start).
 */
export const CHALLENGE_STATES = ["pending", "accepted", "live", "finished", "expired", "declined", "cancelled", "no_answer", "no_show", "left"] as const;
export type ChallengeState = (typeof CHALLENGE_STATES)[number];

export interface ChallengeStateInput {
  partyStatus: "open" | "live" | "finished" | "cancelled";
  ending: ChallengeEnding | null;
  windowOpen: boolean;
  inviteExpiresAt: Date;
  /** The viewer's own answer when they're an invitee. */
  myAnswer: ChallengeAnswer | null;
  now: Date;
}
/** The one place the card's state is decided. */
export function challengeState(c: ChallengeStateInput): ChallengeState {
  // The viewer's own answer ended it for them, whatever the party did next.
  if (c.myAnswer === "declined" || c.myAnswer === "left" || c.myAnswer === "no_answer" || c.myAnswer === "no_show") return c.myAnswer;
  if (c.partyStatus === "live") return "live";
  if (c.partyStatus === "finished") return "finished";
  if (c.partyStatus === "cancelled") return c.ending ?? "cancelled";
  const ranOut = c.now >= c.inviteExpiresAt;
  // Their invite ran out before the job that records it ran.
  if (c.myAnswer === "pending" && ranOut) return "no_answer";
  if (c.windowOpen) return "accepted";
  return ranOut ? "expired" : "pending";
}

export const challengeCardSchema = z.object({
  partyId: z.string().uuid(),
  title: z.string(),
  message: z.string().nullable(),
  challenger: personSchema,
  /** The equal entry each player pays (0: bragging rights). */
  entryKobo: z.number().int(),
  state: z.enum(CHALLENGE_STATES),
  /** The server's clock, so time left is counted from the same now. */
  now: z.string().datetime(),
  inviteExpiresAt: z.string().datetime(),
  joinWindowMinutes: z.number().int(),
  /** Once someone accepted: when the lobby stops waiting. */
  joinClosesAt: z.string().datetime().nullable(),
  invitees: z.array(z.object({ person: personSchema, answer: z.enum(CHALLENGE_ANSWERS), answeredAt: z.string().datetime().nullable() })),
  /** Who's connected to the lobby right now (never claimed: the room's own presence). */
  inLobby: z.array(z.string().uuid()),
  you: z.object({ role: z.enum(["challenger", "invitee"]), answer: z.enum(CHALLENGE_ANSWERS).nullable(), canAnswer: z.boolean() }),
});
export type ChallengeCard = z.infer<typeof challengeCardSchema>;

/** A challenge's card, the API path (relative to the API's base): GET it for the whole card. */
export const challengeCardPath = (partyId: string) => `/challenges/${partyId}`;

/**
 * A party's challenge flag (GET /parties/:id, which the lobby and the result read too): the card's state from the
 * viewer's side and where the whole card is, or null for an ordinary party. The card itself answers only the
 * challenger and the people asked; anyone else gets the challenge's own state here and a 404 there.
 */
export const partyChallengeFlagSchema = z.object({ state: z.enum(CHALLENGE_STATES), cardUrl: z.string() });
export type PartyChallengeFlag = z.infer<typeof partyChallengeFlagSchema>;

/** POST /challenges/:partyId/accept | decline. Accept: seated (the entry charged, if any); a repeat is replayed. */
export const challengeReplySchema = z.object({ answer: z.enum(["accepted", "declined"]), replayed: z.boolean(), card: challengeCardSchema });
export type ChallengeReply = z.infer<typeof challengeReplySchema>;

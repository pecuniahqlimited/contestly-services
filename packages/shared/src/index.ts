import { z } from "zod";

/** All money is stored in kobo (integer). ₦200 = 20_000 kobo. */
export const kobo = (naira: number) => Math.round(naira * 100);
export const naira = (k: number) => "₦" + (k / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 });

export const PAYOUT_STAGES = [
  { stage: 1, type: "pattern", prizeKobo: kobo(500) },
  { stage: 2, type: "scramble", prizeKobo: kobo(1500) },
  { stage: 3, type: "wordhunt", prizeKobo: kobo(4000) },
  { stage: 4, type: "sudden_death", prizeKobo: kobo(10000) },
] as const;
export const PAYOUT_ENTRY_COINS = 100;
export const DECISION_SECONDS = 8;

export const CATEGORIES = ["Afrobeats", "Football", "Nollywood", "General knowledge", "History", "Science", "Tech", "Fashion", "Food", "Geography", "Brain teasers", "Reality TV", "Maths", "Hip hop"] as const;

export const handleSchema = z.string().min(3).max(20).regex(/^[a-z0-9_.]+$/, "lowercase letters, numbers, _ and . only");

export const upsertMeSchema = z.object({
  displayName: z.string().min(1).max(40),
  handle: handleSchema,
  avatarEmoji: z.string().min(1).max(8).default("😎"),
  bio: z.string().max(160).optional(),
  interests: z.array(z.enum(CATEGORIES)).max(10).default([]),
});

export const createPartySchema = z.object({
  title: z.string().min(3).max(60),
  category: z.enum(CATEGORIES),
  entryKobo: z.number().int().min(0).max(kobo(50_000)),
  maxPlayers: z.number().int().min(2).max(100),
  funding: z.enum(["pooled", "host"]),
  hostPoolKobo: z.number().int().min(0).default(0),
  split: z.array(z.number().int().positive()).min(1).max(3).refine((s) => s.reduce((a, b) => a + b, 0) === 100, "split must add up to 100"),
  visibility: z.enum(["public", "private"]).default("public"),
  coverColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#7B5CFF"),
  coverEmoji: z.string().max(8).default("🎉"),
  startsInMinutes: z.number().int().min(1).max(24 * 60).default(10),
  inviteUserIds: z.array(z.string().uuid()).max(20).default([]),
}).refine((p) => p.funding === "host" ? p.hostPoolKobo > 0 : p.entryKobo > 0, { message: "pooled parties need an entry fee; host-funded parties need a pot" });

export const chatSendSchema = z.object({
  partyId: z.string().uuid(),
  text: z.string().min(1).max(280).optional(),
  sticker: z.string().min(1).max(8).optional(),
}).refine((m) => !!m.text !== !!m.sticker, "send either text or a sticker");

/** Socket.io event names — one source of truth for client and realtime service. */
export const RT = {
  lobbyJoin: "lobby:join",
  lobbyLeave: "lobby:leave",
  presence: "lobby:presence",
  chatSend: "chat:send",
  chatMessage: "chat:message",
  partyStatus: "party:status",
  error: "rt:error",
} as const;

/** Redis pub/sub channel the worker publishes party lifecycle events on; realtime fans them out. */
export const PARTY_EVENTS_CHANNEL = "party:events";

/** BullMQ queue names and job payloads. */
export const QUEUES = { notify: "notify", party: "party" } as const;
export type NotifyFollowersJob = { kind: "party_created"; partyId: string; hostId: string };
export type NotifyInviteJob = { kind: "party_invite"; partyId: string; fromUserId: string; toUserIds: string[] };
export type NotifyJob = NotifyFollowersJob | NotifyInviteJob;
export type PartyJob = { kind: "start" | "cancel_if_empty"; partyId: string };

export type CreatePartyInput = z.infer<typeof createPartySchema>;
export type UpsertMeInput = z.infer<typeof upsertMeSchema>;

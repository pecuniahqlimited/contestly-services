/**
 * Seats and the host's cancel. Leaving (POST /parties/:id/leave): a seated player who isn't the host may
 * leave while the party is open and more than PARTY_LEAVE_LOCK_SECONDS before it starts, and gets their
 * whole entry back, leg by leg. Cancelling (POST /parties/:id/cancel): the host may cancel while the party
 * is open, lock or not, until it goes live; every seat is refunded the way it was paid. The rules live here
 * so the server enforces them and the app explains them the same way.
 */
import { z } from "zod";

/** Inside this long before startsAt, seats are locked: nobody leaves a party that's about to start. */
export const PARTY_LEAVE_LOCK_SECONDS = 120;

export const PARTY_LOCKED = "party_locked";
export const PARTY_CLOSED = "party_closed";
export const HOST_MUST_CANCEL = "host_must_cancel";
export const NOT_IN_PARTY = "not_in_party";
/** Sent (as MSG.error) to a player's own connections in the party room when they leave, before it closes them. */
export const LEFT_PARTY = "left_party";
/** Host cancel: the party already started. */
export const PARTY_LIVE = "party_live";
/** Host cancel: 403 for anyone who isn't the party's host. */
export const NOT_HOST = "not_host";

/** WebSocket close codes the party room uses. */
export const PARTY_LEFT_CLOSE_CODE = 4409;
export const HOST_CANCELLED_CLOSE_CODE = 4410;

/** Whether seats can still be given up: open, locked (starting within the lock, or live), or closed (finished or cancelled). */
export type LeaveWindow = "open" | "locked" | "closed";
export function leaveWindow(p: { status: string; startsAt: Date | string }, now: Date = new Date()): LeaveWindow {
  if (p.status === "finished" || p.status === "cancelled") return "closed";
  if (p.status !== "open") return "locked";
  return new Date(p.startsAt).getTime() - now.getTime() > PARTY_LEAVE_LOCK_SECONDS * 1000 ? "open" : "locked";
}

/** POST /parties/:id/leave → 200. A retry (or a double tap) gets the same refund back with replayed: true. */
export const leavePartyResponseSchema = z.object({
  left: z.literal(true),
  replayed: z.boolean(),
  /** What came back, exactly as the entry was paid: bonus coins to bonus, cash to cash. Both 0 for a free party. */
  refund: z.object({ toBonusKobo: z.number().int().nonnegative(), toCashKobo: z.number().int().nonnegative() }),
  /** The pot now (a pooled pot shrinks by the entry), and the seats. */
  potKobo: z.number().int().nonnegative(),
  seats: z.object({ taken: z.number().int().nonnegative(), max: z.number().int().positive() }),
});
export type LeavePartyResponse = z.infer<typeof leavePartyResponseSchema>;

/**
 * On `party:events` when a seat is taken or given up: the lobby room broadcasts the new count (MSG.seats),
 * and on a leave also closes the leaver's connections and drops their presence.
 */
export interface SeatsChangedEvent { partyId: string; status: "player_joined" | "player_left"; userId: string; seats: { taken: number; max: number } }

/** Who cancelled a party: its host, an admin (logged in admin_actions), or the system (start job, failed set, lost room). */
export const CANCELLED_BY = ["host", "admin", "system"] as const;
export type CancelledBy = (typeof CANCELLED_BY)[number];

/** What everyone in the room, and the party chat, is told when the host cancels. No wallet line when nobody paid. */
export const hostCancelMessage = (p: { entryKobo: number }) =>
  p.entryKobo > 0 ? "The host cancelled this party. Your entry is back in your wallet." : "The host cancelled this party.";

/**
 * On `party:events` when a party is cancelled. `by` and `message` are set for a host's cancel: the room
 * shows the message (MSG.phase { phase: "cancelled", by, message }) and closes with HOST_CANCELLED_CLOSE_CODE.
 */
export interface PartyCancelledEvent { partyId: string; status: "cancelled"; by?: CancelledBy; message?: string }

/** POST /parties/:id/cancel: an optional reason, kept on the party and never shown publicly. */
export const hostCancelSchema = z.object({ reason: z.string().trim().min(1).max(200).optional() });

/** POST /parties/:id/cancel → 200. A retry gets the same result with replayed: true. */
export const hostCancelResponseSchema = z.object({
  cancelled: z.literal(true),
  replayed: z.boolean(),
  /** What went back: to how many seats, split by where it came from, and the host's cash prize released to them. */
  refunded: z.object({
    seats: z.number().int().nonnegative(),
    toBonusKobo: z.number().int().nonnegative(),
    toCashKobo: z.number().int().nonnegative(),
    prizeReleasedKobo: z.number().int().nonnegative(),
  }),
});
export type HostCancelResponse = z.infer<typeof hostCancelResponseSchema>;

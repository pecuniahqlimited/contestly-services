/**
 * Leaving a party (POST /parties/:id/leave). The rules live here so the server enforces them and the app
 * explains them the same way: a seated player who isn't the host may leave while the party is open and
 * more than PARTY_LEAVE_LOCK_SECONDS before it starts, and gets their whole entry back, leg by leg.
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

/** On `party:events` when a player leaves: the lobby room drops their presence and shows the new seat count. */
export interface PlayerLeftEvent { partyId: string; status: "player_left"; userId: string; seats: { taken: number; max: number } }

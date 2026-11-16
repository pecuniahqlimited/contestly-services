/**
 * One room per key (a party), across every realtime process. Colyseus's joinOrCreate waits at most 500 ms for a
 * room another request is creating; a room whose setup reads the database takes longer under load, so a crowd
 * arriving together created a room each and split the party into separate games (found by the load test, Nov
 * 2026). A room claims its key in Valkey before setting up; a room that loses the claim stands in: locked and
 * seatless, so Colyseus refuses its seat and retries the join (SeatReservationError), which finds the claimant.
 */
import type { makeRedis } from "@contestly/queue";

/** A claim outlives a crashed process by at most this; the claimant refreshes it well inside. */
export const CLAIM_TTL_MS = 60_000;
export const CLAIM_REFRESH_MS = 20_000;

export interface RoomClaims {
  /** True if `owner` now holds `key` (it was free). */
  claim(key: string, owner: string, ttlMs: number): Promise<boolean>;
  /** Extends the claim if `owner` still holds it; false if it was lost. */
  refresh(key: string, owner: string, ttlMs: number): Promise<boolean>;
  /** Frees the claim if `owner` holds it; never someone else's. */
  release(key: string, owner: string): Promise<void>;
}

const IF_OWNER_PEXPIRE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;
const IF_OWNER_DEL = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/** Claims in Valkey, shared by every realtime process. */
export function redisClaims(redis: ReturnType<typeof makeRedis>): RoomClaims {
  return {
    claim: async (key, owner, ttlMs) => (await redis.set(key, owner, "PX", ttlMs, "NX")) === "OK",
    refresh: async (key, owner, ttlMs) => Number(await redis.eval(IF_OWNER_PEXPIRE, 1, key, owner, String(ttlMs))) === 1,
    release: async (key, owner) => void (await redis.eval(IF_OWNER_DEL, 1, key, owner)),
  };
}

/** Claims in this process only: tests, and a single process without Valkey. Expiry isn't modelled. */
export function memoryClaims(): RoomClaims {
  const held = new Map<string, string>();
  return {
    claim: async (key, owner) => (held.has(key) ? false : (held.set(key, owner), true)),
    refresh: async (key, owner) => held.get(key) === owner,
    release: async (key, owner) => void (held.get(key) === owner && held.delete(key)),
  };
}

let store: RoomClaims | null = null;
/** Set once at startup (index.ts), before any room is created. */
export const useRoomClaims = (claims: RoomClaims) => void (store = claims);
export function roomClaims(): RoomClaims {
  if (!store) throw new Error("room claims not configured: call useRoomClaims() at startup");
  return store;
}

export const partyRoomClaimKey = (partyId: string) => `party:room-claim:${partyId}`;

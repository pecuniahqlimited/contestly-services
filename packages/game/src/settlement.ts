/**
 * Pot settlement, pure math. The worker posts the result through the ledger; nothing here does I/O.
 *
 * Rules (rake %, host cut and split are config, never hard-coded):
 * - Pooled pots: rake is taken once, then the host cut, then the split by rank.
 * - Host-funded pots are never raked and carry no host cut (the host funded the prize).
 * - Shares are floored (placeShares in shared, the same math every preview uses); the rounding remainder and
 *   any share whose rank has no player go to 1st, so the prizes always sum to exactly the prize pool.
 * - Goods are never money: goodsAwards() names who wins each place, and the worker records a fulfilment for each.
 */
import { afterRake, placeShares } from "@contestly/shared";

const BPS = 10_000;

export interface SettlementConfig {
  rakeBps: number;
  hostCutBps: number;
}

export interface SettlementInput {
  funding: "pooled" | "host";
  entryKobo: number;
  playerCount: number;
  hostPoolKobo: number;
  /** Percentages by rank, summing to 100. */
  split: number[];
  /** userIds by final rank, best first. */
  ranked: string[];
}

export interface Prize {
  userId: string;
  rank: number;
  amountKobo: number;
}

export interface Settlement {
  potKobo: number;
  rakeKobo: number;
  hostCutKobo: number;
  prizePoolKobo: number;
  prizes: Prize[];
}

export function computeSettlement(input: SettlementInput, cfg: SettlementConfig): Settlement {
  if (!input.ranked.length) throw new Error("cannot settle with no ranked players");
  const pooled = input.funding === "pooled";
  const potKobo = pooled ? input.entryKobo * input.playerCount : input.hostPoolKobo;
  const rakeKobo = pooled ? Math.floor((potKobo * cfg.rakeBps) / BPS) : 0;
  const hostCutKobo = pooled ? Math.floor((potKobo * cfg.hostCutBps) / BPS) : 0;
  const prizePoolKobo = pooled ? afterRake(potKobo, cfg) : potKobo;

  // A place nobody finished in sends its share to 1st, so the prizes always sum to the pool.
  const shares = placeShares(prizePoolKobo, input.split);
  const prizes: Prize[] = input.ranked.slice(0, shares.length).map((userId, i) => ({ userId, rank: i + 1, amountKobo: shares[i] }));
  prizes[0].amountKobo += shares.slice(prizes.length).reduce((a, b) => a + b, 0);

  return { potKobo, rakeKobo, hostCutKobo, prizePoolKobo, prizes };
}

/** Goods: each winning place someone finished in goes to them; a place nobody reached isn't awarded. */
export const goodsAwards = (ranked: string[], placeCount: number) =>
  ranked.slice(0, placeCount).map((userId, i) => ({ userId, place: i + 1 }));

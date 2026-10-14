/**
 * Pot settlement, pure math. The worker posts the result through the ledger; nothing here does I/O.
 *
 * Rules (rake %, host cut and split are config, never hard-coded):
 * - Pooled pots: rake is taken once, then the host cut, then the split by rank.
 * - Host-funded pots are never raked and carry no host cut (the host funded the prize).
 * - Shares are floored; the rounding remainder and any share whose rank has no player go to 1st,
 *   so the prizes always sum to exactly the prize pool.
 */
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
  const rakeKobo = pooled ? Math.floor((potKobo * cfg.rakeBps) / 10_000) : 0;
  const hostCutKobo = pooled ? Math.floor((potKobo * cfg.hostCutBps) / 10_000) : 0;
  const prizePoolKobo = potKobo - rakeKobo - hostCutKobo;

  const prizes: Prize[] = [];
  let assigned = 0;
  for (let i = 0; i < input.split.length && i < input.ranked.length; i++) {
    const amountKobo = Math.floor((prizePoolKobo * input.split[i]) / 100);
    prizes.push({ userId: input.ranked[i], rank: i + 1, amountKobo });
    assigned += amountKobo;
  }
  // Rounding remainder + shares for ranks nobody filled → 1st place.
  prizes[0].amountKobo += prizePoolKobo - assigned;

  return { potKobo, rakeKobo, hostCutKobo, prizePoolKobo, prizes };
}

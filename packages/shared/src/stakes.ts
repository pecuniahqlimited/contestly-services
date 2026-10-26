/**
 * Stakes: the prize splits, the admin's party limits, and the one check every new party's stakes pass.
 * The API enforces checkStakes(); the app runs the same function only to explain what's wrong before Next.
 */
import { z } from "zod";

const KOBO_PER_NAIRA = 100;
const toKobo = (naira: number) => naira * KOBO_PER_NAIRA;
const BPS = 10_000;
const PERCENT = 100;

/**
 * The splits a prize can be shared by, best place first. A cash prize shows the percentages; goods show how many
 * places win. A split needs at least one more seat than it has winners, so nobody is guaranteed a prize.
 */
export const SPLITS = {
  winner: { shares: [100], cashLabel: "Winner takes all", goodsLabel: "Winner only" },
  "70_30": { shares: [70, 30], cashLabel: "70 / 30", goodsLabel: "Top 2" },
  "60_30_10": { shares: [60, 30, 10], cashLabel: "60 / 30 / 10", goodsLabel: "Top 3" },
} as const satisfies Record<string, { shares: readonly number[]; cashLabel: string; goodsLabel: string }>;
export const SPLIT_IDS = Object.keys(SPLITS) as (keyof typeof SPLITS)[];
export type SplitId = keyof typeof SPLITS;
export const MAX_WINNERS = Math.max(...SPLIT_IDS.map((id) => SPLITS[id].shares.length));
export const winnersOf = (id: SplitId) => SPLITS[id].shares.length;
export const seatsNeededFor = (id: SplitId) => winnersOf(id) + 1;
/** The split id a party's stored shares match, or null for a party made before splits were a fixed list. */
export const splitIdOf = (shares: readonly number[]): SplitId | null => SPLIT_IDS.find((id) => SPLITS[id].shares.join() === shares.join()) ?? null;

/** What a party's winners get. Pooled parties are always cash; product and experience need a verified brand. */
export const PRIZE_KINDS = ["cash", "product", "experience"] as const;
export type PrizeKind = (typeof PRIZE_KINDS)[number];
export const isGoods = (kind: PrizeKind) => kind !== "cash";

/** Quick picks shown to hosts, at most this many of each. */
export const MAX_QUICK_PICKS = 5;
const MIN_SEATS = 2;

/**
 * The admin's limits on stakes, in app_config "party". New parties are checked against the current limits and keep a
 * copy of them; changing the limits never touches a party that already exists.
 */
export const partyLimitsSchema = z.object({
  entryMinKobo: z.number().int().positive(),
  entryMaxKobo: z.number().int().positive(),
  seatsMin: z.number().int().min(MIN_SEATS),
  seatsMax: z.number().int().min(MIN_SEATS),
  hostPrizeMinKobo: z.number().int().positive(),
  hostPrizeMaxKobo: z.number().int().positive(),
  /** A pick outside its range is kept but hidden from hosts. */
  entryPicksKobo: z.array(z.number().int().positive()).max(MAX_QUICK_PICKS),
  seatPicks: z.array(z.number().int().min(MIN_SEATS)).max(MAX_QUICK_PICKS),
  splits: z.array(z.enum(SPLIT_IDS as [SplitId, ...SplitId[]])).min(1),
}).refine((l) => l.entryMinKobo <= l.entryMaxKobo, { message: "the lowest entry is above the highest", path: ["entryMinKobo"] })
  .refine((l) => l.seatsMin <= l.seatsMax, { message: "the fewest seats is above the most", path: ["seatsMin"] })
  .refine((l) => l.hostPrizeMinKobo <= l.hostPrizeMaxKobo, { message: "the smallest prize is above the biggest", path: ["hostPrizeMinKobo"] })
  .refine((l) => new Set(l.splits).size === l.splits.length, { message: "a split is listed twice", path: ["splits"] });
export type PartyLimits = z.infer<typeof partyLimitsSchema>;
export const DEFAULT_PARTY_LIMITS: PartyLimits = {
  entryMinKobo: toKobo(50),
  entryMaxKobo: toKobo(10_000),
  seatsMin: 2,
  seatsMax: 200,
  hostPrizeMinKobo: toKobo(500),
  hostPrizeMaxKobo: toKobo(500_000),
  entryPicksKobo: [100, 200, 500, 1_000, 2_000].map(toKobo),
  seatPicks: [4, 6, 10, 20, 50],
  splits: ["winner", "70_30", "60_30_10"],
};

/** The limits as hosts see them: quick picks outside their range dropped. */
export const visibleLimits = (l: PartyLimits): PartyLimits => ({
  ...l,
  entryPicksKobo: l.entryPicksKobo.filter((v) => v >= l.entryMinKobo && v <= l.entryMaxKobo),
  seatPicks: l.seatPicks.filter((v) => v >= l.seatsMin && v <= l.seatsMax),
});

/** One winning place's goods prize: what it is and, optionally, roughly what it's worth. Informational: no money moves. */
export const MIN_PRIZE_TEXT = 3;
export const MAX_PRIZE_TEXT = 120;
export const MAX_PRIZE_VALUE_KOBO = toKobo(10_000_000);
export const goodsPlaceSchema = z.object({
  text: z.string().trim().min(MIN_PRIZE_TEXT).max(MAX_PRIZE_TEXT),
  valueKobo: z.number().int().positive().max(MAX_PRIZE_VALUE_KOBO).optional(),
});
export type GoodsPlace = z.infer<typeof goodsPlaceSchema>;

/** The stakes part of a new party, as checkStakes reads it. */
export type StakesInput = {
  funding: "pooled" | "host";
  entryKobo: number;
  maxPlayers: number;
  split: SplitId;
  prizeKind: PrizeKind;
  hostPoolKobo: number;
  places: { text: string; valueKobo?: number }[];
};

/** Why stakes are refused, in the order the Stakes scene shows its fields. */
export const STAKES_ERRORS = [
  "entry_out_of_range",
  "prize_needs_verified_brand",
  "host_prize_out_of_range",
  "prizes_incomplete",
  "seats_out_of_range",
  "split_not_allowed",
  "split_needs_seats",
] as const;
export type StakesError = (typeof STAKES_ERRORS)[number];

const within = (v: number, min: number, max: number) => v >= min && v <= max;

/**
 * Every rule a new party's stakes must meet, against the current limits. A pooled party with entry 0 is free:
 * nothing to win but bragging rights, open to anyone, guests included. `canOfferGoods` comes from
 * canOfferNonCashPrize() on the server. Returns the errors in STAKES_ERRORS order; none means the stakes hold.
 */
export function checkStakes(s: StakesInput, limits: PartyLimits, canOfferGoods: boolean): StakesError[] {
  const errors = new Set<StakesError>();
  const goods = s.funding === "host" && isGoods(s.prizeKind);
  // A free party has nothing to split, so its split is ignored: any split, and no extra seat needed.
  const free = s.funding === "pooled" && s.entryKobo === 0;
  // Entry 0 is a free party, played for bragging rights; the limits only bound an entry that's charged.
  if (s.funding === "pooled" && s.entryKobo > 0 && !within(s.entryKobo, limits.entryMinKobo, limits.entryMaxKobo)) errors.add("entry_out_of_range");
  if (goods && !canOfferGoods) errors.add("prize_needs_verified_brand");
  if (s.funding === "host" && !goods && !within(s.hostPoolKobo, limits.hostPrizeMinKobo, limits.hostPrizeMaxKobo)) errors.add("host_prize_out_of_range");
  if (goods && (s.places.length !== winnersOf(s.split) || s.places.some((p) => p.text.trim().length < MIN_PRIZE_TEXT))) errors.add("prizes_incomplete");
  if (!within(s.maxPlayers, limits.seatsMin, limits.seatsMax)) errors.add("seats_out_of_range");
  if (!free && !limits.splits.includes(s.split)) errors.add("split_not_allowed");
  if (!free && s.maxPlayers < seatsNeededFor(s.split)) errors.add("split_needs_seats");
  return STAKES_ERRORS.filter((e) => errors.has(e));
}

/** The money side of party config that the stakes math reads. */
export type RakeConfig = { rakeBps: number; hostCutBps: number };

/** What a pooled pot's winners share once the rake and the host cut are taken (once each). */
export const afterRake = (potKobo: number, cfg: RakeConfig) =>
  potKobo - Math.floor((potKobo * cfg.rakeBps) / BPS) - Math.floor((potKobo * cfg.hostCutBps) / BPS);

/**
 * A prize pool cut by place: each share floored, the rounding remainder to 1st, so the places always sum to the pool.
 * Settlement and every preview of it use this.
 */
export function placeShares(poolKobo: number, shares: readonly number[]): number[] {
  const amounts = shares.map((pct) => Math.floor((poolKobo * pct) / PERCENT));
  amounts[0] += poolKobo - amounts.reduce((a, b) => a + b, 0);
  return amounts;
}

/** A rake in basis points as people read it: 1000 → "10%". */
export const rakePercent = (bps: number) => `${(bps * PERCENT) / BPS}%`;

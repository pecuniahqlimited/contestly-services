/** What each winning place of a party gets, as cards, detail and the join sheet show it. Pure: settlement's own math. */
import { afterRake, isGoods, placeShares, type PlacePrize, type RakeConfig } from "@contestly/shared";
import type { Party, PartyPrize } from "@contestly/db";

type PlacesParty = Pick<Party, "funding" | "prizeKind" | "entryKobo" | "hostPoolKobo" | "split">;

/** The pot before the rake: a pooled party's entries so far, or the host's cash prize. */
export const potKobo = (p: Pick<Party, "funding" | "hostPoolKobo" | "entryKobo">, players: number) => (p.funding === "host" ? p.hostPoolKobo : p.entryKobo * players);

/**
 * Cash: each place's share, of the pooled pot right now after the rake (it grows with every seat), or of the host's
 * prize (never raked). Goods: each place's prize as the host described it.
 */
export function placesOf(p: PlacesParty, players: number, cfg: RakeConfig, goods: Pick<PartyPrize, "place" | "text" | "valueKobo">[]): PlacePrize[] {
  if (isGoods(p.prizeKind)) {
    return [...goods].sort((a, b) => a.place - b.place).map((g) => ({ place: g.place, amountKobo: null, text: g.text, valueKobo: g.valueKobo }));
  }
  const pool = p.funding === "pooled" ? afterRake(potKobo(p, players), cfg) : p.hostPoolKobo;
  return placeShares(pool, p.split).map((amountKobo, i) => ({ place: i + 1, amountKobo, text: null, valueKobo: null }));
}

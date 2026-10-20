/** Party cards: the public row, its host, head count, pot, each place's prize, and the people in it. A few queries for a whole list. */
import { asc, eq, inArray } from "drizzle-orm";
import { db, getPartyConfig, partyPlayers, partyPrizes, publicHosts, users, type Party, type PartyPrize } from "@contestly/db";
import type { Person } from "@contestly/shared";
import { publicParty } from "./partyView.js";
import { placesOf, potKobo } from "./places.js";
import { followedBy, personColumns } from "./people.js";
import { pickPartyPeople } from "./social.js";

export async function partySummaries(list: Party[], viewerId?: string) {
  if (!list.length) return [];
  const ids = list.map((p) => p.id);
  const [hosts, seated, goods, cfg] = await Promise.all([
    publicHosts(list),
    db.select({ partyId: partyPlayers.partyId, ...personColumns }).from(partyPlayers).innerJoin(users, eq(users.id, partyPlayers.userId))
      .where(inArray(partyPlayers.partyId, ids)).orderBy(asc(partyPlayers.joinedAt)),
    db.select().from(partyPrizes).where(inArray(partyPrizes.partyId, ids)),
    getPartyConfig(),
  ]);
  const goodsOf = new Map<string, PartyPrize[]>();
  for (const g of goods) goodsOf.set(g.partyId, [...(goodsOf.get(g.partyId) ?? []), g]);
  const following = await followedBy(viewerId, [...new Set(seated.map((s) => s.id))]);
  const playersOf = new Map<string, Person[]>();
  for (const { partyId, ...person } of seated) playersOf.set(partyId, [...(playersOf.get(partyId) ?? []), person]);
  return list.map((p) => {
    const players = playersOf.get(p.id) ?? [];
    const host = hosts.get(p.id)!;
    return {
      ...publicParty(p), host, playerCount: players.length, potKobo: potKobo(p, players.length),
      places: placesOf(p, players.length, cfg, goodsOf.get(p.id) ?? []), ...pickPartyPeople(players, host.id, following, viewerId),
    };
  });
}

export type PartySummaryView = Awaited<ReturnType<typeof partySummaries>>[number];

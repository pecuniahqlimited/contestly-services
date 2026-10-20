/** Party cards: the public row, its host, head count, pot, and the people in it. A few queries for a whole list. */
import { asc, eq, inArray } from "drizzle-orm";
import { db, partyPlayers, publicHosts, users, type Party } from "@contestly/db";
import type { Person } from "@contestly/shared";
import { publicParty } from "./partyView.js";
import { followedBy, personColumns } from "./people.js";
import { pickPartyPeople } from "./social.js";

export const potKobo = (p: { funding: string; hostPoolKobo: number; entryKobo: number }, players: number) => (p.funding === "host" ? p.hostPoolKobo : p.entryKobo * players);

export async function partySummaries(list: Party[], viewerId?: string) {
  if (!list.length) return [];
  const [hosts, seated] = await Promise.all([
    publicHosts(list),
    db.select({ partyId: partyPlayers.partyId, ...personColumns }).from(partyPlayers).innerJoin(users, eq(users.id, partyPlayers.userId))
      .where(inArray(partyPlayers.partyId, list.map((p) => p.id))).orderBy(asc(partyPlayers.joinedAt)),
  ]);
  const following = await followedBy(viewerId, [...new Set(seated.map((s) => s.id))]);
  const playersOf = new Map<string, Person[]>();
  for (const { partyId, ...person } of seated) playersOf.set(partyId, [...(playersOf.get(partyId) ?? []), person]);
  return list.map((p) => {
    const players = playersOf.get(p.id) ?? [];
    const host = hosts.get(p.id)!;
    return { ...publicParty(p), host, playerCount: players.length, potKobo: potKobo(p, players.length), ...pickPartyPeople(players, host.id, following, viewerId) };
  });
}

export type PartySummaryView = Awaited<ReturnType<typeof partySummaries>>[number];

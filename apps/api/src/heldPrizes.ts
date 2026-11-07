/** The admin's queue of held template prizes (ADR 0015): each one with its evidence, as the console shows it. */
import { desc, eq, inArray } from "drizzle-orm";
import { db, heldPrizes, parties, users, type HeldPrize, type User } from "@contestly/db";
import type { AdminHeldPrize, HeldPrizeStatus } from "@contestly/shared";
import { toPerson } from "./people.js";

async function views(rows: HeldPrize[]): Promise<AdminHeldPrize[]> {
  if (!rows.length) return [];
  const ids = [...new Set(rows.flatMap((r) => [r.userId, r.hostUserId, ...[r.decidedByUserId, r.requestedByUserId].filter((x): x is string => !!x)]))];
  const [people, partyRows] = await Promise.all([
    db.select().from(users).where(inArray(users.id, ids)),
    db.select({ id: parties.id, title: parties.title, funding: parties.funding, endedAt: parties.endedAt }).from(parties).where(inArray(parties.id, [...new Set(rows.map((r) => r.partyId))])),
  ]);
  const person = new Map<string, User>(people.map((u) => [u.id, u]));
  const party = new Map(partyRows.map((p) => [p.id, p]));
  return rows.map((r) => {
    const p = party.get(r.partyId)!;
    return {
      id: r.id, party: { id: p.id, title: p.title, funding: p.funding, endedAt: p.endedAt?.toISOString() ?? null },
      winner: toPerson(person.get(r.userId)!), host: toPerson(person.get(r.hostUserId)!), place: r.place, amountKobo: r.amountKobo,
      status: r.status, evidence: r.evidence,
      request: r.requestedDecision && r.requestedByUserId && r.requestedAt
        ? { decision: r.requestedDecision, by: toPerson(person.get(r.requestedByUserId)!), reason: r.requestReason ?? "", at: r.requestedAt.toISOString() } : null,
      decidedBy: r.decidedByUserId ? toPerson(person.get(r.decidedByUserId)!) : null,
      reason: r.reason, decidedAt: r.decidedAt?.toISOString() ?? null, outcome: r.outcome ?? null, createdAt: r.createdAt.toISOString(),
    };
  });
}

/** Held prizes, newest first; held ones by default is the console's call (it passes ?status=held). */
export async function listHeldPrizes(filter: { status?: HeldPrizeStatus; limit: number }) {
  const rows = await db.select().from(heldPrizes).where(filter.status ? eq(heldPrizes.status, filter.status) : undefined).orderBy(desc(heldPrizes.createdAt)).limit(filter.limit);
  return views(rows);
}

export const heldPrizeView = async (row: HeldPrize) => (await views([row]))[0];

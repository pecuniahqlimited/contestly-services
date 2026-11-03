/**
 * A kind's check when its nudge is due: is it still true for this person? "withdraw" when the thing it was
 * about is gone (the party was cancelled, they left it), a skip reason when it's simply not needed now, null to
 * go on. A kind without a check always goes on.
 */
import { and, eq, gt, lte, or, sql } from "drizzle-orm";
import type { NudgeData, NudgeKind, NudgeSkipReason } from "@contestly/shared";
import { db } from "../client.js";
import { parties, partyPlayers, type NudgeRow, type Party } from "../schema.js";

export interface CheckDeps {
  /** Connected to the party's room right now (the realtime process keeps partyHereKey). */
  inPartyRoom(partyId: string, userId: string): Promise<boolean>;
}
type Verdict = "withdraw" | NudgeSkipReason | null;
type Check = (row: NudgeRow, deps: CheckDeps) => Promise<Verdict>;

const partyOf = async (id: string): Promise<Party | undefined> => (await db.select().from(parties).where(eq(parties.id, id)))[0];
const seated = async (partyId: string, userId: string) =>
  (await db.select({ u: partyPlayers.userId }).from(partyPlayers).where(and(eq(partyPlayers.partyId, partyId), eq(partyPlayers.userId, userId)))).length > 0;
const dataOf = <K extends NudgeKind>(row: NudgeRow) => row.data as NudgeData[K];

/** Seated in, or hosting, an open party starting within the hour (other than this one). */
async function hasPartySoon(userId: string, exceptPartyId: string, now = new Date()): Promise<boolean> {
  const soon = new Date(now.getTime() + 60 * 60_000);
  const [row] = await db.select({ id: parties.id }).from(parties)
    .where(and(
      eq(parties.status, "open"), gt(parties.startsAt, now), lte(parties.startsAt, soon), sql`${parties.id} <> ${exceptPartyId}`,
      or(eq(parties.createdByUserId, userId), sql`exists (select 1 from ${partyPlayers} pp where pp.party_id = ${parties.id} and pp.user_id = ${userId})`),
    )).limit(1);
  return !!row;
}

/** The party must still be open (a cancel withdraws it). */
const whileOpen: Check = async (row) => ((await partyOf(dataOf<"people_joined">(row).partyId))?.status === "open" ? null : "withdraw");

export const nudgeChecks: Partial<Record<NudgeKind, Check>> = {
  /** Still open, still theirs (seated or hosting), and they aren't in the room already. */
  party_starting: async (row, deps) => {
    const { partyId } = dataOf<"party_starting">(row);
    const p = await partyOf(partyId);
    if (!p || p.status !== "open") return "withdraw";
    if (p.createdByUserId !== row.userId && !(await seated(partyId, row.userId))) return "withdraw";
    return (await deps.inPartyRoom(partyId, row.userId)) ? "not_needed" : null;
  },
  /** Still live, still seated, and not in the room. A party that ended in the meantime: not needed. */
  party_live: async (row, deps) => {
    const { partyId } = dataOf<"party_live">(row);
    const p = await partyOf(partyId);
    if (!p || p.status === "cancelled") return "withdraw";
    if (p.status !== "live") return "not_needed";
    if (!(await seated(partyId, row.userId))) return "withdraw";
    return (await deps.inPartyRoom(partyId, row.userId)) ? "not_needed" : null;
  },
  people_joined: whileOpen,
  corner_party: whileOpen,
  /** Still open, they haven't joined it, and they don't have another party within the hour. */
  party_filling: async (row) => {
    const { partyId } = dataOf<"party_filling">(row);
    const p = await partyOf(partyId);
    if (!p || p.status !== "open") return "withdraw";
    if (await seated(partyId, row.userId)) return "not_needed";
    return (await hasPartySoon(row.userId, partyId)) ? "not_needed" : null;
  },
};

/**
 * Settling a finished party: the one settle path, run by the worker's settle job (queued by the room once
 * it has written the final ranks) and by the stall check when a room died after the last question
 * (partyStart.ts writes the ranks from the recorded answers first). Locked on the party row and a no-op
 * unless the party is still live, with every ledger post keyed per party, so two at once pay once.
 * What it tells the outside world is passed in.
 */
import { and, asc, eq } from "drizzle-orm";
import { cancelIfUnplaceable, db, getPartyConfig, lockPeopleRows, payCashPrizes, ledger, parties, partyLifecycleLine, partyLineByKey, partyPlayers, partyPrizes, prizeFulfilments, publicHostId, recordPartyFinish, users } from "@contestly/db";
import { isGoods, type ChatMessage } from "@contestly/shared";
import { computeSettlement, goodsAwards } from "@contestly/game";

export interface SettleDeps {
  emit(ev: { partyId: string; status: string }): Promise<unknown>;
  publishLine(line: ChatMessage): Promise<unknown>;
  /** Fold the party's answer stats into the question bank (the questions service's record_play), under a fixed job id. */
  queueRecordPlay(partyId: string, jobId: string): Promise<unknown>;
  /** Who played whom and the host's corner progress (record_progress, ADR 0012), under a fixed job id. */
  queueRecordProgress(partyId: string, jobId: string): Promise<unknown>;
}

export const recordPlayJobId = (partyId: string) => `record-play-${partyId}`;
export const recordProgressJobId = (partyId: string) => `record-progress-${partyId}`;

/**
 * Settle a finished round: rake taken once, pot split via the ledger with idempotency keys,
 * goods become one fulfilment record per winning place, party → finished with ranks. A replay moves no
 * money; it finds the party finished (or cancelled as unplaceable) and sends what the first run may not have
 * got to after its commit: the event, the chat line, record_play and record_progress. True only for the run that settled.
 */
export async function settle(deps: SettleDeps, partyId: string): Promise<boolean> {
  const cfg = await getPartyConfig();
  let line: ChatMessage | undefined;
  // What the room hears, published only once the transaction has committed (never a state that rolled back).
  let event: { partyId: string; status: "finished" | "cancelled" } | undefined;
  let replayedFinish = false;
  const settled = await db.transaction(async (tx) => {
    // ADR 0013's lock order: the people money reaches (the seated players and the host, for a prize or the host
    // cut) before the party row, so a withdrawal of theirs runs wholly before or after this settle. Seats don't
    // change once a party is live; a seat that did would be caught below and the job retried.
    const seatedNow = (await tx.select({ userId: partyPlayers.userId }).from(partyPlayers).where(eq(partyPlayers.partyId, partyId))).map((s) => s.userId);
    const [pre] = await tx.select({ createdByUserId: parties.createdByUserId, brandId: parties.brandId }).from(parties).where(eq(parties.id, partyId));
    // The host cut goes to the public host's account (a brand's, ADR 0017); the creator is locked too, as before.
    const locked = new Set(pre ? [pre.createdByUserId, publicHostId(pre), ...seatedNow] : seatedNow);
    if (locked.size) await lockPeopleRows(tx, [...locked]);
    const [p] = await tx.select().from(parties).where(eq(parties.id, partyId)).for("update");
    if (p?.status === "finished") {
      line = (await partyLineByKey(tx, partyId, "finished")) ?? undefined;
      event = { partyId, status: "finished" };
      replayedFinish = true;
      return false;
    }
    if (p?.status === "cancelled" && p.cancelledBy === "system" && p.liveAt) {
      // Cancelled after going live by the system (here as unplaceable, or a refund job): announce it again.
      line = (await partyLineByKey(tx, partyId, "cancelled")) ?? undefined;
      event = { partyId, status: "cancelled" };
      return false;
    }
    if (!p || p.status !== "live") return false; // cancelled some other way
    const players = await tx.select({ userId: partyPlayers.userId, rank: partyPlayers.rank, isGuest: users.isGuest, bannedAt: users.bannedAt }).from(partyPlayers)
      .innerJoin(users, eq(users.id, partyPlayers.userId)).where(eq(partyPlayers.partyId, partyId)).orderBy(asc(partyPlayers.rank));
    if (!players.some((x) => x.rank !== null)) throw new Error(`settle ${partyId}: no ranks persisted yet`); // BullMQ retries
    // Prizes go by place among signed-up players in good standing: a guest (only free parties have them) or a
    // player banned mid-party keeps their rank on the board but can't win.
    const ranked = players.filter((x) => x.rank !== null && !x.isGuest && !x.bannedAt).map((x) => x.userId);

    if (isGoods(p.prizeKind)) {
      const prizes = await tx.select().from(partyPrizes).where(eq(partyPrizes.partyId, p.id));
      const prizeAt = new Map(prizes.map((g) => [g.place, g]));
      const awards = goodsAwards(ranked, prizes.length);
      for (const a of awards) {
        const g = prizeAt.get(a.place)!;
        await tx.insert(prizeFulfilments).values({ partyId: p.id, place: a.place, winnerUserId: a.userId, hostUserId: publicHostId(p), prizeText: g.text, prizeValueKobo: g.valueKobo }).onConflictDoNothing();
      }
      console.log(`[party] ${p.title}: ${awards.length} goods prize(s) awarded (one fulfilment record per place)`);
    } else if (!ranked.length) {
      // Nobody can be placed. A pot with money in it is never left there (ADR 0013): cancel as the system,
      // refund every seat as paid (banned players too: a ban's wallet freeze holds their money), logged.
      const out = await cancelIfUnplaceable(tx, p);
      if (out) {
        line = out.line;
        event = { partyId, status: "cancelled" };
        console.log(`[party] ${p.title}: nobody could be placed; cancelled, ${out.players} seat(s) refunded (${out.bannedSeats} banned)`);
        return false;
      }
      console.log(`[party] ${p.title}: only guests played, nothing to pay`);
    } else {
      const s = computeSettlement({ funding: p.funding, entryKobo: p.entryKobo, playerCount: players.length, hostPoolKobo: p.hostPoolKobo, split: p.split, ranked }, cfg);
      if (s.rakeKobo > 0) await ledger.post(tx, { userId: await ledger.treasuryUserId(tx), kind: "cash", amountKobo: s.rakeKobo, type: "party_rake", refType: "party", refId: p.id, idempotencyKey: `party_rake:${p.id}` });
      if (s.hostCutKobo > 0) await ledger.post(tx, { userId: publicHostId(p), kind: "cash", amountKobo: s.hostCutKobo, type: "party_host_cut", refType: "party", refId: p.id, idempotencyKey: `party_host_cut:${p.id}` });
      if (s.prizes.some((x) => !locked.has(x.userId))) throw new Error(`settle ${partyId}: a winner's row wasn't locked (seats changed); retrying`);
      // Each prize is decided, then paid: to cash, or (host-written questions, ADR 0015) a flagged winner's into
      // their prize hold for an admin, with a warning alert, in this transaction.
      const held = await payCashPrizes(tx, p, s.prizes.map((x) => ({ userId: x.userId, place: x.rank, amountKobo: x.amountKobo })));
      console.log(`[party] ${p.title} settled: pot ${s.potKobo}, rake ${s.rakeKobo}, host cut ${s.hostCutKobo}, ${s.prizes.length} prize(s)${held.length ? `, ${held.length} held for review` : ""}`);
    }

    const endedAt = new Date();
    await tx.update(parties).set({ status: "finished", endedAt }).where(eq(parties.id, partyId));
    // The feed hears every finish; a bragging-rights party also earns party points (ADR 0008). Who played whom
    // and the host's corner progress are record_progress's, after the commit: never a reason a settle fails.
    await recordPartyFinish(tx, p, players, endedAt);
    line = await partyLifecycleLine(tx, partyId, "finished", "That's a wrap! Results are in.");
    event = { partyId, status: "finished" };
    return true;
  });
  if (event) await deps.emit(event);
  if (line) await deps.publishLine(line);
  // Fold this party's answer stats back into the question bank (idempotent via play_stats_recorded_at and its job id).
  // Then who played whom and the host's corner progress (idempotent via progress_recorded_at and its job id).
  if (settled || replayedFinish) {
    await deps.queueRecordPlay(partyId, recordPlayJobId(partyId));
    await deps.queueRecordProgress(partyId, recordProgressJobId(partyId));
  }
  return settled;
}

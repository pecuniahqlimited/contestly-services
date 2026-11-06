/**
 * Held prizes (ADR 0015): the settlement check for parties with host-written questions and the admin's decision.
 *
 * At settlement every cash prize is paid as usual (party_prize). A winner who is linked to the host (one of their
 * people, or the same install or IP) and did far better than the room on the host's questions also gets a held_prizes
 * row, which blocks their withdrawals (withdrawBlockReason: prize_under_review, through payments' withdrawContext) and
 * keeps the prize in their cash (assertHeldPrizesKept), and a warning alert.
 *
 * Clear: the row is cleared; nothing moves. Reject (the rule in ADR 0015's implementation notes): the prize is taken
 * back into the party's pot, then passed to the best-placed eligible player without a prize (who goes through the
 * same check); with nobody to pass it to, a host's prize goes back to the host and a pooled one is refunded evenly to
 * the other seats (with nobody at all, it's forfeited to the treasury). Every movement is a ledger journal keyed by
 * the row (or by the party and the recipient, like settlement's own prize keys), and the row is locked, so a
 * replay moves nothing. Lock order (ADR 0013): the people's users rows, then the party and the held row, then the ledger.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { evenShares, nextPlaced, reviewPrize, type GradedAnswer } from "@contestly/game";
import { DEFAULT_HOST_WRITTEN_RULES, OWN_TRANSACTION, PRIZE_LINK_KINDS, type HeldPrizeOutcome, type PrizeLinkKind } from "@contestly/shared";
import type { Tx } from "../client.js";
import { blocks, contactMatches, crewMembers, crews, heldPrizes, parties, partyAnswers, partyPlayers, partyQuestions, playedWith, userSignals, users, type HeldPrize, type Party } from "../schema.js";
import { adminAlert } from "../alerts.js";
import { recordAdminAction } from "../admin.js";
import { moneyTransaction } from "../retry.js";
import { getPaymentsConfig, getSocialConfig } from "../config.js";
import * as ledger from "../ledger.js";

export const HELD_PRIZE_ALERT_KIND = "templates.prize_held";
const DAY_MS = 86_400_000;
const httpError = (statusCode: number, code: string, details?: Record<string, unknown>) => Object.assign(new Error(code), { statusCode, ...(details ? { details } : {}) });

/**
 * How `userId` is linked to the host, from the raw relationships rather than yourPeople() (which drops blocked
 * pairs, so a host could block a friend to dodge it): crew mates in a live crew, contacts either way, played
 * together within yourPeopleDays before the party, a block either way made in the `recentBlockDays` before the
 * party (or since), and an install id or IP seen on both accounts.
 */
async function linksToHost(tx: Tx, p: Party, userId: string, recentBlockDays: number): Promise<PrizeLinkKind[]> {
  const hostId = p.createdByUserId;
  const partyAt = p.liveAt ?? p.startsAt;
  const { yourPeopleDays } = await getSocialConfig(tx);
  const playedSince = new Date(partyAt.getTime() - yourPeopleDays * DAY_MS);
  const blockedSince = new Date(partyAt.getTime() - recentBlockDays * DAY_MS);
  const [row] = await tx.execute(sql`
    select
      exists(select 1 from ${crewMembers} a join ${crewMembers} b on b.crew_id = a.crew_id join ${crews} c on c.id = a.crew_id and c.archived_at is null
        where a.user_id = ${hostId} and b.user_id = ${userId}) as crew,
      exists(select 1 from ${contactMatches} where (user_id = ${hostId} and contact_user_id = ${userId}) or (user_id = ${userId} and contact_user_id = ${hostId})) as contact,
      exists(select 1 from ${playedWith} where user_a = least(${hostId}::uuid, ${userId}::uuid) and user_b = greatest(${hostId}::uuid, ${userId}::uuid)
        and last_played_at >= ${playedSince.toISOString()}::timestamptz) as played_with,
      exists(select 1 from ${blocks} where ((blocker_id = ${hostId} and blocked_id = ${userId}) or (blocker_id = ${userId} and blocked_id = ${hostId}))
        and created_at >= ${blockedSince.toISOString()}::timestamptz) as recent_block,
      exists(select 1 from ${userSignals} a join ${userSignals} b on b.kind = a.kind and b.value = a.value
        where a.kind = 'install' and a.user_id = ${hostId} and b.user_id = ${userId}) as install,
      exists(select 1 from ${userSignals} a join ${userSignals} b on b.kind = a.kind and b.value = a.value
        where a.kind = 'ip' and a.user_id = ${hostId} and b.user_id = ${userId}) as ip`) as unknown as Record<PrizeLinkKind, boolean>[];
  return PRIZE_LINK_KINDS.filter((k) => row[k]);
}

/** Every seated player's graded answers on the party's played questions, marked host-written or not. */
async function gradedAnswers(tx: Tx, partyId: string): Promise<GradedAnswer[]> {
  const rows = await tx.select({ userId: partyAnswers.userId, hostWritten: partyQuestions.hostWritten, correctnessPct: partyAnswers.correctness })
    .from(partyAnswers).innerJoin(partyQuestions, eq(partyQuestions.id, partyAnswers.questionId))
    .where(and(eq(partyAnswers.partyId, partyId), eq(partyQuestions.status, "played")));
  return rows;
}

export interface CashPrize { userId: string; place: number; amountKobo: number }

/**
 * The check, in the settling (or rejecting) transaction: for a party with host-written questions, every cash prize
 * to a flagged winner is held (a row, and a warning alert that commits with it). Free parties never get here (they
 * pay no cash); goods aren't money. Returns the rows it held.
 */
export async function holdFlaggedPrizes(tx: Tx, p: Party, prizes: CashPrize[]): Promise<HeldPrize[]> {
  const paid = prizes.filter((x) => x.amountKobo > 0);
  if (p.hostQuestionCount <= 0 || !paid.length) return [];
  // Rules copied before recentBlockDays existed take its default.
  const rules = { ...DEFAULT_HOST_WRITTEN_RULES, ...p.hostRules };
  const hostId = p.createdByUserId;
  const answers = await gradedAnswers(tx, p.id);
  const held: HeldPrize[] = [];
  for (const prize of paid) {
    const links = await linksToHost(tx, p, prize.userId, rules.recentBlockDays);
    const review = reviewPrize({ winnerId: prize.userId, links, answers, marginPct: rules.outlierMarginPct });
    if (!review.flagged) continue;
    const [row] = await tx.insert(heldPrizes).values({ partyId: p.id, userId: prize.userId, hostUserId: hostId, place: prize.place, amountKobo: prize.amountKobo, evidence: review.evidence })
      .onConflictDoNothing().returning();
    if (!row) continue;
    held.push(row);
    await adminAlert({
      kind: HELD_PRIZE_ALERT_KIND, severity: "warning", subject: "A prize is held: a winner linked to the host beat the room on the host's own questions",
      dedupeKey: `prize_held:${row.id}`, refType: "party", refId: p.id,
      details: { heldPrizeId: row.id, partyId: p.id, winnerId: prize.userId, hostId, place: prize.place, amountKobo: prize.amountKobo, ...review.evidence },
    }, tx);
  }
  return held;
}

const lockUsers = (tx: Tx, ids: string[]) =>
  tx.select({ id: users.id }).from(users).where(inArray(users.id, [...new Set(ids)].sort())).orderBy(asc(users.id)).for("no key update");

async function lockHeld(tx: Tx, id: string) {
  const [row] = await tx.select().from(heldPrizes).where(eq(heldPrizes.id, id)).for("update");
  return row;
}

/** Neither the host nor the winner decides their own held prize (ADR 0013's own-transaction rule). */
function refuseOwn(row: HeldPrize, adminUserId: string) {
  if (adminUserId === row.userId || adminUserId === row.hostUserId) throw httpError(403, OWN_TRANSACTION);
}

export interface ClearOutcome { row: HeldPrize; replayed: boolean; awaitingSecondAdmin: boolean }

/**
 * An admin clears a held prize: the winner keeps it and may withdraw again (if nothing else holds them). Clearing
 * loosens a payments control, so ADR 0013's maker-checker applies: below `finalize.secondAdminThresholdKobo` one
 * admin clears; at or above it the first admin's clear is a request (the prize stays held) and a different admin's
 * clear confirms it. Neither may be the host or the winner. The same admin asking again is a replay. Logged.
 */
export async function clearHeldPrize(adminUserId: string, id: string, reason: string): Promise<ClearOutcome> {
  return moneyTransaction(async (tx) => {
    const [pre] = await tx.select({ userId: heldPrizes.userId }).from(heldPrizes).where(eq(heldPrizes.id, id));
    if (!pre) throw httpError(404, "not_found");
    await lockUsers(tx, [pre.userId]);
    const row = await lockHeld(tx, id);
    if (row.status === "cleared") return { row, replayed: true, awaitingSecondAdmin: false };
    if (row.status !== "held") throw httpError(409, "prize_already_decided", { status: row.status });
    refuseOwn(row, adminUserId);
    const now = new Date();
    const log = (action: string, after: Record<string, unknown>) => recordAdminAction(tx, { adminUserId, action, targetType: "held_prize", targetId: id, reason, before: { status: row.status, clearRequestedBy: row.clearRequestedByUserId }, after: { ...after, userId: row.userId, amountKobo: row.amountKobo } });
    const { secondAdminThresholdKobo } = (await getPaymentsConfig(tx)).finalize;
    if (row.amountKobo >= secondAdminThresholdKobo) {
      if (!row.clearRequestedByUserId) {
        const [asked] = await tx.update(heldPrizes).set({ clearRequestedByUserId: adminUserId, clearRequestReason: reason, clearRequestedAt: now }).where(eq(heldPrizes.id, id)).returning();
        await log("party_templates.held_prize_clear_requested", { status: "held", thresholdKobo: secondAdminThresholdKobo });
        return { row: asked, replayed: false, awaitingSecondAdmin: true };
      }
      if (row.clearRequestedByUserId === adminUserId) return { row, replayed: true, awaitingSecondAdmin: true };
    }
    const [done] = await tx.update(heldPrizes).set({ status: "cleared", decidedByUserId: adminUserId, reason, decidedAt: now }).where(eq(heldPrizes.id, id)).returning();
    await log("party_templates.held_prize_clear", { status: done.status, requestedBy: row.clearRequestedByUserId });
    return { row: done, replayed: false, awaitingSecondAdmin: false };
  }, { label: "held prize clear" });
}

interface RejectPlan { outcome: HeldPrizeOutcome; place: number | null }

/** Where a rejected prize goes, by the rule (read only; the caller re-plans under the locks). */
async function planReject(tx: Tx, held: HeldPrize, p: Party): Promise<RejectPlan> {
  const seats = await tx.select({ userId: partyPlayers.userId, rank: partyPlayers.rank, prizeKobo: partyPlayers.prizeKobo, isGuest: users.isGuest, bannedAt: users.bannedAt })
    .from(partyPlayers).innerJoin(users, eq(users.id, partyPlayers.userId)).where(eq(partyPlayers.partyId, p.id));
  const rejected = await tx.select({ userId: heldPrizes.userId }).from(heldPrizes).where(and(eq(heldPrizes.partyId, p.id), eq(heldPrizes.status, "rejected")));
  const excluded = new Set([held.userId, ...rejected.map((r) => r.userId)]);
  const paid = new Set(seats.filter((s) => (s.prizeKobo ?? 0) > 0).map((s) => s.userId));
  // The same eligibility as settlement: signed up and not banned.
  const next = nextPlaced(seats.map((s) => ({ userId: s.userId, rank: s.rank, eligible: !s.isGuest && !s.bannedAt })), paid, excluded);
  if (next) return { outcome: { kind: "passed_on", to: [{ userId: next, amountKobo: held.amountKobo }] }, place: seats.find((s) => s.userId === next)!.rank };
  if (p.funding === "host") return { outcome: { kind: "returned_to_host", to: [{ userId: p.createdByUserId, amountKobo: held.amountKobo }] }, place: null };
  const others = seats.filter((s) => !excluded.has(s.userId)).sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
  if (!others.length) return { outcome: { kind: "forfeited", to: [{ userId: await ledger.treasuryUserId(tx), amountKobo: held.amountKobo }] }, place: null };
  const shares = evenShares(held.amountKobo, others.length);
  return { outcome: { kind: "refunded", to: others.map((s, i) => ({ userId: s.userId, amountKobo: shares[i] })).filter((t) => t.amountKobo > 0) }, place: null };
}

const pot = (partyId: string): ledger.AccountRef => ({ system: "party_pot", scope: partyId });
const cashOf = (userId: string): ledger.AccountRef => ({ userId, kind: "cash" });
const JOURNAL_TYPE: Record<HeldPrizeOutcome["kind"], string> = {
  passed_on: "party_prize", returned_to_host: "held_prize_returned", refunded: "held_prize_refund", forfeited: "held_prize_forfeit",
};

/** The key each payment out of a reject is written under: a passed-on prize is that player's party prize (settlement's key). */
const payoutKey = (held: HeldPrize, kind: HeldPrizeOutcome["kind"], userId: string) =>
  kind === "passed_on" ? `party_prize:${held.partyId}:${userId}` : `held_prize_${kind}:${held.id}:${userId}`;

/**
 * An admin rejects a held prize, with a reason: taken back from the winner and moved by the rule. Idempotent: a
 * second reject answers the first (replayed). Refused once cleared. Logged.
 */
export async function rejectHeldPrize(adminUserId: string, id: string, reason: string): Promise<{ row: HeldPrize; replayed: boolean }> {
  return moneyTransaction(async (tx) => {
    const [pre] = await tx.select().from(heldPrizes).where(eq(heldPrizes.id, id));
    if (!pre) throw httpError(404, "not_found");
    if (pre.status === "rejected") return { row: pre, replayed: true };
    const [party] = await tx.select().from(parties).where(eq(parties.id, pre.partyId));
    const planned = await planReject(tx, pre, party);
    // People first, then the party and the held row (ADR 0013's lock order), then re-plan under the locks.
    await lockUsers(tx, [pre.userId, ...planned.outcome.to.map((t) => t.userId)]);
    const [p] = await tx.select().from(parties).where(eq(parties.id, pre.partyId)).for("update");
    const held = await lockHeld(tx, id);
    if (held.status === "rejected") return { row: held, replayed: true };
    if (held.status !== "held") throw httpError(409, "prize_already_decided", { status: held.status });
    refuseOwn(held, adminUserId); // a host rejecting a host-funded prize would get it back
    const plan = await planReject(tx, held, p);
    if (JSON.stringify(plan.outcome) !== JSON.stringify(planned.outcome)) throw httpError(409, "party_changed_try_again");

    try {
      await ledger.journal(tx, { type: "held_prize_rejected", refType: "party", refId: p.id, idempotencyKey: `held_prize_reject:${held.id}`, legs: [{ account: cashOf(held.userId), amountKobo: -held.amountKobo }, { account: pot(p.id), amountKobo: held.amountKobo }] });
    } catch (e) {
      if (e instanceof ledger.InsufficientFunds) throw httpError(409, "prize_not_recoverable", { amountKobo: held.amountKobo });
      throw e;
    }
    await tx.update(partyPlayers).set({ prizeKobo: 0 }).where(and(eq(partyPlayers.partyId, p.id), eq(partyPlayers.userId, held.userId)));
    for (const t of plan.outcome.to) {
      await ledger.journal(tx, { type: JOURNAL_TYPE[plan.outcome.kind], refType: "party", refId: p.id, idempotencyKey: payoutKey(held, plan.outcome.kind, t.userId), legs: [{ account: pot(p.id), amountKobo: -t.amountKobo }, { account: cashOf(t.userId), amountKobo: t.amountKobo }] });
    }
    if (plan.outcome.kind === "passed_on") {
      const to = plan.outcome.to[0];
      await tx.update(partyPlayers).set({ prizeKobo: to.amountKobo }).where(and(eq(partyPlayers.partyId, p.id), eq(partyPlayers.userId, to.userId)));
      // The new winner passes the same check.
      await holdFlaggedPrizes(tx, p, [{ userId: to.userId, place: plan.place ?? held.place, amountKobo: to.amountKobo }]);
    }
    const [done] = await tx.update(heldPrizes).set({ status: "rejected", decidedByUserId: adminUserId, reason, decidedAt: new Date(), outcome: plan.outcome }).where(eq(heldPrizes.id, id)).returning();
    await recordAdminAction(tx, { adminUserId, action: "party_templates.held_prize_reject", targetType: "held_prize", targetId: id, reason, before: { status: held.status, userId: held.userId, amountKobo: held.amountKobo }, after: { status: done.status, outcome: plan.outcome } });
    return { row: done, replayed: false };
  }, { label: "held prize reject" });
}

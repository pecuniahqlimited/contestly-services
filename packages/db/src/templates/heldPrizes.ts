/**
 * Held prizes (ADR 0015): the settlement check for parties with host-written questions and the admin's decision.
 *
 * At settlement every cash prize is decided before it's paid (payCashPrizes): a winner who is linked to the host (or
 * a newcomer) and did far better than the room, or anyone very far better, or a repeat winner, has the prize
 * credited into their prize_hold ledger account, not their cash, so it can't be withdrawn, spent or used to repay a
 * debt; a held_prizes row records it and a warning alert is raised.
 *
 * Every decision takes two admins, neither of them the host or the winner. Clear: the hold moves into their cash through ledger.journal() (where what they owe is repaid first, as with any
 * credit). Reject (the rule in ADR 0015's implementation notes): the hold goes back into the party's pot, then to the
 * best-placed eligible player without a prize (decided the same way, so possibly held in turn); with nobody to pass
 * it to, a host's prize goes back to the host and a pooled one is refunded evenly to the other seats (with nobody
 * at all, it's forfeited to the treasury). Every movement is a journal keyed by the row (or by the party and the
 * recipient, like settlement's own prize keys), and the row is locked, so a replay moves nothing. Lock order
 * (ADR 0013): the people's users rows, then the party and the held row, then the ledger.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { evenShares, nextPlaced, reviewPrize, type GradedAnswer } from "@contestly/game";
import { DEFAULT_HOST_WRITTEN_RULES, OWN_TRANSACTION, PRIZE_LINK_KINDS, type HeldPrizeDecision, type HeldPrizeEvidence, type HeldPrizeOutcome, type HostWrittenRules, type PrizeLinkKind } from "@contestly/shared";
import type { Tx } from "../client.js";
import { blocks, liftedBlocks, contactMatches, cornerNewPlayers, crewMembers, crews, partyInvites, heldPrizes, parties, partyAnswers, partyPlayers, partyQuestions, playedWith, userSignals, users, type HeldPrize, type Party } from "../schema.js";
import { adminAlert } from "../alerts.js";
import { recordAdminAction } from "../admin.js";
import { moneyTransaction } from "../retry.js";
import { getSocialConfig } from "../config.js";
import * as ledger from "../ledger.js";

export const HELD_PRIZE_ALERT_KIND = "templates.prize_held";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const httpError = (statusCode: number, code: string, details?: Record<string, unknown>) => Object.assign(new Error(code), { statusCode, ...(details ? { details } : {}) });

/**
 * How `userId` is linked to the host, from the raw relationships rather than yourPeople() (which drops blocked
 * pairs, so a host could block a friend to dodge it): crew mates in a live crew, contacts either way, played
 * together within yourPeopleDays before the party, a block either way made in the `recentBlockDays` before the
 * party (or since), standing or lifted since (lifted_blocks), an account younger than `newAccountDays` that came in through the host's invite to this party
 * or signed up from the host's invite (invited_new), an install id seen on both accounts, and an IP both used
 * around the party (`ipWindowHoursBefore` before it to its end) that no more than `maxAccountsPerIp` accounts used
 * then (more is a carrier's shared address). "Used" is first_seen_at..last_seen_at overlapping the window.
 */
async function linksToHost(tx: Tx, p: Party, userId: string, rules: HostWrittenRules): Promise<PrizeLinkKind[]> {
  const hostId = p.createdByUserId;
  const partyAt = p.liveAt ?? p.startsAt;
  const { yourPeopleDays } = await getSocialConfig(tx);
  const playedSince = new Date(partyAt.getTime() - yourPeopleDays * DAY_MS);
  const blockedSince = new Date(partyAt.getTime() - rules.recentBlockDays * DAY_MS);
  const newSince = new Date(partyAt.getTime() - rules.newAccountDays * DAY_MS);
  // The IP window: hours before the party to its end (now, at settlement; its end, on a later reject's pass-on).
  const ipFrom = new Date(partyAt.getTime() - rules.ipWindowHoursBefore * HOUR_MS);
  const ipTo = p.endedAt ?? new Date();
  const [row] = await tx.execute(sql`
    select
      exists(select 1 from ${crewMembers} a join ${crewMembers} b on b.crew_id = a.crew_id join ${crews} c on c.id = a.crew_id and c.archived_at is null
        where a.user_id = ${hostId} and b.user_id = ${userId}) as crew,
      exists(select 1 from ${contactMatches} where (user_id = ${hostId} and contact_user_id = ${userId}) or (user_id = ${userId} and contact_user_id = ${hostId})) as contact,
      exists(select 1 from ${playedWith} where user_a = least(${hostId}::uuid, ${userId}::uuid) and user_b = greatest(${hostId}::uuid, ${userId}::uuid)
        and last_played_at >= ${playedSince.toISOString()}::timestamptz) as played_with,
      (exists(select 1 from ${blocks} where ((blocker_id = ${hostId} and blocked_id = ${userId}) or (blocker_id = ${userId} and blocked_id = ${hostId}))
        and created_at >= ${blockedSince.toISOString()}::timestamptz)
       or exists(select 1 from ${liftedBlocks} where ((blocker_id = ${hostId} and blocked_id = ${userId}) or (blocker_id = ${userId} and blocked_id = ${hostId}))
        and blocked_at >= ${blockedSince.toISOString()}::timestamptz)) as recent_block,
      (exists(select 1 from ${users} where id = ${userId} and created_at >= ${newSince.toISOString()}::timestamptz)
        and (exists(select 1 from ${partyInvites} where party_id = ${p.id} and inviter_id = ${hostId} and invitee_id = ${userId})
          or exists(select 1 from ${cornerNewPlayers} where user_id = ${userId} and host_user_id = ${hostId} and via = 'invite'))) as invited_new,
      exists(select 1 from ${userSignals} a join ${userSignals} b on b.kind = a.kind and b.value = a.value
        where a.kind = 'install' and a.user_id = ${hostId} and b.user_id = ${userId}) as install,
      exists(select 1 from ${userSignals} a join ${userSignals} b on b.kind = a.kind and b.value = a.value
        where a.kind = 'ip' and a.user_id = ${hostId} and b.user_id = ${userId}
          and a.last_seen_at >= ${ipFrom.toISOString()}::timestamptz and a.first_seen_at <= ${ipTo.toISOString()}::timestamptz
          and b.last_seen_at >= ${ipFrom.toISOString()}::timestamptz and b.first_seen_at <= ${ipTo.toISOString()}::timestamptz
          and (select count(distinct c.user_id) from ${userSignals} c where c.kind = 'ip' and c.value = a.value
                and c.last_seen_at >= ${ipFrom.toISOString()}::timestamptz and c.first_seen_at <= ${ipTo.toISOString()}::timestamptz) <= ${rules.maxAccountsPerIp}) as ip`) as unknown as Record<PrizeLinkKind, boolean>[];
  return PRIZE_LINK_KINDS.filter((k) => row[k]);
}

/** Every seated player's graded answers on the party's played questions, marked host-written or not. */
async function gradedAnswers(tx: Tx, partyId: string): Promise<GradedAnswer[]> {
  const rows = await tx.select({ userId: partyAnswers.userId, hostWritten: partyQuestions.hostWritten, correctnessPct: partyAnswers.correctness })
    .from(partyAnswers).innerJoin(partyQuestions, eq(partyQuestions.id, partyAnswers.questionId))
    .where(and(eq(partyAnswers.partyId, partyId), eq(partyQuestions.status, "played")));
  return rows;
}

/**
 * How many of this host's other host-written parties `userId` won (a prize, held or not, that wasn't rejected) in the
 * `windowDays` before this party.
 */
async function priorWins(tx: Tx, p: Party, userId: string, windowDays: number): Promise<number> {
  const since = new Date((p.liveAt ?? p.startsAt).getTime() - windowDays * DAY_MS);
  const [row] = await tx.execute(sql`
    select count(distinct pa.id)::int as n from ${parties} pa join ${partyPlayers} pp on pp.party_id = pa.id
    where pa.created_by_user_id = ${p.createdByUserId} and pa.id <> ${p.id} and pa.host_question_count > 0 and pa.status = 'finished'
      and pa.ended_at >= ${since.toISOString()}::timestamptz and pp.user_id = ${userId} and coalesce(pp.prize_kobo, 0) > 0`) as unknown as { n: number }[];
  return Number(row.n);
}

/**
 * Whether the winner is a newcomer to check as if linked (ADR 0015): an account younger than `newAccountDays` at the
 * party, or one that had finished fewer than `minFinishedParties` parties before it. A fresh account made for one
 * party has none of the ties linksToHost() looks for.
 */
async function newcomer(tx: Tx, p: Party, userId: string, rules: HostWrittenRules): Promise<{ is: boolean; finishedParties: number }> {
  const partyAt = p.liveAt ?? p.startsAt;
  const newSince = new Date(partyAt.getTime() - rules.newAccountDays * DAY_MS);
  const [row] = await tx.execute(sql`
    select (select created_at >= ${newSince.toISOString()}::timestamptz from ${users} where id = ${userId}) as young,
      (select count(*)::int from ${partyPlayers} pp join ${parties} pa on pa.id = pp.party_id
        where pp.user_id = ${userId} and pa.id <> ${p.id} and pa.status = 'finished') as finished`) as unknown as { young: boolean; finished: number }[];
  const finishedParties = Number(row.finished);
  return { is: !!row.young || finishedParties < rules.minFinishedParties, finishedParties };
}

export interface CashPrize { userId: string; place: number; amountKobo: number }

/**
 * Pay cash prizes, each decided first: for a party with host-written questions, a flagged winner's prize goes into
 * their prize hold (with a held_prizes row and a warning alert that commit with it); everyone else's into cash, as
 * any party prize. Both are keyed party_prize:<party>:<user>, so a prize is paid once, one way. Goods aren't money
 * and never get here. The caller holds the winners' users rows (ADR 0013). Returns the rows it held.
 */
export async function payCashPrizes(tx: Tx, p: Party, prizes: CashPrize[]): Promise<HeldPrize[]> {
  const paid = prizes.filter((x) => x.amountKobo > 0);
  const checked = p.hostQuestionCount > 0 && paid.length > 0;
  // Rules copied before a setting existed take its default.
  const rules = { ...DEFAULT_HOST_WRITTEN_RULES, ...p.hostRules };
  const answers = checked ? await gradedAnswers(tx, p.id) : [];
  const held: HeldPrize[] = [];
  for (const prize of paid) {
    const key = `party_prize:${p.id}:${prize.userId}`;
    const review = checked ? reviewPrize({
      winnerId: prize.userId, links: await linksToHost(tx, p, prize.userId, rules), answers, marginPct: rules.outlierMarginPct,
      newcomer: await newcomer(tx, p, prize.userId, rules), unlinkedMarginPct: rules.unlinkedMarginPct,
      repeat: { priorWins: await priorWins(tx, p, prize.userId, rules.repeatWindowDays), max: rules.repeatWinsMax },
    }) : null;
    if (review?.flagged) {
      await ledger.journal(tx, { type: "party_prize", refType: "party", refId: p.id, idempotencyKey: key, legs: [{ account: ledger.prizeHoldAccount(prize.userId), amountKobo: prize.amountKobo }, { account: pot(p.id), amountKobo: -prize.amountKobo }] });
      const [row] = await tx.insert(heldPrizes).values({ partyId: p.id, userId: prize.userId, hostUserId: p.createdByUserId, place: prize.place, amountKobo: prize.amountKobo, evidence: review.evidence })
        .onConflictDoNothing().returning();
      if (row) {
        held.push(row);
        await adminAlert({
          kind: HELD_PRIZE_ALERT_KIND, severity: "warning", subject: heldSubject(review.evidence),
          dedupeKey: `prize_held:${row.id}`, refType: "party", refId: p.id,
          details: { heldPrizeId: row.id, partyId: p.id, winnerId: prize.userId, hostId: p.createdByUserId, place: prize.place, amountKobo: prize.amountKobo, ...review.evidence },
        }, tx);
      }
    } else {
      await ledger.post(tx, { userId: prize.userId, kind: "cash", amountKobo: prize.amountKobo, type: "party_prize", refType: "party", refId: p.id, idempotencyKey: key });
    }
    await tx.update(partyPlayers).set({ prizeKobo: prize.amountKobo }).where(and(eq(partyPlayers.partyId, p.id), eq(partyPlayers.userId, prize.userId)));
  }
  return held;
}

function heldSubject(e: HeldPrizeEvidence): string {
  if (e.flaggedOn.includes("repeat")) return "A prize is held: the same winner keeps winning this host's parties";
  if (e.links.length) return "A prize is held: a winner linked to the host beat the room";
  if (e.newcomer) return "A prize is held: a new or barely-played account beat the room";
  return "A prize is held: a winner far above the room";
}

/** Lock these people's users rows, in id order (the first step of ADR 0013's lock order). */
export const lockPeopleRows = (tx: Tx, ids: string[]) =>
  tx.select({ id: users.id }).from(users).where(inArray(users.id, [...new Set(ids)].sort())).orderBy(asc(users.id)).for("no key update");

async function lockHeld(tx: Tx, id: string) {
  const [row] = await tx.select().from(heldPrizes).where(eq(heldPrizes.id, id)).for("update");
  return row;
}

/** Neither the host nor the winner decides their own held prize (ADR 0013's own-transaction rule). */
function refuseOwn(row: HeldPrize, adminUserId: string) {
  if (adminUserId === row.userId || adminUserId === row.hostUserId) throw httpError(403, OWN_TRANSACTION);
}

export interface DecisionOutcome { row: HeldPrize; replayed: boolean; awaitingSecondAdmin: boolean }
type Step = { confirmed: false; outcome: DecisionOutcome } | { confirmed: true; requestedBy: string };

/**
 * Every decision on a held prize takes two admins (ADR 0015), whatever the amount: the first admin's clear or reject
 * is a request (the prize stays held), the same admin asking again is a replay, and a different admin asking the same
 * confirms it. Asking the other decision replaces the request. The caller has locked the row and refused the admin
 * if it's their own. Logged.
 */
async function twoAdmins(tx: Tx, row: HeldPrize, adminUserId: string, decision: HeldPrizeDecision, reason: string): Promise<Step> {
  if (row.requestedDecision === decision && row.requestedByUserId) {
    if (row.requestedByUserId === adminUserId) return { confirmed: false, outcome: { row, replayed: true, awaitingSecondAdmin: true } };
    return { confirmed: true, requestedBy: row.requestedByUserId };
  }
  const [asked] = await tx.update(heldPrizes).set({ requestedDecision: decision, requestedByUserId: adminUserId, requestReason: reason, requestedAt: new Date() }).where(eq(heldPrizes.id, row.id)).returning();
  await recordAdminAction(tx, {
    adminUserId, action: `party_templates.held_prize_${decision}_requested`, targetType: "held_prize", targetId: row.id, reason,
    before: { status: row.status, requestedDecision: row.requestedDecision, requestedBy: row.requestedByUserId }, after: { status: row.status, requestedDecision: decision, userId: row.userId, amountKobo: row.amountKobo },
  });
  return { confirmed: false, outcome: { row: asked, replayed: false, awaitingSecondAdmin: true } };
}

/**
 * An admin clears a held prize: once a second admin confirms (twoAdmins), it moves from their hold into their cash.
 * Neither admin may be the host or the winner.
 */
export async function clearHeldPrize(adminUserId: string, id: string, reason: string): Promise<DecisionOutcome> {
  return moneyTransaction(async (tx) => {
    const [pre] = await tx.select({ userId: heldPrizes.userId }).from(heldPrizes).where(eq(heldPrizes.id, id));
    if (!pre) throw httpError(404, "not_found");
    await lockPeopleRows(tx, [pre.userId]);
    const row = await lockHeld(tx, id);
    if (row.status === "cleared") return { row, replayed: true, awaitingSecondAdmin: false };
    if (row.status !== "held") throw httpError(409, "prize_already_decided", { status: row.status });
    refuseOwn(row, adminUserId);
    const step = await twoAdmins(tx, row, adminUserId, "clear", reason);
    if (!step.confirmed) return step.outcome;
    // The prize becomes their cash: through journal(), so what they owe is repaid from it first, as from any credit.
    await ledger.journal(tx, { type: "held_prize_cleared", refType: "party", refId: row.partyId, idempotencyKey: `held_prize_clear:${row.id}`, legs: [{ account: ledger.prizeHoldAccount(row.userId), amountKobo: -row.amountKobo }, { account: cashOf(row.userId), amountKobo: row.amountKobo }] });
    const [done] = await tx.update(heldPrizes).set({ status: "cleared", decidedByUserId: adminUserId, reason, decidedAt: new Date() }).where(eq(heldPrizes.id, id)).returning();
    await recordAdminAction(tx, { adminUserId, action: "party_templates.held_prize_clear", targetType: "held_prize", targetId: id, reason, before: { status: row.status, requestedBy: step.requestedBy }, after: { status: done.status, requestedBy: step.requestedBy, userId: row.userId, amountKobo: row.amountKobo } });
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
const JOURNAL_TYPE: Record<Exclude<HeldPrizeOutcome["kind"], "passed_on">, string> = {
  returned_to_host: "held_prize_returned", refunded: "held_prize_refund", forfeited: "held_prize_forfeit",
};

/**
 * An admin rejects a held prize, with a reason: once a second admin confirms (twoAdmins), taken back from the winner
 * and moved by the rule. Idempotent: a reject after the reject answers it (replayed). Refused once cleared. Logged.
 */
export async function rejectHeldPrize(adminUserId: string, id: string, reason: string): Promise<DecisionOutcome> {
  return moneyTransaction(async (tx) => {
    const [pre] = await tx.select().from(heldPrizes).where(eq(heldPrizes.id, id));
    if (!pre) throw httpError(404, "not_found");
    if (pre.status === "rejected") return { row: pre, replayed: true, awaitingSecondAdmin: false };
    const [party] = await tx.select().from(parties).where(eq(parties.id, pre.partyId));
    const planned = await planReject(tx, pre, party);
    // People first, then the party and the held row (ADR 0013's lock order), then re-plan under the locks.
    await lockPeopleRows(tx, [pre.userId, ...planned.outcome.to.map((t) => t.userId)]);
    const [p] = await tx.select().from(parties).where(eq(parties.id, pre.partyId)).for("update");
    const held = await lockHeld(tx, id);
    if (held.status === "rejected") return { row: held, replayed: true, awaitingSecondAdmin: false };
    if (held.status !== "held") throw httpError(409, "prize_already_decided", { status: held.status });
    refuseOwn(held, adminUserId); // a host rejecting a host-funded prize would get it back
    const plan = await planReject(tx, held, p);
    if (JSON.stringify(plan.outcome) !== JSON.stringify(planned.outcome)) throw httpError(409, "party_changed_try_again");
    const step = await twoAdmins(tx, held, adminUserId, "reject", reason);
    if (!step.confirmed) return step.outcome;

    // Out of their hold, never their cash: it was never theirs to spend.
    await ledger.journal(tx, { type: "held_prize_rejected", refType: "party", refId: p.id, idempotencyKey: `held_prize_reject:${held.id}`, legs: [{ account: ledger.prizeHoldAccount(held.userId), amountKobo: -held.amountKobo }, { account: pot(p.id), amountKobo: held.amountKobo }] });
    await tx.update(partyPlayers).set({ prizeKobo: 0 }).where(and(eq(partyPlayers.partyId, p.id), eq(partyPlayers.userId, held.userId)));
    if (plan.outcome.kind === "passed_on") {
      // The new winner is decided the same way (and may be held in turn); their party_prize key, like settlement's.
      const to = plan.outcome.to[0];
      await payCashPrizes(tx, p, [{ userId: to.userId, place: plan.place ?? held.place, amountKobo: to.amountKobo }]);
    } else {
      for (const t of plan.outcome.to) {
        await ledger.journal(tx, { type: JOURNAL_TYPE[plan.outcome.kind], refType: "party", refId: p.id, idempotencyKey: `held_prize_${plan.outcome.kind}:${held.id}:${t.userId}`, legs: [{ account: pot(p.id), amountKobo: -t.amountKobo }, { account: cashOf(t.userId), amountKobo: t.amountKobo }] });
      }
    }
    const [done] = await tx.update(heldPrizes).set({ status: "rejected", decidedByUserId: adminUserId, reason, decidedAt: new Date(), outcome: plan.outcome }).where(eq(heldPrizes.id, id)).returning();
    await recordAdminAction(tx, { adminUserId, action: "party_templates.held_prize_reject", targetType: "held_prize", targetId: id, reason, before: { status: held.status, userId: held.userId, amountKobo: held.amountKobo, requestedBy: step.requestedBy }, after: { status: done.status, outcome: plan.outcome, requestedBy: step.requestedBy } });
    return { row: done, replayed: false, awaitingSecondAdmin: false };
  }, { label: "held prize reject" });
}

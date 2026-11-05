/**
 * The anti-collusion check for parties with host-written questions (ADR 0015), pure. The host knows every answer
 * they wrote, so a winner who is linked to the host (one of their people, or the same install or IP) and who did
 * far better than the room on the host's own questions has their cash prize held for an admin. A winner who isn't
 * linked, or who did about as well as everyone else on those questions, is paid as normal.
 *
 * Also the reject rule's arithmetic: who a rejected prize passes to, and an even refund.
 */
import type { HeldPrizeEvidence, PrizeLinkKind } from "@contestly/shared";


/** One graded answer: who, whether the question was host-written, and its correctness 0–100. */
export interface GradedAnswer {
  userId: string;
  hostWritten: boolean;
  correctnessPct: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round1 = (x: number) => Math.round(x * 10) / 10;

export interface PrizeReview {
  flagged: boolean;
  evidence: HeldPrizeEvidence;
}

/**
 * Review one cash prize. `answers` are every seated player's graded answers on the played questions (a no-answer is
 * a row at 0). The room is everyone else seated. Flagged only when linked, at least one host-written question was
 * played, and the winner's accuracy on them is at least `marginPct` points above the room's (a room with nobody
 * else counts as 0).
 */
export function reviewPrize(input: { winnerId: string; links: PrizeLinkKind[]; answers: GradedAnswer[]; marginPct: number }): PrizeReview {
  const host = input.answers.filter((a) => a.hostWritten);
  const mine = host.filter((a) => a.userId === input.winnerId).map((a) => a.correctnessPct);
  const room = host.filter((a) => a.userId !== input.winnerId).map((a) => a.correctnessPct);
  const themed = input.answers.filter((a) => !a.hostWritten && a.userId === input.winnerId).map((a) => a.correctnessPct);
  const winnerAccuracyPct = mean(mine) ?? 0;
  const roomAccuracyPct = mean(room) ?? 0;
  const marginPct = winnerAccuracyPct - roomAccuracyPct;
  const themedMean = mean(themed);
  const evidence: HeldPrizeEvidence = {
    links: [...input.links],
    hostQuestionsPlayed: mine.length,
    winnerAccuracyPct: round1(winnerAccuracyPct),
    roomAccuracyPct: round1(roomAccuracyPct),
    marginPct: round1(marginPct),
    thresholdPct: input.marginPct,
    winnerThemedAccuracyPct: themedMean === null ? null : round1(themedMean),
  };
  return { flagged: input.links.length > 0 && mine.length > 0 && marginPct >= input.marginPct, evidence };
}

/** A seat at settlement: its final rank (null if unranked) and whether it can be paid a prize at all. */
export interface PlacedSeat {
  userId: string;
  rank: number | null;
  eligible: boolean;
}

/**
 * Who a rejected prize passes to: the best-ranked eligible seat that hasn't been paid a prize in this party and
 * isn't excluded (the rejected winner, anyone whose prize was rejected before). Null when there's nobody.
 */
export function nextPlaced(seats: PlacedSeat[], paid: ReadonlySet<string>, excluded: ReadonlySet<string>): string | null {
  const next = seats
    .filter((s) => s.rank !== null && s.eligible && !paid.has(s.userId) && !excluded.has(s.userId))
    .sort((a, b) => a.rank! - b.rank!)[0];
  return next?.userId ?? null;
}

/** `amount` split evenly across `n` shares, floored, the remainder to the first: always sums to `amount`. */
export function evenShares(amount: number, n: number): number[] {
  if (n <= 0) return [];
  const each = Math.floor(amount / n);
  const shares = Array.from({ length: n }, () => each);
  shares[0] += amount - each * n;
  return shares;
}

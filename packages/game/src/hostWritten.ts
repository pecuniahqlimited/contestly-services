/**
 * The anti-collusion check for curate parties with money (ADR 0015), pure. The host knows every answer
 * they wrote (and, in curate mode, every generated one), so a winner who is linked to the host (or is a newcomer)
 * and who did far better than the room, on the host's own questions or on the whole set, has their cash prize held
 * for an admin; so does anyone at all who did very far better. Everyone else is paid as normal.
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

/** The winner's mean correctness and the room's (everyone else seated; nobody counts as 0) over these answers. */
function compare(answers: GradedAnswer[], winnerId: string) {
  const mine = answers.filter((a) => a.userId === winnerId).map((a) => a.correctnessPct);
  const room = answers.filter((a) => a.userId !== winnerId).map((a) => a.correctnessPct);
  const winner = mean(mine) ?? 0;
  const others = mean(room) ?? 0;
  return { played: mine.length, winner, room: others, margin: winner - others };
}

/**
 * Review one cash prize. `answers` are every seated player's graded answers on the played questions (a no-answer is
 * a row at 0). Two comparisons, because the host knows the answers they wrote and, in curate mode, every generated
 * one too (ADR 0003): on the host-written questions, and on the whole set. A comparison trips at `marginPct` points
 * when the winner is linked or a newcomer (a fresh account has no ties to find), and at `unlinkedMarginPct` for
 * anyone (the host-written one only if at least one was played). Also flagged, linked or not, when the winner has
 * already won `repeat.max` of the same host's parties lately.
 */
export function reviewPrize(input: {
  winnerId: string; links: PrizeLinkKind[]; answers: GradedAnswer[]; marginPct: number;
  /** A new account or one with few finished parties: `finishedParties` is how many it had. */
  newcomer: { is: boolean; finishedParties: number };
  unlinkedMarginPct: number;
  /** The same host's curate parties this winner had already won in the repeat window, and the most allowed. */
  repeat: { priorWins: number; max: number };
}): PrizeReview {
  const host = compare(input.answers.filter((a) => a.hostWritten), input.winnerId);
  const all = compare(input.answers, input.winnerId);
  const suspect = input.links.length > 0 || input.newcomer.is;
  const threshold = suspect ? Math.min(input.marginPct, input.unlinkedMarginPct) : input.unlinkedMarginPct;
  // A repeat winner is held whoever they are and however they scored.
  const flaggedOn: HeldPrizeEvidence["flaggedOn"] = [
    ...(host.played > 0 && host.margin >= threshold ? ["host_written" as const] : []),
    ...(all.played > 0 && all.margin >= threshold ? ["all" as const] : []),
    ...(input.repeat.priorWins >= input.repeat.max ? ["repeat" as const] : []),
  ];
  const evidence: HeldPrizeEvidence = {
    links: [...input.links],
    hostQuestionsPlayed: host.played, winnerAccuracyPct: round1(host.winner), roomAccuracyPct: round1(host.room), marginPct: round1(host.margin),
    questionsPlayed: all.played, winnerAllAccuracyPct: round1(all.winner), roomAllAccuracyPct: round1(all.room), allMarginPct: round1(all.margin),
    thresholdPct: input.marginPct, newcomer: input.newcomer.is, finishedParties: input.newcomer.finishedParties, unlinkedThresholdPct: input.unlinkedMarginPct,
    priorWins: input.repeat.priorWins, repeatWinsMax: input.repeat.max,
    flaggedOn,
  };
  return { flagged: flaggedOn.length > 0, evidence };
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

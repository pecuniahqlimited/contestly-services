import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { db, getOnboardingConfig, ledger, onboardingRounds, parties, partyPlayers, users, type User } from "@contestly/db";
import { GUEST_HANDLE_PREFIX, archetypeOf, isStaked, onboardingInviteSchema, onboardingPicksSchema, onboardingRewardsResponseSchema, type OnboardingRewardsResponse, whyFits, type Who, type Why } from "@contestly/shared";
import { requireSession } from "../auth.js";
import { httpError } from "../httpError.js";

/** Where onboarding ends: Home, or the lobby of the staked invite they opened (and whether their coins cover it). */
async function inviteState(u: User) {
  if (!u.invitePartyId) return null;
  const [p] = await db.select().from(parties).where(eq(parties.id, u.invitePartyId));
  if (!p) return null;
  const [[seat], wallet] = await Promise.all([
    db.select().from(partyPlayers).where(and(eq(partyPlayers.partyId, p.id), eq(partyPlayers.userId, u.id))),
    ledger.balances(u.id),
  ]);
  return {
    partyId: p.id, status: p.status, staked: isStaked(p), entryKobo: p.entryKobo, joined: !!seat,
    canAfford: wallet.bonusKobo + wallet.cashKobo >= p.entryKobo,
  };
}

/** What onboarding has (so no pick is asked twice), the archetype Home opens with, and where to go next. */
async function onboardingState(u: User) {
  const [[round], invite] = await Promise.all([db.select().from(onboardingRounds).where(eq(onboardingRounds.userId, u.id)), inviteState(u)]);
  return {
    signedUp: !u.isGuest,
    picks: { who: u.who, lanes: u.interests, why: u.why },
    archetype: archetypeOf(u.who, u.why),
    round: round ? { mode: round.mode, points: round.points, correct: round.correct, questions: round.questions, rank: round.rank, players: round.players, coinsKobo: round.coinsKobo, claimed: !!round.claimedAt, claimOutcome: round.claimOutcome } : null,
    profileDone: !u.isGuest && !u.handle.startsWith(GUEST_HANDLE_PREFIX),
    invite,
    next: invite && invite.status === "open" ? ("lobby" as const) : ("home" as const),
  };
}

export async function onboardingRoutes(app: FastifyInstance) {
  /** What the onboarding round pays (public: the Bag coins screen shows it before anyone has a session). */
  app.get("/onboarding/rewards", async (): Promise<OnboardingRewardsResponse> => {
    const c = await getOnboardingConfig();
    return onboardingRewardsResponseSchema.parse({ questionCount: c.questionCount, questionSeconds: c.questionSeconds, soloTiers: c.soloTiers, sharedByRankKobo: c.sharedByRankKobo });
  });

  app.get("/onboarding", async (req) => onboardingState(requireSession(req)));

  /** Save onboarding picks (who, lanes, why). Guests too: they're asked before sign-up. The same call edits them from Me. */
  app.patch("/me/onboarding", async (req) => {
    const me = requireSession(req);
    const picks = onboardingPicksSchema.parse(req.body);
    const who = (picks.who ?? me.who) as Who | null;
    let why = (picks.why ?? me.why) as Why | null;
    if (why && !whyFits(who, why)) {
      if (picks.why) throw httpError(422, "why_does_not_fit_who");
      why = null; // a new "who" clears a "why" that no longer fits it
    }
    const [u] = await db.update(users).set({ who, why, ...(picks.lanes ? { interests: picks.lanes } : {}) }).where(eq(users.id, me.id)).returning();
    return onboardingState(u);
  });

  /** The invite this person opened before signing up, so onboarding ends in its lobby. Null clears it. */
  app.put("/onboarding/invite", async (req) => {
    const me = requireSession(req);
    const { partyId } = onboardingInviteSchema.parse(req.body);
    if (partyId) {
      const [p] = await db.select({ id: parties.id }).from(parties).where(eq(parties.id, partyId));
      if (!p) throw httpError(404, "not_found");
    }
    const [u] = await db.update(users).set({ invitePartyId: partyId }).where(eq(users.id, me.id)).returning();
    return onboardingState(u);
  });
}

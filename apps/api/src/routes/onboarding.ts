import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { currentAboutConfig, db, ledger, parties, partyPlayers, users, type User } from "@contestly/db";
import { GUEST_HANDLE_PREFIX, aboutQuerySchema, isStaked, onboardingInviteSchema, onboardingPatchSchema, type Archetype, type OnboardingState, type Who } from "@contestly/shared";
import { requireSession } from "../auth.js";
import { httpError } from "../httpError.js";
import { aboutView, answerAbout, meAbout, setWho } from "../about.js";

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
async function onboardingState(u: User): Promise<OnboardingState> {
  const invite = await inviteState(u);
  return {
    signedUp: !u.isGuest,
    who: u.who as Who | null,
    aboutVersion: u.aboutVersion,
    lanes: u.interests,
    archetype: u.archetype as Archetype | null,
    profileDone: !u.isGuest && !u.handle.startsWith(GUEST_HANDLE_PREFIX),
    invite,
    next: invite && invite.status === "open" ? "lobby" : "home",
  };
}

export async function onboardingRoutes(app: FastifyInstance) {
  /** About you, the current version of the person or brand set. Public: it's asked before anyone signs up. */
  app.get("/onboarding/about", async (req) => {
    const { audience } = aboutQuerySchema.parse(req.query);
    return aboutView(await currentAboutConfig(audience));
  });

  app.get("/onboarding", async (req) => onboardingState(requireSession(req)));

  /**
   * Who's playing, and/or About you answers against a version ({ version, answers }). Guests too: it's
   * asked before sign-up. The same call edits them from Me (answering the current version).
   */
  app.patch("/me/onboarding", async (req) => {
    let u = requireSession(req);
    const body = onboardingPatchSchema.parse(req.body);
    if (body.who) u = await setWho(u, body.who);
    if (body.about) u = await answerAbout(u, body.about.version, body.about.answers);
    return onboardingState(u);
  });

  /** Their About you answers, the version and what it gave, and the current set with what carries over (Me). */
  app.get("/me/onboarding", async (req) => meAbout(requireSession(req)));

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

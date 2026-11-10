/**
 * Challenges (ADR 0019): the preset the builder starts from, the card each person sees, and answering one. Making
 * one is POST /parties with `challenge`; the admin's ranges are GET/PUT /admin/challenges/config.
 */
import type { FastifyInstance } from "fastify";
import { acceptChallenge, declineChallenge, getChallengeConfig, recordAdminAction, db, setChallengeConfig } from "@contestly/db";
import { PARTY_EVENTS_CHANNEL, partyQueue } from "@contestly/queue";
import {
  adminChallengeConfigUpdateSchema, challengePresetQuerySchema, challengeReplySchema, challengeConfigSchema, CHALLENGE_EXPIRED_MESSAGE,
  type ChatMessage, type PartyCancelledEvent, type SeatsChangedEvent,
} from "@contestly/shared";
import { requireAdmin, requireUser, uuidParam } from "../auth.js";
import { publishLine } from "../chats.js";
import { valkey } from "../redis.js";
import { challengeCard, challengePreset } from "../challenges.js";

const partyJobs = partyQueue();
const publishPartyEvent = (ev: SeatsChangedEvent | PartyCancelledEvent) => valkey().publish(PARTY_EVENTS_CHANNEL, JSON.stringify(ev));
const delayUntil = (at: Date) => Math.max(0, at.getTime() - Date.now());

/** A challenge ended unplayed in a request (the last decline): the room and the chat hear, as with any cancel. */
async function announceCancelled(partyId: string, line: ChatMessage) {
  await publishLine(line);
  await publishPartyEvent({ partyId, status: "cancelled", by: "system", message: line.text ?? CHALLENGE_EXPIRED_MESSAGE });
}

export async function challengesRoutes(app: FastifyInstance) {
  /** The builder's defaults for challenging these people (?userIds=a,b): topics, quick length, free, the ranges. Creates nothing. */
  app.get("/challenges/preset", async (req) => challengePreset(requireUser(req), challengePresetQuerySchema.parse(req.query ?? {}).userIds));

  /** The card, from the viewer's side: the challenger or anyone it asked. */
  app.get("/challenges/:partyId", async (req) => challengeCard(uuidParam(req, "partyId"), requireUser(req)));

  /**
   * Accept: a seat (the equal entry, if any, charged now), the lobby open. The first accept opens the join window:
   * the start at its end and the halfway reminder are queued.
   */
  app.post("/challenges/:partyId/accept", async (req) => {
    const me = requireUser(req);
    const partyId = uuidParam(req, "partyId");
    const out = await acceptChallenge(partyId, me);
    if (out.line) await publishLine(out.line);
    if (out.seats) await publishPartyEvent({ partyId, status: "player_joined", userId: me.id, seats: out.seats });
    if (out.opened) {
      const { opensAt, closesAt } = out.opened;
      await partyJobs.add("start", { kind: "start", partyId }, { delay: delayUntil(closesAt), jobId: `challenge-start-${partyId}` });
      const halfway = new Date((opensAt.getTime() + closesAt.getTime()) / 2);
      await partyJobs.add("challenge_remind", { kind: "challenge_remind", partyId }, { delay: delayUntil(halfway), jobId: `challenge-remind-${partyId}` });
    }
    return challengeReplySchema.parse({ answer: "accepted", replayed: out.replayed, card: await challengeCard(partyId, me) });
  });

  /** Decline: "Not this time" on the card. The last one out cancels and refunds it; otherwise everyone left may be in already. */
  app.post("/challenges/:partyId/decline", async (req) => {
    const me = requireUser(req);
    const partyId = uuidParam(req, "partyId");
    const out = await declineChallenge(partyId, me);
    if (out.cardLine) await publishLine(out.cardLine);
    if (out.cancelled) await announceCancelled(partyId, out.cancelled);
    else if (!out.replayed) await partyJobs.add("challenge_ready", { kind: "challenge_ready", partyId });
    return challengeReplySchema.parse({ answer: "declined", replayed: out.replayed, card: await challengeCard(partyId, me) });
  });

  app.get("/admin/challenges/config", async (req) => {
    requireAdmin(req);
    return challengeConfigSchema.parse(await getChallengeConfig());
  });

  /** The invite expiry and join window ranges and defaults. Logged with the reason. */
  app.put("/admin/challenges/config", async (req) => {
    const admin = requireAdmin(req);
    const { config, reason } = adminChallengeConfigUpdateSchema.parse(req.body);
    return db.transaction(async (tx) => {
      const before = await getChallengeConfig(tx);
      const after = await setChallengeConfig(config, tx);
      await recordAdminAction(tx, { adminUserId: admin.id, action: "config.challenges", targetType: "config", targetId: "challenges", reason, before, after });
      return after;
    });
  });
}

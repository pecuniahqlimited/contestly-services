/**
 * The worker's side of a challenge (ADR 0019): the invite's expiry, the join window's halfway reminder, and the
 * early start once everyone is in the lobby. The start itself is startOrCancel, which settles who plays.
 */
import { challengeReady, expireChallenge, remindChallenge } from "@contestly/db";
import { announceCancelled, startOrCancel, type StartDeps, type StartOutcome } from "./partyStart.js";

export type ChallengeJobKind = "challenge_expire" | "challenge_remind" | "challenge_ready";

/** Start it if everyone who'll play is in the lobby and nobody is still to answer. */
async function startIfReady(deps: StartDeps, partyId: string): Promise<StartOutcome | "waiting"> {
  return (await challengeReady(partyId, await deps.inLobby(partyId))) ? startOrCancel(deps, partyId) : "waiting";
}

export async function runChallengeJob(deps: StartDeps, kind: ChallengeJobKind, partyId: string): Promise<StartOutcome | "waiting" | number | "cancelled" | "kept"> {
  if (kind === "challenge_remind") return remindChallenge(partyId, await deps.inLobby(partyId));
  if (kind === "challenge_ready") return startIfReady(deps, partyId);
  const out = await expireChallenge(partyId);
  if (out.cancelled) {
    await announceCancelled(deps, partyId, out.cancelled);
    return "cancelled";
  }
  // The last invites still pending just ran out: everyone left may already be in the lobby.
  return out.expiredSome ? startIfReady(deps, partyId) : "kept";
}

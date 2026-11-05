/**
 * What follows a ban or suspension once it has committed (ADR 0014): rooms drop the person, their corner hides,
 * and the worker cancels their hosted open parties, frees their seats and holds their withdrawals (ban_effects).
 * Unbanning brings the corner back. Every route that bans, suspends or lifts goes through these.
 */
import { cornersAfterStandingChange } from "@contestly/db";
import { ADMIN_EVENTS_CHANNEL, partyQueue } from "@contestly/queue";
import type { AdminEvent } from "@contestly/shared";
import { valkey } from "./redis.js";

let parties: ReturnType<typeof partyQueue> | undefined;
const partyJobs = () => (parties ??= partyQueue());

export async function afterBan(userId: string) {
  const ev: AdminEvent = { kind: "user_banned", userId };
  await valkey().publish(ADMIN_EVENTS_CHANNEL, JSON.stringify(ev));
  await cornersAfterStandingChange(userId);
  await partyJobs().add("ban_effects", { kind: "ban_effects", userId }, { jobId: `ban_effects-${userId}-${Date.now()}` });
}

export const afterUnban = (userId: string) => cornersAfterStandingChange(userId);

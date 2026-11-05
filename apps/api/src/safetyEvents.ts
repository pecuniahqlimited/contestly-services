/**
 * After a block, mute, hold or removal commits (ADR 0014): rooms hear it on the safety channel and refilter, so a
 * hidden line leaves screens and a new block takes effect mid-party.
 */
import { SAFETY_EVENTS_CHANNEL } from "@contestly/queue";
import type { SafetyEvent } from "@contestly/shared";
import { valkey } from "./redis.js";

export async function publishSafety(events: SafetyEvent[]) {
  for (const ev of events) await valkey().publish(SAFETY_EVENTS_CHANNEL, JSON.stringify(ev));
}

export const peopleHidden = (...userIds: string[]) => publishSafety([{ kind: "people_hidden", userIds }]);

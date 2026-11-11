/**
 * A published line is the same for everyone; a challenge's card isn't (ADR 0019: each person's own answer decides
 * its state). Rooms pass each line through this per recipient, so a DM card arrives with its flag filled in.
 */
import { db, withChallengeFlags } from "@contestly/db";
import type { ChatMessage } from "@contestly/shared";

export type LineForViewer = (line: ChatMessage, viewerId: string | undefined) => Promise<ChatMessage>;

export const asSeenBy: LineForViewer = async (line, viewerId) =>
  line.kind === "party_card" ? (await withChallengeFlags(db, [line], viewerId))[0] : line;

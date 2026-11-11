/**
 * A challenge's flag (ADR 0019) from one viewer's side: on party detail, the lobby and the result, and on the party
 * card lines in their chats, so the app never probes GET /challenges/:id to draw a card.
 */
import { inArray } from "drizzle-orm";
import { challengeCardPath, challengeState, type ChallengeState, type ChatMessage, type PartyChallengeFlag } from "@contestly/shared";
import { db, type Tx } from "./client.js";
import { parties, partyChallengeInvitees, partyChallenges, type Party, type PartyChallenge, type PartyChallengeInvitee } from "./schema.js";

type Conn = Tx | typeof db;

/** The card's state from the viewer's side (their own answer when they were asked; the challenge's own state for anyone else). */
export function challengeStateFor(p: Party, { challenge, invitees }: { challenge: PartyChallenge; invitees: PartyChallengeInvitee[] }, viewerId: string | undefined, now: Date): ChallengeState {
  return challengeState({
    partyStatus: p.status as "open" | "live" | "finished" | "cancelled", ending: challenge.ending ?? null, windowOpen: !!challenge.windowOpensAt,
    inviteExpiresAt: challenge.inviteExpiresAt, myAnswer: invitees.find((i) => i.userId === viewerId)?.answer ?? null, now,
  });
}

/** Each of these parties that is a challenge, with its flag from the viewer's side; ordinary parties are left out. */
export async function challengeFlags(conn: Conn, partyIds: string[], viewerId: string | undefined, now = new Date()): Promise<Map<string, PartyChallengeFlag>> {
  const ids = [...new Set(partyIds)];
  const out = new Map<string, PartyChallengeFlag>();
  if (!ids.length) return out;
  const [rows, invitees, ps] = await Promise.all([
    conn.select().from(partyChallenges).where(inArray(partyChallenges.partyId, ids)),
    conn.select().from(partyChallengeInvitees).where(inArray(partyChallengeInvitees.partyId, ids)),
    conn.select().from(parties).where(inArray(parties.id, ids)),
  ]);
  const party = new Map(ps.map((p) => [p.id, p]));
  for (const challenge of rows) {
    const p = party.get(challenge.partyId);
    if (!p) continue;
    const state = challengeStateFor(p, { challenge, invitees: invitees.filter((i) => i.partyId === challenge.partyId) }, viewerId, now);
    out.set(p.id, { state, cardUrl: challengeCardPath(p.id) });
  }
  return out;
}

/** Party card lines as this viewer sees them: a challenge's card carries its flag (every other line keeps null). */
export async function withChallengeFlags(conn: Conn, lines: ChatMessage[], viewerId: string | undefined, now = new Date()): Promise<ChatMessage[]> {
  const cards = lines.filter((l) => l.kind === "party_card" && l.partyId);
  if (!cards.length) return lines;
  const flags = await challengeFlags(conn, cards.map((l) => l.partyId!), viewerId, now);
  return lines.map((l) => (l.kind === "party_card" && l.partyId && flags.has(l.partyId) ? { ...l, challenge: flags.get(l.partyId)! } : l));
}

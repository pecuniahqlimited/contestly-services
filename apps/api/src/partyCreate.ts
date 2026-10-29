/**
 * Making a party: the one path for the builder (POST /parties), a one-tap Challenge, a Rematch and a crew
 * party. Stakes are checked against the current limits, a host's cash prize is held, a sealed host is
 * seated, the party's chat opens, invites go out, and the set starts building (ADR 0002).
 */
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { takeSeat,
  canOfferNonCashPrize, crewMembers, crews, db, getPartyConfig, joinPartyThread, ledger, parties, partyCardLine, partyFiles, partyInvites,
  partyPlayers, partyPrizes, prospectiveHost, systemLine, crewThreadId, type Party, type Tx, type User,
} from "@contestly/db";
import { notifyQueue, partyQueue } from "@contestly/queue";
import { SPLITS, checkStakes, inferCategory, isGoods, startsAtFor, type ChatMessage, type CreatePartyInput } from "@contestly/shared";
import { httpError } from "./httpError.js";
import { inviteToParty } from "./invites.js";
import { enqueueSealedSet } from "./questionSet.js";

const notify = notifyQueue();
const partyJobs = partyQueue();

export interface CreateOptions {
  /** A one-tap challenge's opponent: invited without the connection check (the DM rule was checked instead). */
  challenged?: string;
  /** This party is the rematch of that one: its source files come along. */
  rematchOf?: string;
  /** More people to invite (the connection rule applies), beyond the builder's own short list: a rematch's players. */
  alsoInvite?: string[];
}

export interface Created {
  party: Party;
  /** Lines written (a crew party's card): publish them after the reply. */
  lines: ChatMessage[];
}

/** A crew the user is in, for a crew party. */
async function crewForParty(tx: Tx, crewId: string, userId: string) {
  const [row] = await tx.select({ id: crews.id, name: crews.name }).from(crews)
    .innerJoin(crewMembers, and(eq(crewMembers.crewId, crews.id), eq(crewMembers.userId, userId)))
    .where(and(eq(crews.id, crewId), isNull(crews.archivedAt)));
  if (!row) throw httpError(403, "not_in_crew");
  return row;
}

/** A rematch reuses its party's source text (never a file: only its chunks were kept, ADR 0004). */
async function copySources(tx: Tx, fromPartyId: string, toPartyId: string, uploaderId: string) {
  const files = await tx.select().from(partyFiles).where(and(eq(partyFiles.partyId, fromPartyId), eq(partyFiles.status, "parsed")));
  for (const f of files) {
    const [copy] = await tx.insert(partyFiles).values({ partyId: toPartyId, uploaderId, filename: f.filename, contentType: f.contentType, sizeBytes: f.sizeBytes, status: "parsed" }).returning();
    await tx.execute(sql`insert into file_chunks (file_id, idx, text, embedding) select ${copy.id}, idx, text, embedding from file_chunks where file_id = ${f.id}`);
  }
}

export async function createParty(me: User, body: CreatePartyInput, opts: CreateOptions = {}): Promise<Created> {
  const startsAt = startsAtFor(body);
  // The server decides: the current limits, and whether this host may offer goods (canOfferNonCashPrize, the one place that says).
  const [cfg, host] = await Promise.all([getPartyConfig(), prospectiveHost(me.id)]);
  const [refused] = checkStakes(body, cfg.limits, canOfferNonCashPrize(host));
  if (refused) throw httpError(422, refused);
  const lines: ChatMessage[] = [];
  const { party, invited } = await db.transaction(async (tx) => {
    const crew = body.crewId ? await crewForParty(tx, body.crewId, me.id) : null;
    const [p] = await tx.insert(parties).values({ createdByUserId: me.id, title: body.title, brief: body.brief, category: body.category ?? inferCategory(body.brief), difficulty: body.difficulty, formats: body.formats, mode: body.mode, questionsStatus: body.mode === "sealed" ? "generating" : "not_started", entryKobo: body.entryKobo, maxPlayers: body.maxPlayers, questionCount: body.questionCount, questionSeconds: body.secondsPerQuestion, funding: body.funding, hostPoolKobo: body.hostPoolKobo, prizeKind: body.prizeKind, split: [...SPLITS[body.split].shares], limits: cfg.limits, visibility: body.visibility, coverColor: body.coverColor, coverEmoji: body.coverEmoji, startsAt, crewId: crew?.id, rematchOf: opts.rematchOf }).returning();
    // The host's cash prize is held now, so it can't be spent elsewhere: paid out by place at settlement, released if cancelled.
    // Goods move no money: one fulfilment record per winning place at settlement.
    if (body.funding === "host" && body.prizeKind === "cash") await ledger.hold(tx, { userId: me.id, amountKobo: body.hostPoolKobo, type: "party_fund", refType: "party", refId: p.id, idempotencyKey: `party_fund:${p.id}` });
    if (isGoods(body.prizeKind)) await tx.insert(partyPrizes).values(body.places.map((g, i) => ({ partyId: p.id, place: i + 1, text: g.text, valueKobo: g.valueKobo ?? null })));
    // A sealed party's host plays: seated, and pooled hosts pay their own entry like everyone else.
    // A curate host reviews the questions and so never plays: not seated, never charged an entry.
    if (body.mode === "sealed") {
      await takeSeat(tx, p, me.id, body.funding === "pooled" ? body.entryKobo : 0);
    }
    if (opts.rematchOf) await copySources(tx, opts.rematchOf, p.id, me.id);
    // The host's team is in the party's chat whether or not they play.
    await joinPartyThread(tx, p.id, me.id);
    await systemLine(tx, p.id, body.visibility === "public" ? "Party is open. Your followers have been told." : "Private party. Share the link to fill seats.");
    if (opts.rematchOf) await systemLine(tx, p.id, "Rematch! Same people, new questions.");
    // A crew party asks the whole crew (crewmates count as connected) and lands in the crew's chat.
    const crewmates = crew ? (await tx.select({ id: crewMembers.userId }).from(crewMembers).where(and(eq(crewMembers.crewId, crew.id), ne(crewMembers.userId, me.id)))).map((m) => m.id) : [];
    if (crew) {
      lines.push(await partyCardLine(tx, await crewThreadId(tx, crew.id), p.id, me.id, `${me.displayName} started a crew party: ${p.title}`));
    }
    // Same guards as inviting later; a refused invite refuses the whole party, so nothing is half made.
    const invited = await inviteToParty(tx, p, me, [...body.inviteUserIds, ...crewmates, ...(opts.alsoInvite ?? [])]);
    if (opts.challenged) {
      await tx.insert(partyInvites).values({ partyId: p.id, inviteeId: opts.challenged, inviterId: me.id }).onConflictDoNothing();
      invited.push(opts.challenged);
    }
    return { party: p, invited };
  });
  if (party.visibility === "public") await notify.add("party_created", { kind: "party_created", partyId: party.id, hostId: me.id });
  if (invited.length) await notify.add("party_invite", { kind: "party_invite", partyId: party.id, fromUserId: me.id, toUserIds: invited });
  // Sealed sets are built now, so they're ready long before start and a failure reaches the host in time (ADR 0002).
  // With files on the way, the questions service builds it once they're read (sealWhenFilesRead).
  if (body.mode === "sealed" && !body.awaitFiles) await enqueueSealedSet(party.id, "create");
  await partyJobs.add("start", { kind: "start", partyId: party.id }, { delay: Math.max(0, startsAt.getTime() - Date.now()), jobId: `start-${party.id}` });
  return { party, lines };
}

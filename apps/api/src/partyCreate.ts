/**
 * Making a party: the one path for the builder (POST /parties), a Challenge (ADR 0019), a Rematch and a crew
 * party. Stakes are checked against the current limits, a host's cash prize is held, a sealed host is
 * seated, the party's chat opens, invites go out, and the set starts building (ADR 0002). A party made from a
 * template keeps a copy of it; one with host-written questions is curate and never free; every curate party with
 * money stays inside the caps (ADR 0015).
 */
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { takeSeat, cleanName,
  canOfferNonCashPrize, curateHostType, crewMembers, crews, db, getPartyConfig, joinPartyThread, ledger, parties, partyCardLine, partyFiles,
  partyPlayers, partyPrizes, prospectiveHost, systemLine, crewThreadId, latestStart, inviteExpiry, writeChallenge, type Acting, type Party, type Tx, type User,
} from "@contestly/db";
import { notifyQueue, partyQueue } from "@contestly/queue";
import { BRAND_NOT_VERIFIED, BRAND_ROLE_FORBIDDEN, SPLITS, challengeOpeningLine, checkStakes, isFreeParty, inferCategory, isGoods, postsToCorner, startsAtFor, type ChatMessage, type CreatePartyInput, type PartyTemplateCopy } from "@contestly/shared";
import { httpError } from "./httpError.js";
import { inviteToParty } from "./invites.js";
import { enqueueSealedSet } from "./questionSet.js";
import { assertHostQuestionsSafe, assertHostWrittenStakes, queueHostChecks, writeHostQuestions } from "./hostQuestions.js";
import { currentHostRules } from "./partyTemplates.js";
import { challengeSeats, checkChallenge } from "./challenges.js";

const notify = notifyQueue();
const partyJobs = partyQueue();

export interface CreateOptions {
  /** This party is the rematch of that one: its source files come along. */
  rematchOf?: string;
  /** More people to invite (the connection rule applies), beyond the builder's own short list: a rematch's players. */
  alsoInvite?: string[];
  /** The party's copy of the template the body was prefilled from (withTemplate in partyTemplates.ts). */
  template?: PartyTemplateCopy | null;
  /** Created as this brand (ADR 0017): it publicly hosts the party and funds its prize; the creator isn't seated. */
  brand?: Acting | null;
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

export async function createParty(me: User, input: CreatePartyInput, opts: CreateOptions = {}): Promise<Created> {
  const now = new Date();
  // A challenge (ADR 0019): checked first; always private, a seat for each person asked, and it starts when they're
  // ready, so startsAt is the latest it could (the expiry plus the window) until someone accepts.
  const challengees = input.challenge ? await checkChallenge(me, input, opts.brand) : null;
  const body = {
    ...input, title: await cleanName("partyTitle", input.title),
    ...(input.challenge ? { visibility: "private" as const, maxPlayers: await challengeSeats(input.challenge.invitees.length) } : {}),
  };
  const startsAt = body.challenge ? latestStart(body.challenge, now) : startsAtFor(body);
  // The server decides: the current limits, and whether this host may offer goods (canOfferNonCashPrize, the one place that says).
  const brandId = opts.brand?.account.id ?? null;
  const [cfg, host, hostRules] = await Promise.all([getPartyConfig(), prospectiveHost(me.id, brandId), currentHostRules()]);
  const [refused] = checkStakes(body, cfg.limits, canOfferNonCashPrize(host));
  if (refused) throw httpError(422, refused);
  // An unverified brand hosts free parties only: approval unlocks entry fees, cash prizes and goods (ADR 0017 §7).
  if (host.isBrand && !host.isVerified && !isFreeParty(body)) throw httpError(422, BRAND_NOT_VERIFIED);
  if (brandId && body.crewId) throw httpError(422, "brand_crew_party");
  // A Host funds a cash prize from the brand's wallet only up to the brand's host spending limit; owners and admins
  // up to the caps above (ADR 0017 §3).
  const brand = opts.brand;
  if (brand?.role === "host" && body.funding === "host" && body.prizeKind === "cash" && body.hostPoolKobo > brand.brand.hostSpendLimitKobo) {
    throw httpError(403, BRAND_ROLE_FORBIDDEN, { capability: "parties.fund", role: "host", limitKobo: brand.brand.hostSpendLimitKobo });
  }
  /** Whose wallet the prize comes from: the party's public host. */
  const funder = brandId ?? me.id;
  // ADR 0015: a template party is never free; host-written questions add the caps, the share, the safety filter
  // on the host's words, and curate mode (the host knows those answers, so they host and don't play).
  const template = opts.template ?? null;
  // A curate host sees every answer, generated or their own, so every curate party with money takes the caps too.
  const mode = body.hostQuestions.length ? "curate" : body.mode;
  assertHostWrittenStakes({ ...body, mode, fromTemplate: !!template, hostType: curateHostType(host) }, body.hostQuestions.length, hostRules);
  assertHostQuestionsSafe(body.hostQuestions, body.brief);
  const lines: ChatMessage[] = [];
  const { party, invited, hostChecks } = await db.transaction(async (tx) => {
    const crew = body.crewId ? await crewForParty(tx, body.crewId, me.id) : null;
    const [p] = await tx.insert(parties).values({ createdByUserId: me.id, brandId, title: body.title, brief: body.brief, category: body.category ?? inferCategory(body.brief), difficulty: body.difficulty, formats: body.formats, mode, questionsStatus: mode === "sealed" ? "generating" : "not_started", entryKobo: body.entryKobo, maxPlayers: body.maxPlayers, questionCount: body.questionCount, questionSeconds: body.secondsPerQuestion, funding: body.funding, hostPoolKobo: body.hostPoolKobo, prizeKind: body.prizeKind, split: [...SPLITS[body.split].shares], limits: cfg.limits, visibility: body.visibility, coverColor: body.coverColor, coverEmoji: body.coverEmoji, startsAt, crewId: crew?.id, rematchOf: opts.rematchOf, isSim: me.isSim, template, hostRules }).returning();
    // The host's cash prize is held now, so it can't be spent elsewhere: paid out by place at settlement, released if cancelled.
    // Goods move no money: one fulfilment record per winning place at settlement.
    if (body.funding === "host" && body.prizeKind === "cash") await ledger.hold(tx, { userId: funder, amountKobo: body.hostPoolKobo, type: "party_fund", refType: "party", refId: p.id, idempotencyKey: `party_fund:${p.id}` });
    if (isGoods(body.prizeKind)) await tx.insert(partyPrizes).values(body.places.map((g, i) => ({ partyId: p.id, place: i + 1, text: g.text, valueKobo: g.valueKobo ?? null })));
    // A sealed party's host plays: seated, and pooled hosts pay their own entry like everyone else.
    // A curate host reviews the questions and so never plays: not seated, never charged an entry.
    // Brands host; they never play (ADR 0017 §6): a brand's party seats nobody for hosting it.
    if (mode === "sealed" && !brandId) {
      await takeSeat(tx, p, me.id, body.funding === "pooled" ? body.entryKobo : 0);
    }
    const hostChecks = await writeHostQuestions(tx, p, body.hostQuestions, me.id);
    if (opts.rematchOf) await copySources(tx, opts.rematchOf, p.id, me.id);
    // The host's team is in the party's chat whether or not they play.
    await joinPartyThread(tx, p.id, me.id);
    await systemLine(tx, p.id, body.challenge ? challengeOpeningLine(me.displayName, challengees!.map((c) => c.user.displayName))
      : body.visibility === "public" ? "Party is open." : "Private party. Share the link to fill seats.");
    if (opts.rematchOf) await systemLine(tx, p.id, "Rematch! Same people, new questions.");
    // A crew party asks the whole crew (crewmates count as connected) and lands in the crew's chat.
    const crewmates = crew ? (await tx.select({ id: crewMembers.userId }).from(crewMembers).where(and(eq(crewMembers.crewId, crew.id), ne(crewMembers.userId, me.id)))).map((m) => m.id) : [];
    if (crew) {
      lines.push(await partyCardLine(tx, await crewThreadId(tx, crew.id), p.id, me.id, `${me.displayName} started a crew party: ${p.title}`));
    }
    // Same guards as inviting later; a refused invite refuses the whole party, so nothing is half made.
    const invited = await inviteToParty(tx, p, me, [...body.inviteUserIds, ...crewmates, ...(opts.alsoInvite ?? [])]);
    // A challenge's people are asked in their DMs instead (the DM rule was checked, not the connection rule).
    if (body.challenge) lines.push(...await writeChallenge(tx, p, me, body.challenge, challengees!, now));
    return { party: { ...p, hostQuestionCount: body.hostQuestions.length }, invited, hostChecks };
  });
  // The model safety check on the host's own words, once they've committed (ADR 0015).
  await queueHostChecks(hostChecks);
  // A public party goes up on the host's corner and pings its followers; a private one does neither (postsToCorner).
  if (postsToCorner(party.visibility)) await notify.add("party_created", { kind: "party_created", partyId: party.id, hostId: funder });
  if (invited.length) await notify.add("party_invite", { kind: "party_invite", partyId: party.id, fromUserId: me.id, toUserIds: invited });
  // Sealed sets are built now, so they're ready long before start and a failure reaches the host in time (ADR 0002).
  // With files on the way, the questions service builds it once they're read (sealWhenFilesRead).
  if (mode === "sealed" && !body.awaitFiles) await enqueueSealedSet(party.id, "create");
  await partyJobs.add("start", { kind: "start", partyId: party.id }, { delay: Math.max(0, startsAt.getTime() - Date.now()), jobId: `start-${party.id}` });
  if (body.challenge) {
    const expiresAt = inviteExpiry(body.challenge, now);
    await partyJobs.add("challenge_expire", { kind: "challenge_expire", partyId: party.id }, { delay: Math.max(0, expiresAt.getTime() - Date.now()), jobId: `challenge-expire-${party.id}` });
  }
  return { party, lines };
}

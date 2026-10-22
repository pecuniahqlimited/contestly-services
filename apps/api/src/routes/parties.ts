import type { FastifyInstance } from "fastify";
import { and, eq, inArray, desc, asc, count } from "drizzle-orm";
import { db, users, parties, partyPlayers, partyPrizes, chatMessages, follows, ledger, getPartyConfig, isHostTeam, prospectiveHost, canOfferNonCashPrize } from "@contestly/db";
import { SIGN_UP_REQUIRED, isStaked, checkStakes, createPartySchema, inferCategory, inviteToPartySchema, isGoods, questionDisclosure, SPLITS, startsAtFor, visibleLimits } from "@contestly/shared";
import { notifyQueue, partyQueue } from "@contestly/queue";
import { requireSession, requireUser, uuidParam } from "../auth.js";
import { barredFromPlaying } from "../drafts.js";
import { enqueueSealedSet } from "../questionSet.js";
import { partySummaries } from "../partySummaries.js";
import { potKobo } from "../places.js";
import { acceptInvite, dismissInvite, inviteToParty, partyLinks, pendingInviter } from "../invites.js";

const notify = notifyQueue();
const partyJobs = partyQueue();

export async function partiesRoutes(app: FastifyInstance) {
  /** Discover feed. ?filter=following|brands|soon. Personalised by the viewer's interests when signed in. */
  app.get("/parties", async (req) => {
    const me = req.auth?.user;
    const { filter } = (req.query ?? {}) as { filter?: string };
    const rows = await db.select().from(parties)
      .where(and(inArray(parties.status, ["open", "live"]), eq(parties.visibility, "public")))
      .orderBy(asc(parties.startsAt)).limit(50);
    let cards = await partySummaries(rows, me?.id);
    if (filter === "brands") cards = cards.filter((c) => c.host.isBrand);
    if (filter === "following" && me) {
      const f = await db.select({ id: follows.followeeId }).from(follows).where(eq(follows.followerId, me.id));
      const ids = new Set(f.map((x) => x.id));
      cards = cards.filter((c) => ids.has(c.host.id));
    }
    if (!filter && me?.interests.length) cards.sort((a, b) => Number(me.interests.includes(b.category)) - Number(me.interests.includes(a.category)));
    return cards;
  });

  /** What the signed-in host may choose in the Stakes scene now, the rake a pot preview takes, and whether they may offer goods. */
  app.get("/parties/limits", async (req) => {
    const me = requireUser(req);
    const [cfg, host] = await Promise.all([getPartyConfig(), prospectiveHost(me.id)]);
    return { limits: visibleLimits(cfg.limits), rakeBps: cfg.rakeBps, hostCutBps: cfg.hostCutBps, canOfferGoods: canOfferNonCashPrize(host) };
  });

  app.post("/parties", async (req, reply) => {
    const me = requireUser(req);
    const body = createPartySchema.parse(req.body);
    const startsAt = startsAtFor(body);
    // The server decides: the current limits, and whether this host may offer goods (canOfferNonCashPrize, the one place that says).
    const [cfg, host] = await Promise.all([getPartyConfig(), prospectiveHost(me.id)]);
    const [refused] = checkStakes(body, cfg.limits, canOfferNonCashPrize(host));
    if (refused) return reply.code(422).send({ error: refused });
    const { party, invited } = await db.transaction(async (tx) => {
      const [p] = await tx.insert(parties).values({ createdByUserId: me.id, title: body.title, brief: body.brief, category: body.category ?? inferCategory(body.brief), difficulty: body.difficulty, formats: body.formats, mode: body.mode, questionsStatus: body.mode === "sealed" ? "generating" : "not_started", entryKobo: body.entryKobo, maxPlayers: body.maxPlayers, questionCount: body.questionCount, questionSeconds: body.secondsPerQuestion, funding: body.funding, hostPoolKobo: body.hostPoolKobo, prizeKind: body.prizeKind, split: [...SPLITS[body.split].shares], limits: cfg.limits, visibility: body.visibility, coverColor: body.coverColor, coverEmoji: body.coverEmoji, startsAt }).returning();
      // The host's cash prize is held now, so it can't be spent elsewhere: paid out by place at settlement, released if cancelled.
      // Goods move no money: one fulfilment record per winning place at settlement.
      if (body.funding === "host" && body.prizeKind === "cash") await ledger.hold(tx, { userId: me.id, amountKobo: body.hostPoolKobo, type: "party_fund", refType: "party", refId: p.id, idempotencyKey: `party_fund:${p.id}` });
      if (isGoods(body.prizeKind)) await tx.insert(partyPrizes).values(body.places.map((g, i) => ({ partyId: p.id, place: i + 1, text: g.text, valueKobo: g.valueKobo ?? null })));
      // A sealed party's host plays: seated, and pooled hosts pay their own entry like everyone else.
      // A curate host reviews the questions and so never plays: not seated, never charged an entry.
      if (body.mode === "sealed") {
        await ledger.charge(tx, { userId: me.id, amountKobo: body.funding === "pooled" ? body.entryKobo : 0, type: "party_entry", refType: "party", refId: p.id, idempotencyKey: `party_entry:${p.id}:${me.id}` });
        await tx.insert(partyPlayers).values({ partyId: p.id, userId: me.id });
      }
      await tx.insert(chatMessages).values({ partyId: p.id, system: true, text: body.visibility === "public" ? "Party is open. Your followers have been told." : "Private party. Share the link to fill seats." });
      // Same guards as inviting later; a refused invite refuses the whole party, so nothing is half made.
      return { party: p, invited: await inviteToParty(tx, p, me, body.inviteUserIds) };
    });
    if (body.visibility === "public") await notify.add("party_created", { kind: "party_created", partyId: party.id, hostId: me.id });
    if (invited.length) await notify.add("party_invite", { kind: "party_invite", partyId: party.id, fromUserId: me.id, toUserIds: invited });
    // Sealed sets are built now, so they're ready long before start and a failure reaches the host in time (ADR 0002).
    // With files on the way, the questions service builds it once they're read (sealWhenFilesRead).
    if (body.mode === "sealed" && !body.awaitFiles) await enqueueSealedSet(party.id, "create");
    await partyJobs.add("start", { kind: "start", partyId: party.id }, { delay: Math.max(0, startsAt.getTime() - Date.now()), jobId: `start-${party.id}` });
    const [summary] = await partySummaries([party], me.id);
    return reply.code(201).send({ ...summary, questions: questionDisclosure(party) });
  });

  app.get("/parties/:id", async (req, reply) => {
    const id = uuidParam(req);
    const [p] = await db.select().from(parties).where(eq(parties.id, id));
    if (!p) return reply.code(404).send({ error: "not_found" });
    const me = req.auth?.user;
    const [[summary], invitedBy] = await Promise.all([partySummaries([p], me?.id), pendingInviter(p.id, me?.id)]);
    const players = await db.select({ id: users.id, handle: users.handle, displayName: users.displayName, avatarEmoji: users.avatarEmoji, score: partyPlayers.score, rank: partyPlayers.rank, prizeKobo: partyPlayers.prizeKobo }).from(partyPlayers).innerJoin(users, eq(users.id, partyPlayers.userId)).where(eq(partyPlayers.partyId, id));
    const chat = await db.select({ m: chatMessages, handle: users.handle, avatarEmoji: users.avatarEmoji }).from(chatMessages).leftJoin(users, eq(users.id, chatMessages.userId)).where(eq(chatMessages.partyId, id)).orderBy(desc(chatMessages.createdAt)).limit(50);
    return { ...summary, brief: me && isHostTeam(p, me.id) ? p.brief : null, questions: questionDisclosure(p), invite: partyLinks(p.id), invitedBy, players, joined: !!me && players.some((x) => x.id === me.id), chat: chat.reverse().map((c) => ({ ...c.m, handle: c.handle, avatarEmoji: c.avatarEmoji })) };
  });

  /** Invite people I'm connected to. Players and the host's team, while the party is open (invites.ts has the guards). */
  app.post("/parties/:id/invites", async (req, reply) => {
    const me = requireUser(req);
    const id = uuidParam(req);
    const { userIds } = inviteToPartySchema.parse(req.body);
    const invited = await db.transaction(async (tx) => {
      const [p] = await tx.select().from(parties).where(eq(parties.id, id)).for("update");
      if (!p) throw Object.assign(new Error("not_found"), { statusCode: 404 });
      return inviteToParty(tx, p, me, userIds);
    });
    if (invited.length) await notify.add("party_invite", { kind: "party_invite", partyId: id, fromUserId: me.id, toUserIds: invited });
    return reply.code(201).send({ invited: invited.length });
  });

  /** The viewer turns down their invite to this party. Joining accepts it instead. */
  app.post("/parties/:id/invite/dismiss", async (req) => {
    const me = requireUser(req);
    await dismissInvite(uuidParam(req), me.id);
    return { status: "dismissed" as const };
  });

  /** Join: charges bonus coins first, then cash, inside one transaction with a row lock on the party. */
  app.post("/parties/:id/join", async (req, reply) => {
    const me = requireSession(req);
    const id = uuidParam(req);
    const result = await db.transaction(async (tx) => {
      const [p] = await tx.select().from(parties).where(eq(parties.id, id)).for("update");
      if (!p) return { status: 404, body: { error: "not_found" } };
      if (p.status !== "open") return { status: 409, body: { error: "party_not_open" } };
      // Guests play free parties only: no entry, no cash to win (and they can't win goods either; settlement skips them).
      if (me.isGuest && isStaked(p)) return { status: 403, body: { error: SIGN_UP_REQUIRED } };
      if (await barredFromPlaying(p, me.id)) return { status: 403, body: { error: "seen_the_questions_cannot_play" } };
      const [{ n }] = await tx.select({ n: count() }).from(partyPlayers).where(eq(partyPlayers.partyId, id));
      if (Number(n) >= p.maxPlayers) return { status: 409, body: { error: "party_full" } };
      const already = await tx.select().from(partyPlayers).where(and(eq(partyPlayers.partyId, id), eq(partyPlayers.userId, me.id)));
      if (already.length) return { status: 200, body: { joined: true, replayed: true } };
      const paid = await ledger.charge(tx, { userId: me.id, amountKobo: p.entryKobo, type: "party_entry", refType: "party", refId: p.id, idempotencyKey: `party_entry:${p.id}:${me.id}` });
      await tx.insert(partyPlayers).values({ partyId: id, userId: me.id });
      await acceptInvite(tx, id, me.id);
      await tx.insert(chatMessages).values({ partyId: id, system: true, text: `${me.displayName} joined` });
      return { status: 201, body: { joined: true, paid, potKobo: potKobo(p, Number(n) + 1) } };
    });
    req.log.info({ partyId: id, userId: me.id, status: result.status }, "party join");
    return reply.code(result.status).send(result.body);
  });
}

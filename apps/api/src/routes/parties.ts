import type { FastifyInstance } from "fastify";
import { and, eq, inArray, asc, count } from "drizzle-orm";
import { db, users, parties, partyPlayers, partyPrizes, follows, ledger, getPartyConfig, leaveSeat, takeSeat, isHostTeam, joinPartyThread, messagesPage, partyCardLine, partyThreadId, prospectiveHost, canOfferNonCashPrize, systemLine, crewMembers } from "@contestly/db";
import { type ChatMessage, type LeavePartyResponse, type PlayerLeftEvent, PARTY_EVENTS_CHANNEL, MAX_INVITES_PER_PARTY, SIGN_UP_REQUIRED, SPLIT_IDS, SPLITS, isStaked, createPartySchema, inviteToPartySchema, isGoods, questionDisclosure, visibleLimits } from "@contestly/shared";
import { notifyQueue } from "@contestly/queue";
import { requireSession, requireUser, uuidParam } from "../auth.js";
import { barredFromPlaying } from "../drafts.js";
import { partySummaries } from "../partySummaries.js";
import { potKobo } from "../places.js";
import { publishLine } from "../chats.js";
import { valkey } from "../redis.js";
import { createParty } from "../partyCreate.js";
import { acceptInvite, dismissInvite, inviteToParty, partyLinks, pendingInviter } from "../invites.js";

const notify = notifyQueue();
/** Party detail carries the latest lines; older ones page in from GET /chats/:threadId/messages. */
const PARTY_DETAIL_CHAT_LINES = 50;
const REMATCH_PREFIX = "Rematch: ";

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
    const { party, lines } = await createParty(me, createPartySchema.parse(req.body));
    for (const line of lines) await publishLine(line);
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
    const threadId = await partyThreadId(db, p.id);
    const { messages } = await messagesPage(threadId, { limit: PARTY_DETAIL_CHAT_LINES });
    return { ...summary, brief: me && isHostTeam(p, me.id) ? p.brief : null, questions: questionDisclosure(p), invite: partyLinks(p.id), invitedBy, players, joined: !!me && players.some((x) => x.id === me.id), threadId, chat: messages };
  });

  /**
   * Rematch from a finished party, for anyone who played it (or its host's team). One per party: the first tap
   * makes it and everyone after lands in the same one; joining is the usual POST /parties/:id/join. Same brief,
   * sources, format and seats; a host's prize (cash or goods) carries over only when the original host starts it,
   * otherwise it's a pooled party at the same entry.
   */
  app.post("/parties/:id/rematch", async (req, reply) => {
    const me = requireUser(req);
    const id = uuidParam(req);
    const existing = async () => (await db.select({ id: parties.id }).from(parties).where(eq(parties.rematchOf, id)))[0];
    const [p] = await db.select().from(parties).where(eq(parties.id, id));
    if (!p) return reply.code(404).send({ error: "not_found" });
    if (p.status !== "finished") return reply.code(409).send({ error: "party_not_finished" });
    const seats = await db.select({ userId: partyPlayers.userId }).from(partyPlayers).innerJoin(users, eq(users.id, partyPlayers.userId))
      .where(and(eq(partyPlayers.partyId, id), eq(users.isGuest, false)));
    if (!isHostTeam(p, me.id) && !seats.some((s) => s.userId === me.id)) return reply.code(403).send({ error: "not_in_party" });
    const already = await existing();
    if (already) return { partyId: already.id, created: false };

    const sameHost = isHostTeam(p, me.id);
    const goods = sameHost && isGoods(p.prizeKind) ? await db.select().from(partyPrizes).where(eq(partyPrizes.partyId, id)).orderBy(asc(partyPrizes.place)) : [];
    const split = SPLIT_IDS.find((sid) => SPLITS[sid].shares.join() === p.split.join()) ?? SPLIT_IDS[0];
    const inCrew = p.crewId ? (await db.select().from(crewMembers).where(and(eq(crewMembers.crewId, p.crewId), eq(crewMembers.userId, me.id)))).length > 0 : false;
    const body = createPartySchema.parse({
      title: (p.title.startsWith(REMATCH_PREFIX) ? p.title : `${REMATCH_PREFIX}${p.title}`).slice(0, 60), brief: p.brief, category: p.category, difficulty: p.difficulty,
      formats: p.formats, mode: "sealed", questionCount: p.questionCount, secondsPerQuestion: p.questionSeconds, maxPlayers: p.maxPlayers, entryKobo: p.entryKobo,
      funding: sameHost ? p.funding : "pooled", hostPoolKobo: sameHost ? p.hostPoolKobo : 0, prizeKind: sameHost ? p.prizeKind : "cash",
      places: goods.map((g) => ({ text: g.text, valueKobo: g.valueKobo ?? undefined })), split,
      visibility: p.visibility, coverColor: p.coverColor, coverEmoji: p.coverEmoji, crewId: inCrew ? p.crewId : undefined,
    });
    let party;
    try {
      ({ party } = await createParty(me, body, { rematchOf: id, alsoInvite: seats.map((s) => s.userId).slice(0, MAX_INVITES_PER_PARTY - 1) }));
    } catch (e) {
      const lost = (e as { code?: string }).code === "23505" ? await existing() : undefined; // someone else's tap made it first
      if (lost) return { partyId: lost.id, created: false };
      throw e;
    }
    // The old party's chat points everyone at it.
    await publishLine(await partyCardLine(db, await partyThreadId(db, id), party.id, me.id, `${me.displayName} started a rematch`));
    return reply.code(201).send({ partyId: party.id, created: true });
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
    let line: ChatMessage | undefined;
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
      const paid = await takeSeat(tx, p, me.id, p.entryKobo);
      await acceptInvite(tx, id, me.id);
      await joinPartyThread(tx, id, me.id);
      line = await systemLine(tx, id, `${me.displayName} joined`);
      return { status: 201, body: { joined: true, paid, potKobo: potKobo(p, Number(n) + 1) } };
    });
    if (line) await publishLine(line);
    req.log.info({ partyId: id, userId: me.id, status: result.status }, "party join");
    return reply.code(result.status).send(result.body);
  });

  /**
   * Leave: a seated player who isn't the host, while the party is open and outside the leave lock
   * (CLAUDE.md, Parties). The whole entry comes back as it was paid, in one transaction with the row
   * lock; a retry or a double tap gets the same result. The lobby room hears it over party:events.
   */
  app.post("/parties/:id/leave", async (req, reply) => {
    const me = requireSession(req);
    const id = uuidParam(req);
    const result = await db.transaction(async (tx) => {
      const [p] = await tx.select().from(parties).where(eq(parties.id, id)).for("update");
      if (!p) return null;
      return { p, out: await leaveSeat(tx, p, me) };
    });
    if (!result) return reply.code(404).send({ error: "not_found" });
    const { p, out } = result;
    req.log.info({ partyId: id, userId: me.id, outcome: out.ok ? (out.replayed ? "replayed" : "left") : out.error }, "party leave");
    if (!out.ok) return reply.code(out.status).send({ error: out.error });
    const seats = { taken: out.taken, max: p.maxPlayers };
    if (!out.replayed) {
      if (out.line) await publishLine(out.line);
      const ev: PlayerLeftEvent = { partyId: id, status: "player_left", userId: me.id, seats };
      await valkey().publish(PARTY_EVENTS_CHANNEL, JSON.stringify(ev));
    }
    const body: LeavePartyResponse = { left: true, replayed: out.replayed, refund: out.refund, potKobo: potKobo(p, out.taken), seats };
    return body;
  });
}

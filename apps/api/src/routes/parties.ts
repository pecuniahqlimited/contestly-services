import type { FastifyInstance } from "fastify";
import { and, eq, inArray, desc, asc, sql, count } from "drizzle-orm";
import { db, users, parties, partyPlayers, chatMessages, follows, ledger, publicHost, publicHosts, getPartyConfig } from "@contestly/db";
import { createPartySchema, inferCategory } from "@contestly/shared";
import { notifyQueue, partyQueue } from "@contestly/queue";
import { requireUser, uuidParam } from "../auth.js";
import { barredFromPlaying } from "../drafts.js";

const notify = notifyQueue();
const partyJobs = partyQueue();

export const potKobo = (p: { funding: string; hostPoolKobo: number; entryKobo: number }, players: number) => (p.funding === "host" ? p.hostPoolKobo : p.entryKobo * players);

/** Always disclosed in the lobby and the game: questions are AI-generated, and whether the set is sealed or host-reviewed. */
const questionDisclosure = (p: { mode: "sealed" | "curate" }) => ({ aiGenerated: true, review: p.mode === "curate" ? "host_reviewed" : "sealed" });

export async function partiesRoutes(app: FastifyInstance) {
  /** Discover feed. ?filter=following|brands|soon. Personalised by the viewer's interests when signed in. */
  app.get("/parties", async (req) => {
    const me = req.auth?.user;
    const { filter } = (req.query ?? {}) as { filter?: string };
    let rows = await db.select({ p: parties, players: sql<number>`(select count(*) from ${partyPlayers} pp where pp.party_id = ${parties.id})` })
      .from(parties)
      .where(and(inArray(parties.status, ["open", "live"]), eq(parties.visibility, "public")))
      .orderBy(asc(parties.startsAt)).limit(50);
    const hosts = await publicHosts(rows.map((r) => r.p));
    if (filter === "brands") rows = rows.filter((r) => hosts.get(r.p.id)!.isBrand);
    if (filter === "following" && me) {
      const f = await db.select({ id: follows.followeeId }).from(follows).where(eq(follows.followerId, me.id));
      const ids = new Set(f.map((x) => x.id));
      rows = rows.filter((r) => ids.has(hosts.get(r.p.id)!.id));
    }
    if (!filter && me?.interests.length) rows.sort((a, b) => Number(me.interests.includes(b.p.category)) - Number(me.interests.includes(a.p.category)));
    return rows.map((r) => ({ ...r.p, host: hosts.get(r.p.id), playerCount: Number(r.players), potKobo: potKobo(r.p, Number(r.players)) }));
  });

  app.post("/parties", async (req, reply) => {
    const me = requireUser(req);
    const body = createPartySchema.parse(req.body);
    const startsAt = new Date(Date.now() + body.startsInMinutes * 60_000);
    const split = body.split ?? (await getPartyConfig()).defaultSplit;
    const party = await db.transaction(async (tx) => {
      const [p] = await tx.insert(parties).values({ createdByUserId: me.id, title: body.title, brief: body.brief, category: body.category ?? inferCategory(body.brief), difficulty: body.difficulty, formats: body.formats, mode: body.mode, entryKobo: body.entryKobo, maxPlayers: body.maxPlayers, questionCount: body.questionCount, questionSeconds: body.secondsPerQuestion, funding: body.funding, hostPoolKobo: body.hostPoolKobo, prizeKind: body.prizeKind, prizeText: body.prizeText, prizeValueKobo: body.prizeValueKobo, split, visibility: body.visibility, coverColor: body.coverColor, coverEmoji: body.coverEmoji, startsAt }).returning();
      // Host funds a cash pot up front so it can't be spent elsewhere; refunded by the worker if the party is cancelled.
      // A non-cash prize moves no money: it becomes a fulfilment record at settlement.
      if (body.funding === "host" && body.prizeKind === "cash") await ledger.post(tx, { userId: me.id, kind: "cash", amountKobo: -body.hostPoolKobo, type: "party_fund", refType: "party", refId: p.id, idempotencyKey: `party_fund:${p.id}` });
      // A sealed party's host plays: seated, and pooled hosts pay their own entry like everyone else.
      // A curate host reviews the questions and so never plays: not seated, never charged an entry.
      if (body.mode === "sealed") {
        await ledger.charge(tx, { userId: me.id, amountKobo: body.funding === "pooled" ? body.entryKobo : 0, type: "party_entry", refType: "party", refId: p.id, idempotencyKey: `party_entry:${p.id}:${me.id}` });
        await tx.insert(partyPlayers).values({ partyId: p.id, userId: me.id });
      }
      await tx.insert(chatMessages).values({ partyId: p.id, system: true, text: body.visibility === "public" ? "Party is live. Followers have been notified." : "Private party. Share the link to fill seats." });
      return p;
    });
    const seated = body.mode === "sealed" ? 1 : 0;
    if (body.visibility === "public") await notify.add("party_created", { kind: "party_created", partyId: party.id, hostId: me.id });
    if (body.inviteUserIds.length) await notify.add("party_invite", { kind: "party_invite", partyId: party.id, fromUserId: me.id, toUserIds: body.inviteUserIds });
    await partyJobs.add("start", { kind: "start", partyId: party.id }, { delay: Math.max(0, startsAt.getTime() - Date.now()), jobId: `start-${party.id}` });
    return reply.code(201).send({ ...party, questions: questionDisclosure(party), playerCount: seated, potKobo: potKobo(party, seated) });
  });

  app.get("/parties/:id", async (req, reply) => {
    const id = uuidParam(req);
    const [p] = await db.select().from(parties).where(eq(parties.id, id));
    if (!p) return reply.code(404).send({ error: "not_found" });
    const host = await publicHost(p);
    const players = await db.select({ id: users.id, handle: users.handle, displayName: users.displayName, avatarEmoji: users.avatarEmoji, score: partyPlayers.score, rank: partyPlayers.rank, prizeKobo: partyPlayers.prizeKobo }).from(partyPlayers).innerJoin(users, eq(users.id, partyPlayers.userId)).where(eq(partyPlayers.partyId, id));
    const chat = await db.select({ m: chatMessages, handle: users.handle, avatarEmoji: users.avatarEmoji }).from(chatMessages).leftJoin(users, eq(users.id, chatMessages.userId)).where(eq(chatMessages.partyId, id)).orderBy(desc(chatMessages.createdAt)).limit(50);
    const me = req.auth?.user;
    return { ...p, questions: questionDisclosure(p), host, players, playerCount: players.length, potKobo: potKobo(p, players.length), joined: !!me && players.some((x) => x.id === me.id), chat: chat.reverse().map((c) => ({ ...c.m, handle: c.handle, avatarEmoji: c.avatarEmoji })) };
  });

  /** Join: charges bonus coins first, then cash, inside one transaction with a row lock on the party. */
  app.post("/parties/:id/join", async (req, reply) => {
    const me = requireUser(req);
    const id = uuidParam(req);
    const result = await db.transaction(async (tx) => {
      const [p] = await tx.select().from(parties).where(eq(parties.id, id)).for("update");
      if (!p) return { status: 404, body: { error: "not_found" } };
      if (p.status !== "open") return { status: 409, body: { error: "party_not_open" } };
      if (await barredFromPlaying(p, me.id)) return { status: 403, body: { error: "seen_the_questions_cannot_play" } };
      const [{ n }] = await tx.select({ n: count() }).from(partyPlayers).where(eq(partyPlayers.partyId, id));
      if (Number(n) >= p.maxPlayers) return { status: 409, body: { error: "party_full" } };
      const already = await tx.select().from(partyPlayers).where(and(eq(partyPlayers.partyId, id), eq(partyPlayers.userId, me.id)));
      if (already.length) return { status: 200, body: { joined: true, replayed: true } };
      const paid = await ledger.charge(tx, { userId: me.id, amountKobo: p.entryKobo, type: "party_entry", refType: "party", refId: p.id, idempotencyKey: `party_entry:${p.id}:${me.id}` });
      await tx.insert(partyPlayers).values({ partyId: id, userId: me.id });
      await tx.insert(chatMessages).values({ partyId: id, system: true, text: `${me.displayName} joined` });
      return { status: 201, body: { joined: true, paid, potKobo: potKobo(p, Number(n) + 1) } };
    });
    req.log.info({ partyId: id, userId: me.id, status: result.status }, "party join");
    return reply.code(result.status).send(result.body);
  });
}

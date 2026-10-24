import type { FastifyInstance } from "fastify";
import { and, asc, count, desc, eq, gte, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import {
  adminActions, db, ledgerAccounts, ledgerEntries, parties, partyPlayers, partyQuestionEvents, partyQuestions, prizeFulfilments, publicHosts, recordAdminAction, users, type Party,
} from "@contestly/db";
import { partyQueue } from "@contestly/queue";
import {
  ADMIN_PARTY_STATUSES, ADMIN_RECENT_PARTY_DAYS, adminCancelResponseSchema, adminPartiesQuerySchema, adminPartiesResponseSchema, adminPartyDetailSchema,
  adminReasonBodySchema, type AdminPartyRow, type Person,
} from "@contestly/shared";
import { requireAdmin, uuidParam } from "../auth.js";
import { actionsView } from "../adminViews.js";
import { httpError } from "../httpError.js";
import { toPerson } from "../people.js";

const partyJobs = partyQueue();
const DAY_MS = 24 * 60 * 60 * 1000;
type PartyStatus = (typeof ADMIN_PARTY_STATUSES)[number];
const CANCELLABLE: readonly string[] = ["open", "live"];

/** Default view: live and scheduled, plus finished in the last few days. */
function statusWhere(statusParam: string | undefined): SQL {
  if (!statusParam) {
    return or(inArray(parties.status, ["live", "open"]), and(eq(parties.status, "finished"), gte(parties.endedAt, new Date(Date.now() - ADMIN_RECENT_PARTY_DAYS * DAY_MS))))!;
  }
  const wanted = statusParam.split(",").map((s) => s.trim()).filter((s): s is PartyStatus => (ADMIN_PARTY_STATUSES as readonly string[]).includes(s));
  if (!wanted.length) throw httpError(400, "invalid status");
  return inArray(parties.status, wanted);
}

async function partyRows(list: Party[]): Promise<AdminPartyRow[]> {
  if (!list.length) return [];
  const ids = list.map((p) => p.id);
  const [hosts, creators, counts] = await Promise.all([
    publicHosts(list),
    db.select().from(users).where(inArray(users.id, [...new Set(list.map((p) => p.createdByUserId))])),
    db.select({ partyId: partyPlayers.partyId, n: count() }).from(partyPlayers).where(inArray(partyPlayers.partyId, ids)).groupBy(partyPlayers.partyId),
  ]);
  const creatorOf = new Map(creators.map((u) => [u.id, toPerson(u)]));
  const countOf = new Map(counts.map((c) => [c.partyId, Number(c.n)]));
  return list.map((p) => {
    const h = hosts.get(p.id)!;
    const host: Person = { id: h.id, handle: h.handle, displayName: h.displayName, avatarEmoji: h.avatarEmoji, isVerified: h.isVerified };
    return {
      id: p.id, title: p.title, status: p.status, mode: p.mode, visibility: p.visibility, startsAt: p.startsAt.toISOString(), endedAt: p.endedAt?.toISOString() ?? null,
      host, createdBy: creatorOf.get(p.createdByUserId)!, playerCount: countOf.get(p.id) ?? 0, maxPlayers: p.maxPlayers,
      entryKobo: p.entryKobo, funding: p.funding, prizeKind: p.prizeKind, hostPoolKobo: p.hostPoolKobo, questionsStatus: p.questionsStatus,
    };
  });
}

async function partyDetail(id: string) {
  const [p] = await db.select().from(parties).where(eq(parties.id, id));
  if (!p) throw httpError(404, "not_found");
  const [[row], players, setRows, [flags], money, fulfilments, actions] = await Promise.all([
    partyRows([p]),
    db.select({ u: users, pp: partyPlayers }).from(partyPlayers).innerJoin(users, eq(users.id, partyPlayers.userId)).where(eq(partyPlayers.partyId, id)).orderBy(asc(partyPlayers.rank), asc(partyPlayers.joinedAt)),
    db.select({ status: partyQuestions.status, reserve: partyQuestions.reserve }).from(partyQuestions).where(eq(partyQuestions.partyId, id)),
    db.select({ n: count() }).from(partyQuestionEvents).where(and(eq(partyQuestionEvents.partyId, id), eq(partyQuestionEvents.kind, "flag"))),
    db.select({ type: ledgerEntries.type, totalKobo: sql<number>`sum(${ledgerEntries.amountKobo})::bigint`, entries: count() })
      .from(ledgerEntries).where(and(eq(ledgerEntries.refType, "party"), eq(ledgerEntries.refId, id))).groupBy(ledgerEntries.type),
    db.select({ f: prizeFulfilments, u: users }).from(prizeFulfilments).innerJoin(users, eq(users.id, prizeFulfilments.winnerUserId)).where(eq(prizeFulfilments.partyId, id)).orderBy(asc(prizeFulfilments.place)),
    actionsView({ targetType: "party", targetId: id }),
  ]);
  const inPlay = setRows.filter((q) => !q.reserve);
  return adminPartyDetailSchema.parse({
    party: { ...row, split: p.split, limits: p.limits, questionCount: p.questionCount, questionSeconds: p.questionSeconds, category: p.category },
    players: players.map(({ u, pp }) => ({ person: toPerson(u), isGuest: u.isGuest, banned: !!u.bannedAt, joinedAt: pp.joinedAt.toISOString(), score: pp.score, rank: pp.rank, prizeKobo: pp.prizeKobo })),
    questions: {
      status: p.questionsStatus, error: p.questionsError, total: inPlay.length,
      played: inPlay.filter((q) => q.status === "played").length, voided: setRows.filter((q) => q.status === "voided").length, flags: Number(flags.n),
    },
    settlement: {
      byType: money.map((m) => ({ type: m.type, totalKobo: Number(m.totalKobo), entries: Number(m.entries) })),
      fulfilments: fulfilments.map(({ f, u }) => ({ place: f.place, winner: toPerson(u), prizeText: f.prizeText, status: f.status })),
    },
    actions,
  });
}

export async function adminPartiesRoutes(app: FastifyInstance) {
  app.get("/admin/parties", async (req) => {
    requireAdmin(req);
    const q = adminPartiesQuerySchema.parse(req.query);
    const where: SQL[] = [statusWhere(q.status)];
    if (q.q) where.push(ilike(parties.title, `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`));
    if (q.hostId) where.push(eq(parties.createdByUserId, q.hostId));
    const rows = await db.select().from(parties).where(and(...where)).orderBy(desc(parties.startsAt)).limit(q.limit);
    return adminPartiesResponseSchema.parse({ parties: await partyRows(rows) });
  });

  /** Host, stakes, seats, players, the set's state (never its content) and what money it moved. */
  app.get("/admin/parties/:id", async (req) => {
    requireAdmin(req);
    return partyDetail(uuidParam(req));
  });

  /**
   * Cancel a scheduled or live party. The worker refunds and cancels through its one cancel path
   * (never a ledger write here). Idempotent: asking again while it's queued, or after, changes nothing.
   */
  app.post("/admin/parties/:id/cancel", async (req) => {
    const admin = requireAdmin(req);
    const { reason } = adminReasonBodySchema.parse(req.body);
    const id = uuidParam(req);
    const outcome = await db.transaction(async (tx) => {
      const [p] = await tx.select().from(parties).where(eq(parties.id, id)).for("update");
      if (!p) throw httpError(404, "not_found");
      if (p.status === "cancelled") return { status: "cancelled" as const, replayed: true, enqueue: false };
      if (!CANCELLABLE.includes(p.status)) throw httpError(409, "party_finished");
      const [asked] = await tx.select({ id: adminActions.id }).from(adminActions)
        .where(and(eq(adminActions.targetType, "party"), eq(adminActions.targetId, id), eq(adminActions.action, "party.cancel"))).limit(1);
      if (asked) return { status: "cancelling" as const, replayed: true, enqueue: true };
      await recordAdminAction(tx, { adminUserId: admin.id, action: "party.cancel", targetType: "party", targetId: id, reason, before: { status: p.status }, after: { status: "cancelled" } });
      return { status: "cancelling" as const, replayed: false, enqueue: true };
    });
    // One job per party (jobId): asking twice can't queue two cancels.
    if (outcome.enqueue) await partyJobs.add("admin_cancel", { kind: "admin_cancel", partyId: id, reason }, { jobId: `admin-cancel-${id}` });
    return adminCancelResponseSchema.parse({ status: outcome.status, replayed: outcome.replayed });
  });
}

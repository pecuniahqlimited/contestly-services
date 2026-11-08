/**
 * Goods prize fulfilment (ADR 0017 §9): one record per winning place, owed by the party's public host (a brand).
 * The brand's team (prizes.fulfil) marks it arranged, then delivered; the winner can dispute one arranged or
 * delivered. Every step is a prize_fulfilment_events row. prize_ready goes out when it's arranged, and
 * prize_delivery_due on days 3 and 7 after the award while it isn't delivered, to both sides.
 */
import { and, desc, eq, inArray, lte, ne, sql } from "drizzle-orm";
import { FULFILMENT_NUDGE_DAYS, canMoveFulfilment, type FulfilmentStatus, type PrizeFulfilment } from "@contestly/shared";
import { db, type Tx } from "../client.js";
import { parties, prizeFulfilmentEvents, prizeFulfilments, users } from "../schema.js";
import { adminAlert } from "../alerts.js";
import { nudge } from "../nudges/record.js";
import { assertBrandCan, brandError, teamWith } from "./team.js";

type Conn = Tx | typeof db;
type Row = typeof prizeFulfilments.$inferSelect;
const DAY_MS = 86_400_000;

const person = (u: typeof users.$inferSelect) => ({ id: u.id, handle: u.handle, displayName: u.displayName, avatarEmoji: u.avatarEmoji, isVerified: u.isVerified });

/** The rows as the API returns them, with the party's title and both sides. */
async function views(conn: Conn, rows: Row[]): Promise<PrizeFulfilment[]> {
  if (!rows.length) return [];
  const [ps, us] = await Promise.all([
    conn.select({ id: parties.id, title: parties.title }).from(parties).where(inArray(parties.id, [...new Set(rows.map((r) => r.partyId))])),
    conn.select().from(users).where(inArray(users.id, [...new Set(rows.flatMap((r) => [r.winnerUserId, r.hostUserId]))])),
  ]);
  const title = new Map(ps.map((p) => [p.id, p.title]));
  const who = new Map(us.map((u) => [u.id, person(u)]));
  const iso = (d: Date | null) => d?.toISOString() ?? null;
  return rows.map((r) => ({
    id: r.id, partyId: r.partyId, partyTitle: title.get(r.partyId) ?? "", place: r.place, prizeText: r.prizeText, prizeValueKobo: r.prizeValueKobo,
    status: r.status, winner: who.get(r.winnerUserId)!, host: who.get(r.hostUserId)!, note: r.note, disputeNote: r.disputeNote,
    awardedAt: r.awardedAt.toISOString(), arrangedAt: iso(r.arrangedAt), deliveredAt: iso(r.deliveredAt), disputedAt: iso(r.disputedAt),
  }));
}

export async function prizesOwedBy(hostAccountId: string) {
  return views(db, await db.select().from(prizeFulfilments).where(eq(prizeFulfilments.hostUserId, hostAccountId)).orderBy(desc(prizeFulfilments.awardedAt)));
}
export async function prizesWonBy(userId: string) {
  return views(db, await db.select().from(prizeFulfilments).where(eq(prizeFulfilments.winnerUserId, userId)).orderBy(desc(prizeFulfilments.awardedAt)));
}

/** Who on the owing side hears about a prize: a brand's fulfilling team, or a person host themselves. */
async function hostSide(conn: Conn, hostAccountId: string): Promise<{ ids: string[]; name: string }> {
  const [host] = await conn.select().from(users).where(eq(users.id, hostAccountId));
  return { ids: host.isBrand ? await teamWith(conn, host.id, "prizes.fulfil") : [host.id], name: host.displayName };
}

async function partyTitle(conn: Conn, partyId: string) {
  const [p] = await conn.select({ title: parties.title }).from(parties).where(eq(parties.id, partyId));
  return p?.title ?? "";
}

const STAMP: Partial<Record<FulfilmentStatus, keyof Row>> = { arranged: "arrangedAt", delivered: "deliveredAt", disputed: "disputedAt" };

async function move(tx: Tx, row: Row, to: FulfilmentStatus, byUserId: string, note: string | null, now: Date) {
  if (!canMoveFulfilment(row.status, to)) throw brandError(409, "fulfilment_step_not_allowed", { from: row.status, to });
  const set: Partial<typeof prizeFulfilments.$inferInsert> = { status: to, updatedAt: now, [STAMP[to]!]: now };
  if (to === "disputed") set.disputeNote = note;
  else if (note) set.note = note;
  await tx.update(prizeFulfilments).set(set).where(eq(prizeFulfilments.id, row.id));
  await tx.insert(prizeFulfilmentEvents).values({ fulfilmentId: row.id, fromStatus: row.status, toStatus: to, byUserId, note, createdAt: now });
}

const lockRow = async (tx: Tx, id: string) => (await tx.select().from(prizeFulfilments).where(eq(prizeFulfilments.id, id)).for("update"))[0];

/**
 * The brand moves a prize on (prizes.fulfil): arranged (the winner and the brand's team get prize_ready), then
 * delivered. Asking for the state it's already in answers with it (replayed).
 */
export async function fulfilPrize(brandId: string, person: { id: string }, fulfilmentId: string, to: "arranged" | "delivered", note: string | null, now = new Date()) {
  return db.transaction(async (tx) => {
    await assertBrandCan(tx, brandId, person, "prizes.fulfil");
    const row = await lockRow(tx, fulfilmentId);
    if (!row || row.hostUserId !== brandId) throw brandError(404, "not_found");
    if (row.status === to) return { status: to, replayed: true };
    await move(tx, row, to, person.id, note, now);
    if (to === "arranged") {
      const [side, title] = await Promise.all([hostSide(tx, brandId), partyTitle(tx, row.partyId)]);
      const base = { fulfilmentId: row.id, partyId: row.partyId, title, brandName: side.name };
      const ref = { type: "prize" as const, id: row.id };
      await nudge(tx, { userId: row.winnerUserId, kind: "prize_ready", data: { ...base, for: "winner" }, ref, dedupeKey: `prize_ready:${row.id}:${row.winnerUserId}:${now.getTime()}` });
      for (const userId of side.ids) await nudge(tx, { userId, kind: "prize_ready", data: { ...base, for: "brand" }, ref, dedupeKey: `prize_ready:${row.id}:${userId}:${now.getTime()}` });
    }
    return { status: to, replayed: false };
  });
}

/** The winner disputes a prize that's arranged or delivered (it hasn't come, or isn't what was promised). A warning for admins. */
export async function disputePrize(winnerId: string, fulfilmentId: string, note: string, now = new Date()) {
  return db.transaction(async (tx) => {
    const row = await lockRow(tx, fulfilmentId);
    if (!row || row.winnerUserId !== winnerId) throw brandError(404, "not_found");
    if (row.status === "disputed") return { status: "disputed" as const, replayed: true };
    await move(tx, row, "disputed", winnerId, note, now);
    await adminAlert({
      kind: "prize.disputed", severity: "warning", subject: "A winner disputed a goods prize", dedupeKey: `prize_disputed:${row.id}`, dedupeWindowSeconds: 7 * 86_400,
      refType: "party", refId: row.partyId, details: { fulfilmentId: row.id, partyId: row.partyId, winnerId, hostId: row.hostUserId, from: row.status, note },
    }, tx);
    return { status: "disputed" as const, replayed: false };
  });
}

/**
 * The worker's hourly sweep: every prize not delivered whose day 3 or day 7 has come gets one prize_delivery_due
 * to the winner and one to the owing side, once per day mark (nudged_days, under the row lock).
 */
export async function recordDeliveryNudges(now = new Date()): Promise<number> {
  let sent = 0;
  const firstDue = new Date(now.getTime() - FULFILMENT_NUDGE_DAYS[0] * DAY_MS);
  const candidates = await db.select({ id: prizeFulfilments.id }).from(prizeFulfilments)
    .where(and(ne(prizeFulfilments.status, "delivered"), lte(prizeFulfilments.awardedAt, firstDue),
      sql`not (${prizeFulfilments.nudgedDays} @> ${sql.raw(`array[${FULFILMENT_NUDGE_DAYS.join(",")}]::int[]`)})`));
  for (const { id } of candidates) {
    sent += await db.transaction(async (tx) => {
      const row = await lockRow(tx, id);
      if (!row || row.status === "delivered") return 0;
      const ageDays = (now.getTime() - row.awardedAt.getTime()) / DAY_MS;
      const due = FULFILMENT_NUDGE_DAYS.filter((d) => ageDays >= d && !row.nudgedDays.includes(d));
      if (!due.length) return 0;
      // Only the latest mark is worth saying (a sweep that missed day 3 doesn't send both on day 7).
      const day = Math.max(...due);
      const [side, title] = await Promise.all([hostSide(tx, row.hostUserId), partyTitle(tx, row.partyId)]);
      const base = { fulfilmentId: row.id, partyId: row.partyId, title, brandName: side.name, day };
      const ref = { type: "prize" as const, id: row.id };
      await nudge(tx, { userId: row.winnerUserId, kind: "prize_delivery_due", data: { ...base, for: "winner" }, ref, dedupeKey: `prize_due:${row.id}:${day}:${row.winnerUserId}` });
      for (const userId of side.ids) await nudge(tx, { userId, kind: "prize_delivery_due", data: { ...base, for: "brand" }, ref, dedupeKey: `prize_due:${row.id}:${day}:${userId}` });
      await tx.update(prizeFulfilments).set({ nudgedDays: [...new Set([...row.nudgedDays, ...due])].sort((a, b) => a - b) }).where(eq(prizeFulfilments.id, row.id));
      return 1;
    });
  }
  return sent;
}

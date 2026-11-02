/**
 * The hourly invariant check (ADR 0013). It never fixes anything: any breach raises a critical alert and
 * pauses payouts (queued ones stay debited and queued) until an admin clears the pause.
 *
 * 1. Every journal sums to zero, and nothing has been written outside a journal since double entry began.
 *    Together these are the books' identity: what people hold, plus pots, plus payouts pending, settled and
 *    fees, equals what came in (top-ups, dev mints, coins issued, prizes funded) minus what went out.
 * 2. Every account's balance is the sum of its entries.
 * 3. Per provider: topup_in is exactly the credited top-ups; payout_pending exactly the open withdrawals;
 *    payout_settled exactly what succeeded withdrawals sent; payout_fees exactly their fees. What people
 *    were booked as owing (payout_owed, per person) is exactly what resolved contradictions recorded.
 * 4. Every withdrawal's own entries: debited once; reversed at most once and only if failed or rejected;
 *    settled only if succeeded; never both; recovered (a contradiction resolved) once, and only then.
 * 5. A finished or cancelled party's pot is zero. Parties with entries from before double entry (migration
 *    0021) are left out: a seat charged before it and refunded after leaves a pot that never got the entry.
 * 6. Every platform account points the way it should: money in (topup_in, dev_mint, bonus_issued,
 *    prize_funding, platform_funds, payout_owed) at or below zero, money held or out (pots, payout_pending,
 *    payout_settled, payout_fees, contradiction holds, forfeited entries) at or above; fee_variance either way.
 *
 * Admins can acknowledge a breach (payments.config and a second admin, with a reason): one of the same kind,
 * on the same items, no larger, then doesn't pause payouts again. A new or growing one does.
 *
 * All reads run in one REPEATABLE READ snapshot, so a transaction committing mid-check can't look like a
 * breach. A breach is checked again in a fresh snapshot before anything is paused: only one that repeats
 * pauses payouts; one that doesn't is a warning.
 */
import { desc, eq, sql } from "drizzle-orm";
import { db, invariantAcknowledgments, recordAdminAction, type InvariantAcknowledgment, type Tx } from "@contestly/db";
import { PAYOUT_OPEN_STATUSES, SECOND_ADMIN_REQUIRED } from "@contestly/shared";
import { paymentsError, raiseAlert } from "./common.js";
import { pausePayoutsBySystem } from "./settings.js";

/**
 * A breach: its kind, what it found, and the items it's about (account, party, provider, payout…) with how
 * far off each is, which is what an acknowledgment covers.
 */
export interface Breach { kind: string; detail: Record<string, unknown>; items: Record<string, number> }
type Row = Record<string, unknown>;

const num = (v: unknown) => Number(v ?? 0);
const rows = async (conn: Tx | typeof db, q: ReturnType<typeof sql>) => (await conn.execute(q)) as unknown as Row[];
const openList = sql.raw(PAYOUT_OPEN_STATUSES.map((s) => `'${s}'`).join(", "));
/** How many items a check reports (enough that an acknowledged set doesn't hide a new one). */
const LIMIT = sql.raw("200");
const itemsOf = (rs: Row[], key: string, magnitude: (r: Row) => number) => Object.fromEntries(rs.map((r) => [String(r[key]), Math.abs(magnitude(r))]));

export async function findBreaches(conn: Tx | typeof db): Promise<Breach[]> {
  const out: Breach[] = [];

  const unbalanced = await rows(conn, sql`select journal_id, sum(amount_kobo)::bigint as total from ledger_entries where journal_id is not null group by journal_id having sum(amount_kobo) <> 0 limit ${LIMIT}`);
  if (unbalanced.length) out.push({ kind: "unbalanced_journal", detail: { journals: unbalanced.map((r) => ({ journalId: r.journal_id, total: num(r.total) })) }, items: itemsOf(unbalanced, "journal_id", (r) => num(r.total)) });

  const outside = await rows(conn, sql`select id, idempotency_key from ledger_entries where journal_id is null and created_at > (select min(created_at) from ledger_entries where journal_id is not null) limit ${LIMIT}`);
  if (outside.length) out.push({ kind: "entry_outside_journal", detail: { entries: outside.map((r) => ({ id: r.id, key: r.idempotency_key })) }, items: itemsOf(outside, "id", () => 1) });

  const drift = await rows(conn, sql`select a.id, a.kind, a.scope, a.balance_kobo::bigint as balance, coalesce(sum(e.amount_kobo), 0)::bigint as entries
    from ledger_accounts a left join ledger_entries e on e.account_id = a.id group by a.id having a.balance_kobo <> coalesce(sum(e.amount_kobo), 0) limit ${LIMIT}`);
  if (drift.length) out.push({ kind: "balance_drift", detail: { accounts: drift.map((r) => ({ id: r.id, kind: r.kind, scope: r.scope, balance: num(r.balance), entries: num(r.entries) })) }, items: itemsOf(drift, "id", (r) => num(r.balance) - num(r.entries)) });

  // 3. The payment accounts against the rows they stand for, per provider.
  const accounts = await rows(conn, sql`select kind, scope, balance_kobo::bigint as balance from ledger_accounts where kind in ('topup_in', 'payout_pending', 'payout_settled', 'payout_fees')`);
  const balance = (kind: string, provider: string) => num(accounts.find((a) => a.kind === kind && a.scope === provider)?.balance);
  const topupSums = await rows(conn, sql`select provider, sum(coalesce(credited_kobo, amount_kobo))::bigint as credited from topups where status = 'succeeded' group by provider`);
  // A resolved contradiction books the transfer as sent (and its fee), and what the person couldn't cover as owed.
  const payoutSums = await rows(conn, sql`select p.provider,
      coalesce(sum(p.amount_kobo) filter (where p.status in (${openList})), 0)::bigint as pending,
      coalesce(sum(p.sent_kobo) filter (where p.status = 'succeeded' or c.status = 'resolved'), 0)::bigint as settled,
      coalesce(sum(p.fee_kobo) filter (where p.status = 'succeeded' or c.status = 'resolved'), 0)::bigint as fees
    from payouts p left join payout_contradictions c on c.payout_id = p.id group by p.provider`);
  const providers = new Set<string>([...accounts.map((a) => String(a.scope)), ...topupSums.map((r) => String(r.provider)), ...payoutSums.map((r) => String(r.provider))]);
  for (const p of providers) {
    const t = topupSums.find((r) => r.provider === p);
    const po = payoutSums.find((r) => r.provider === p);
    const expect = { topup_in: -num(t?.credited), payout_pending: num(po?.pending), payout_settled: num(po?.settled), payout_fees: num(po?.fees) };
    for (const [kind, want] of Object.entries(expect)) {
      const got = balance(kind, p);
      if (got !== want) out.push({ kind: `provider_${kind}`, detail: { provider: p, ledger: got, records: want }, items: { [p]: Math.abs(got - want) } });
    }
  }

  // 4. Each withdrawal's own legs on the person's cash, and its final journal.
  // The recovery journal (a resolved contradiction) is counted on its own, not as a debit, reversal or settle.
  const shapes = await rows(conn, sql`select p.id, p.status, p.amount_kobo::bigint as amount, (c.status = 'resolved') as resolved,
      count(e.id) filter (where a.kind = 'cash' and e.type <> 'withdrawal_recovered') as cash_legs,
      coalesce(sum(e.amount_kobo) filter (where a.kind = 'cash' and e.type <> 'withdrawal_recovered'), 0)::bigint as cash_sum,
      count(e.id) filter (where e.idempotency_key = 'payout_debit:' || p.id) as debits,
      count(e.id) filter (where e.idempotency_key = 'payout_final:' || p.id) as finals,
      count(e.id) filter (where a.kind = 'payout_settled' and e.type <> 'withdrawal_recovered') as settled_legs,
      count(e.id) filter (where e.idempotency_key = 'payout_recovery:' || p.id) as recoveries
    from payouts p left join payout_contradictions c on c.payout_id = p.id
      left join ledger_entries e on e.ref_type = 'payout' and e.ref_id = p.id::text left join ledger_accounts a on a.id = e.account_id
    group by p.id, c.status`);
  const bad = shapes.filter((r) => {
    const reversed = r.status === "failed" || r.status === "rejected";
    const final = reversed || r.status === "succeeded";
    return num(r.debits) !== 1 || num(r.finals) !== (final ? 1 : 0)
      || num(r.cash_legs) !== (reversed ? 2 : 1) || num(r.cash_sum) !== (reversed ? 0 : -num(r.amount))
      || num(r.settled_legs) !== (r.status === "succeeded" ? 1 : 0)
      || num(r.recoveries) !== (r.resolved === true ? 1 : 0) || (r.resolved === true && !reversed);
  });
  if (bad.length) out.push({ kind: "payout_entries", items: itemsOf(bad, "id", () => 1), detail: { payouts: bad.slice(0, 20).map((r) => ({ id: r.id, status: r.status, cashLegs: num(r.cash_legs), cashSum: num(r.cash_sum), debits: num(r.debits), finals: num(r.finals), settledLegs: num(r.settled_legs), recoveries: num(r.recoveries) })) } });

  // 3b. What people were booked as owing at their freezes is exactly what the contradictions recorded
  // (repayments, releases and waivers move it on from there); each person's hold is exactly the disputed
  // amount of their contradictions still open.
  const [owed] = await rows(conn, sql`select
      coalesce((select sum(e.amount_kobo) from ledger_entries e join ledger_accounts a on a.id = e.account_id where a.kind = 'payout_owed' and e.type = 'contradiction_held'), 0)::bigint as booked,
      coalesce((select sum(owed_kobo) from payout_contradictions), 0)::bigint as recorded`);
  if (num(owed.booked) !== -num(owed.recorded)) out.push({ kind: "owed_recorded", detail: { ledger: num(owed.booked), contradictions: -num(owed.recorded) }, items: { all: Math.abs(num(owed.booked) + num(owed.recorded)) } });
  // No contradiction's debt is paid down past zero (repaid, waived or released beyond what was booked).
  const overpaid = await rows(conn, sql`select e.ref_id as contradiction_id, sum(e.amount_kobo)::bigint as net from ledger_entries e join ledger_accounts a on a.id = e.account_id
    where a.kind = 'payout_owed' and e.ref_type = 'contradiction' group by e.ref_id having sum(e.amount_kobo) > 0 order by e.ref_id limit ${LIMIT}`);
  if (overpaid.length) out.push({ kind: "contradiction_debt", detail: { contradictions: overpaid.map((r) => ({ id: r.contradiction_id, net: num(r.net) })) }, items: itemsOf(overpaid, "contradiction_id", (r) => num(r.net)) });
  const holds = await rows(conn, sql`select coalesce(a.scope, c.user_id::text) as user_id, coalesce(a.balance_kobo, 0)::bigint as held, coalesce(c.open, 0)::bigint as open
    from (select scope, balance_kobo from ledger_accounts where kind = 'contradiction_hold') a
    full join (select user_id, sum(amount_kobo) as open from payout_contradictions where status in ('open', 'awaiting_second_admin') group by user_id) c on c.user_id::text = a.scope
    where coalesce(a.balance_kobo, 0) <> coalesce(c.open, 0) limit ${LIMIT}`);
  if (holds.length) out.push({ kind: "contradiction_hold", detail: { people: holds.map((r) => ({ userId: r.user_id, held: num(r.held), open: num(r.open) })) }, items: itemsOf(holds, "user_id", (r) => num(r.held) - num(r.open)) });

  // 5. Closed parties' pots are empty (parties with pre-double-entry entries left out; ADR 0013 lists them).
  const pots = await rows(conn, sql`select a.scope as party_id, pa.status, a.balance_kobo::bigint as balance
    from ledger_accounts a join parties pa on pa.id::text = a.scope
    where a.kind = 'party_pot' and pa.status in ('finished', 'cancelled') and a.balance_kobo <> 0
      and not exists (select 1 from ledger_entries e where e.ref_type = 'party' and e.ref_id = a.scope and e.journal_id is null)
    limit ${LIMIT}`);
  if (pots.length) out.push({ kind: "closed_party_pot", detail: { parties: pots.map((r) => ({ partyId: r.party_id, status: r.status, balance: num(r.balance) })) }, items: itemsOf(pots, "party_id", (r) => num(r.balance)) });

  // 6. Platform accounts in their expected direction.
  const wrongWay = await rows(conn, sql`select a.id, a.kind, a.scope, a.balance_kobo::bigint as balance from ledger_accounts a
    where (a.kind in (${inList(PLATFORM_AT_MOST_ZERO)}) and a.balance_kobo > 0)
       or (a.kind in (${inList(PLATFORM_AT_LEAST_ZERO)}) and a.balance_kobo < 0
           and not (a.kind = 'party_pot' and exists (select 1 from ledger_entries e where e.ref_type = 'party' and e.ref_id = a.scope and e.journal_id is null)))
    limit ${LIMIT}`);
  if (wrongWay.length) out.push({ kind: "platform_direction", detail: { accounts: wrongWay.map((r) => ({ id: r.id, kind: r.kind, scope: r.scope, balance: num(r.balance) })) }, items: itemsOf(wrongWay, "id", (r) => num(r.balance)) });
  return out;
}

/** Platform accounts money comes in through (they only go negative) and ones that hold or pay it out (only positive). */
export const PLATFORM_AT_MOST_ZERO = ["topup_in", "dev_mint", "bonus_issued", "prize_funding", "platform_funds", "payout_owed"] as const;
export const PLATFORM_AT_LEAST_ZERO = ["party_pot", "payout_pending", "payout_settled", "payout_fees", "contradiction_hold", "entry_forfeited"] as const;
// fee_variance goes either way (a user-borne fee estimated high or low), so it's in neither list.
const inList = (kinds: readonly string[]) => sql.raw(kinds.map((k) => `'${k}'`).join(", "));

/** Of a first read's breaches, the ones a second read found again (as it saw them) and the ones it didn't. */
export function repeatedBreaches(first: Breach[], again: Breach[]) {
  const before = new Set(first.map((b) => b.kind));
  const breaches = again.filter((b) => before.has(b.kind));
  const transient = [...before].filter((k) => !breaches.some((b) => b.kind === k));
  return { breaches, transient };
}

/** One consistent read of the books: every check in a single REPEATABLE READ, read-only snapshot. */
const snapshot = () => db.transaction((tx) => findBreaches(tx), { isolationLevel: "repeatable read", accessMode: "read only" });

/** Covered by an acknowledgment: every item it's about was acknowledged for this kind, at no smaller magnitude. */
export function isAcknowledged(b: Breach, acknowledged: Record<string, number>[]) {
  const covered = new Map<string, number>();
  for (const items of acknowledged) for (const [k, v] of Object.entries(items)) covered.set(k, Math.max(covered.get(k) ?? 0, v));
  return Object.entries(b.items).every(([k, v]) => covered.has(k) && v <= covered.get(k)!);
}

async function appliedAcknowledgments(conn: Tx | typeof db) {
  const rows = await conn.select({ kind: invariantAcknowledgments.kind, items: invariantAcknowledgments.items }).from(invariantAcknowledgments).where(eq(invariantAcknowledgments.status, "applied"));
  const byKind = new Map<string, Record<string, number>[]>();
  for (const r of rows) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r.items as Record<string, number>]);
  return byKind;
}

/**
 * Check; a breach is checked again in a fresh snapshot, and only one that repeats, and isn't covered by an
 * acknowledgment, alerts (once an hour per kind) and pauses payouts. One that doesn't repeat is a warning;
 * an acknowledged one is reported but changes nothing. Tests pass a transaction to run inside it.
 */
export async function runInvariants(conn?: Tx, now = new Date()): Promise<{ breaches: Breach[]; paused: boolean; transient: string[]; acknowledged: Breach[] }> {
  const read = conn ? () => findBreaches(conn) : snapshot;
  const first = await read();
  if (!first.length) return { breaches: [], paused: false, transient: [], acknowledged: [] };
  const repeated = repeatedBreaches(first, await read());
  const transient = repeated.transient;
  const acks = await appliedAcknowledgments(conn ?? db);
  const acknowledged = repeated.breaches.filter((b) => isAcknowledged(b, acks.get(b.kind) ?? []));
  const breaches = repeated.breaches.filter((b) => !acknowledged.includes(b));
  const hour = now.toISOString().slice(0, 13);
  const act = async (tx: Tx) => {
    for (const kind of transient) await raiseAlert(tx, { severity: "warning", kind: "invariant_transient", dedupeKey: `invariant_transient:${kind}:${hour}`, detail: { kind, first: first.find((b) => b.kind === kind)?.detail } });
    if (!breaches.length) return false;
    for (const b of breaches) await raiseAlert(tx, { severity: "critical", kind: `invariant_${b.kind}`, dedupeKey: `invariant:${b.kind}:${hour}`, detail: b.detail });
    return pausePayoutsBySystem(tx, `invariant breach: ${breaches.map((b) => b.kind).join(", ")}`);
  };
  const paused = await (conn ? act(conn) : db.transaction(act));
  return { breaches, paused, transient, acknowledged };
}

const iso = (d: Date | null) => d?.toISOString() ?? null;
export const acknowledgmentView = (a: InvariantAcknowledgment) => ({
  id: a.id, kind: a.kind, items: a.items as Record<string, number>, detail: a.detail, reason: a.reason, status: a.status,
  requestedBy: a.requestedByUserId, confirmedBy: a.confirmedByUserId, createdAt: a.createdAt.toISOString(), appliedAt: iso(a.appliedAt),
});

/**
 * Ask to acknowledge the breach of this kind as it stands now (read fresh, so it covers exactly what's
 * there). Nothing changes until a second payments.config holder confirms.
 */
export async function requestAcknowledgment(adminUserId: string, kind: string, reason: string) {
  const breach = (await snapshot()).find((b) => b.kind === kind);
  if (!breach) throw paymentsError(409, "no_such_breach", { kind });
  return db.transaction(async (tx) => {
    const [a] = await tx.insert(invariantAcknowledgments).values({ kind, items: breach.items, detail: breach.detail, reason, status: "awaiting_second_admin", requestedByUserId: adminUserId }).returning();
    await recordAdminAction(tx, { adminUserId, action: "payments.invariant_ack_requested", targetType: "invariant", targetId: a.id, reason, before: null, after: { kind, items: breach.items } });
    return acknowledgmentView(a);
  });
}

export async function confirmAcknowledgment(adminUserId: string, id: string, now = new Date()) {
  return db.transaction(async (tx) => {
    const [a] = await tx.select().from(invariantAcknowledgments).where(eq(invariantAcknowledgments.id, id)).for("update");
    if (!a) throw paymentsError(404, "not_found");
    if (a.status !== "awaiting_second_admin") throw paymentsError(409, "acknowledgment_not_pending", { status: a.status });
    if (a.requestedByUserId === adminUserId) throw paymentsError(403, SECOND_ADMIN_REQUIRED);
    const [done] = await tx.update(invariantAcknowledgments).set({ status: "applied", confirmedByUserId: adminUserId, appliedAt: now }).where(eq(invariantAcknowledgments.id, id)).returning();
    await recordAdminAction(tx, { adminUserId, action: "payments.invariant_acknowledged", targetType: "invariant", targetId: a.id, reason: a.reason, before: { status: a.status }, after: { kind: a.kind, items: a.items, requestedBy: a.requestedByUserId } });
    return acknowledgmentView(done);
  });
}

export async function listAcknowledgments(limit: number) {
  return (await db.select().from(invariantAcknowledgments).orderBy(desc(invariantAcknowledgments.createdAt)).limit(limit)).map(acknowledgmentView);
}

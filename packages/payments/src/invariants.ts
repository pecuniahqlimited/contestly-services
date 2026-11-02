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
 *    payout_settled, payout_fees) at or above.
 *
 * All reads run in one REPEATABLE READ snapshot, so a transaction committing mid-check can't look like a
 * breach. A breach is checked again in a fresh snapshot before anything is paused: only one that repeats
 * pauses payouts; one that doesn't is a warning.
 */
import { sql } from "drizzle-orm";
import { db, type Tx } from "@contestly/db";
import { PAYOUT_OPEN_STATUSES } from "@contestly/shared";
import { raiseAlert } from "./common.js";
import { pausePayoutsBySystem } from "./settings.js";

export interface Breach { kind: string; detail: Record<string, unknown> }
type Row = Record<string, unknown>;

const num = (v: unknown) => Number(v ?? 0);
const rows = async (conn: Tx | typeof db, q: ReturnType<typeof sql>) => (await conn.execute(q)) as unknown as Row[];
const openList = sql.raw(PAYOUT_OPEN_STATUSES.map((s) => `'${s}'`).join(", "));

export async function findBreaches(conn: Tx | typeof db): Promise<Breach[]> {
  const out: Breach[] = [];

  const unbalanced = await rows(conn, sql`select journal_id, sum(amount_kobo)::bigint as total from ledger_entries where journal_id is not null group by journal_id having sum(amount_kobo) <> 0 limit 20`);
  if (unbalanced.length) out.push({ kind: "unbalanced_journal", detail: { journals: unbalanced.map((r) => ({ journalId: r.journal_id, total: num(r.total) })) } });

  const outside = await rows(conn, sql`select id, idempotency_key from ledger_entries where journal_id is null and created_at > (select min(created_at) from ledger_entries where journal_id is not null) limit 20`);
  if (outside.length) out.push({ kind: "entry_outside_journal", detail: { entries: outside.map((r) => ({ id: r.id, key: r.idempotency_key })) } });

  const drift = await rows(conn, sql`select a.id, a.kind, a.scope, a.balance_kobo::bigint as balance, coalesce(sum(e.amount_kobo), 0)::bigint as entries
    from ledger_accounts a left join ledger_entries e on e.account_id = a.id group by a.id having a.balance_kobo <> coalesce(sum(e.amount_kobo), 0) limit 20`);
  if (drift.length) out.push({ kind: "balance_drift", detail: { accounts: drift.map((r) => ({ id: r.id, kind: r.kind, scope: r.scope, balance: num(r.balance), entries: num(r.entries) })) } });

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
      if (got !== want) out.push({ kind: `provider_${kind}`, detail: { provider: p, ledger: got, records: want } });
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
  if (bad.length) out.push({ kind: "payout_entries", detail: { payouts: bad.slice(0, 20).map((r) => ({ id: r.id, status: r.status, cashLegs: num(r.cash_legs), cashSum: num(r.cash_sum), debits: num(r.debits), finals: num(r.finals), settledLegs: num(r.settled_legs), recoveries: num(r.recoveries) })) } });

  // 3b. What people were recorded as owing is exactly what resolved contradictions said (repayments and waivers move it on from there).
  const [owed] = await rows(conn, sql`select
      coalesce((select sum(e.amount_kobo) from ledger_entries e join ledger_accounts a on a.id = e.account_id where a.kind = 'payout_owed' and e.type = 'withdrawal_recovered'), 0)::bigint as booked,
      coalesce((select sum(owed_kobo) from payout_contradictions where status = 'resolved'), 0)::bigint as resolved`);
  if (num(owed.booked) !== -num(owed.resolved)) out.push({ kind: "owed_recorded", detail: { ledger: num(owed.booked), contradictions: -num(owed.resolved) } });

  // 5. Closed parties' pots are empty (parties with pre-double-entry entries left out; ADR 0013 lists them).
  const pots = await rows(conn, sql`select a.scope as party_id, pa.status, a.balance_kobo::bigint as balance
    from ledger_accounts a join parties pa on pa.id::text = a.scope
    where a.kind = 'party_pot' and pa.status in ('finished', 'cancelled') and a.balance_kobo <> 0
      and not exists (select 1 from ledger_entries e where e.ref_type = 'party' and e.ref_id = a.scope and e.journal_id is null)
    limit 20`);
  if (pots.length) out.push({ kind: "closed_party_pot", detail: { parties: pots.map((r) => ({ partyId: r.party_id, status: r.status, balance: num(r.balance) })) } });

  // 6. Platform accounts in their expected direction.
  const wrongWay = await rows(conn, sql`select a.id, a.kind, a.scope, a.balance_kobo::bigint as balance from ledger_accounts a
    where (a.kind in (${inList(PLATFORM_AT_MOST_ZERO)}) and a.balance_kobo > 0)
       or (a.kind in (${inList(PLATFORM_AT_LEAST_ZERO)}) and a.balance_kobo < 0
           and not (a.kind = 'party_pot' and exists (select 1 from ledger_entries e where e.ref_type = 'party' and e.ref_id = a.scope and e.journal_id is null)))
    limit 20`);
  if (wrongWay.length) out.push({ kind: "platform_direction", detail: { accounts: wrongWay.map((r) => ({ id: r.id, kind: r.kind, scope: r.scope, balance: num(r.balance) })) } });
  return out;
}

/** Platform accounts money comes in through (they only go negative) and ones that hold or pay it out (only positive). */
export const PLATFORM_AT_MOST_ZERO = ["topup_in", "dev_mint", "bonus_issued", "prize_funding", "platform_funds", "payout_owed"] as const;
export const PLATFORM_AT_LEAST_ZERO = ["party_pot", "payout_pending", "payout_settled", "payout_fees"] as const;
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

/**
 * Check; a breach is checked again in a fresh snapshot, and only one that repeats alerts (once an hour per
 * kind) and pauses payouts. One that doesn't repeat is a warning. Tests pass a transaction to run inside it.
 */
export async function runInvariants(conn?: Tx, now = new Date()): Promise<{ breaches: Breach[]; paused: boolean; transient: string[] }> {
  const read = conn ? () => findBreaches(conn) : snapshot;
  const first = await read();
  if (!first.length) return { breaches: [], paused: false, transient: [] };
  const { breaches, transient } = repeatedBreaches(first, await read());
  const hour = now.toISOString().slice(0, 13);
  const act = async (tx: Tx) => {
    for (const kind of transient) await raiseAlert(tx, { severity: "warning", kind: "invariant_transient", dedupeKey: `invariant_transient:${kind}:${hour}`, detail: { kind, first: first.find((b) => b.kind === kind)?.detail } });
    if (!breaches.length) return false;
    for (const b of breaches) await raiseAlert(tx, { severity: "critical", kind: `invariant_${b.kind}`, dedupeKey: `invariant:${b.kind}:${hour}`, detail: b.detail });
    return pausePayoutsBySystem(tx, `invariant breach: ${breaches.map((b) => b.kind).join(", ")}`);
  };
  const paused = await (conn ? act(conn) : db.transaction(act));
  return { breaches, paused, transient };
}

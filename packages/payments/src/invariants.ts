/**
 * The hourly invariant check (ADR 0013). It never fixes anything: any breach raises a critical alert and
 * pauses payouts (queued ones stay debited and queued) until an admin clears the pause.
 *
 * 1. Every journal sums to zero, and nothing has been written outside a journal since double entry began.
 *    Together these are the books' identity: what people hold, plus pots, plus payouts pending, settled and
 *    fees, equals what came in (top-ups, dev mints, coins issued, prizes funded) minus what went out.
 * 2. Every account's balance is the sum of its entries.
 * 3. Per provider: topup_in is exactly the credited top-ups; payout_pending exactly the open withdrawals;
 *    payout_settled exactly what succeeded withdrawals sent; payout_fees exactly their fees.
 * 4. Every withdrawal's own entries: debited once; reversed at most once and only if failed or rejected;
 *    settled only if succeeded; never both.
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
  const topupSums = await rows(conn, sql`select provider, sum(amount_kobo)::bigint as credited from topups where status = 'succeeded' group by provider`);
  const payoutSums = await rows(conn, sql`select provider,
      coalesce(sum(amount_kobo) filter (where status in (${openList})), 0)::bigint as pending,
      coalesce(sum(sent_kobo) filter (where status = 'succeeded'), 0)::bigint as settled,
      coalesce(sum(fee_kobo) filter (where status = 'succeeded'), 0)::bigint as fees
    from payouts group by provider`);
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
  const shapes = await rows(conn, sql`select p.id, p.status, p.amount_kobo::bigint as amount,
      count(e.id) filter (where a.kind = 'cash') as cash_legs,
      coalesce(sum(e.amount_kobo) filter (where a.kind = 'cash'), 0)::bigint as cash_sum,
      count(e.id) filter (where e.idempotency_key = 'payout_debit:' || p.id) as debits,
      count(e.id) filter (where e.idempotency_key = 'payout_final:' || p.id) as finals,
      count(e.id) filter (where a.kind = 'payout_settled') as settled_legs
    from payouts p left join ledger_entries e on e.ref_type = 'payout' and e.ref_id = p.id::text left join ledger_accounts a on a.id = e.account_id
    group by p.id`);
  const bad = shapes.filter((r) => {
    const reversed = r.status === "failed" || r.status === "rejected";
    const final = reversed || r.status === "succeeded";
    return num(r.debits) !== 1 || num(r.finals) !== (final ? 1 : 0)
      || num(r.cash_legs) !== (reversed ? 2 : 1) || num(r.cash_sum) !== (reversed ? 0 : -num(r.amount))
      || num(r.settled_legs) !== (r.status === "succeeded" ? 1 : 0);
  });
  if (bad.length) out.push({ kind: "payout_entries", detail: { payouts: bad.slice(0, 20).map((r) => ({ id: r.id, status: r.status, cashLegs: num(r.cash_legs), cashSum: num(r.cash_sum), debits: num(r.debits), finals: num(r.finals), settledLegs: num(r.settled_legs) })) } });
  return out;
}

/** Check; on any breach, alert (once an hour per kind) and pause payouts. Pass a transaction to run inside it. */
export async function runInvariants(conn?: Tx, now = new Date()): Promise<{ breaches: Breach[]; paused: boolean }> {
  const run = async (tx: Tx) => {
    const breaches = await findBreaches(tx);
    if (!breaches.length) return { breaches, paused: false };
    const hour = now.toISOString().slice(0, 13);
    for (const b of breaches) await raiseAlert(tx, { severity: "critical", kind: `invariant_${b.kind}`, dedupeKey: `invariant:${b.kind}:${hour}`, detail: b.detail });
    const paused = await pausePayoutsBySystem(tx, `invariant breach: ${breaches.map((b) => b.kind).join(", ")}`);
    return { breaches, paused };
  };
  return conn ? run(conn) : db.transaction(run);
}

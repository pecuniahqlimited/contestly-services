/**
 * Double entry (ADR 0012): every journal sums to zero, a replay is a no-op, a replay with different legs is
 * refused, a person's money can't go below zero (the lock and the check constraint), and the flows the rest
 * of the suite runs leave the books balanced.
 */
import { afterAll, describe, expect, it } from "vitest";
import { eq, sql as dsql } from "drizzle-orm";
import { IdempotencyConflict, InsufficientFunds, LedgerImbalance, db, ledger, ledgerAccounts, sql } from "@contestly/db";
import { kobo } from "@contestly/shared";
import { makeUser, tag } from "./harness.js";

afterAll(async () => { await sql.end(); });

const fund = (userId: string, amountKobo: number, key: string) =>
  db.transaction((tx) => ledger.post(tx, { userId, kind: "cash", amountKobo, type: "topup", idempotencyKey: `t:ledger:${tag}:${key}` }));

describe("journals", () => {
  it("refuses legs that don't sum to zero, a single leg, and a fraction of a kobo", async () => {
    const u = await makeUser("lgbal");
    const cash = { userId: u.id, kind: "cash" as const };
    for (const legs of [
      [{ account: cash, amountKobo: 100 }, { account: { system: "dev_mint" as const }, amountKobo: -99 }],
      [{ account: cash, amountKobo: 100 }],
      [{ account: cash, amountKobo: 0.5 }, { account: { system: "dev_mint" as const }, amountKobo: -0.5 }],
    ]) {
      await expect(db.transaction((tx) => ledger.journal(tx, { type: "topup", idempotencyKey: `t:lg:${tag}:${legs.length}:${legs[0].amountKobo}`, legs }))).rejects.toBeInstanceOf(LedgerImbalance);
    }
    expect(await ledger.balances(u.id)).toEqual({ cashKobo: 0, bonusKobo: 0 });
  });

  it("post() writes the platform's side too, and a replay is a no-op", async () => {
    const u = await makeUser("lgpost");
    const first = await fund(u.id, kobo(10), "replay");
    const again = await fund(u.id, kobo(10), "replay");
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(await ledger.balances(u.id)).toEqual({ cashKobo: kobo(10), bonusKobo: 0 });
    const legs = await sql`select e.amount_kobo::bigint as a, a.kind from ledger_entries e join ledger_accounts a on a.id = e.account_id where e.idempotency_key like ${`t:ledger:${tag}:replay%`} order by e.idempotency_key`;
    expect(legs.map((l) => [l.kind, Number(l.a)])).toEqual([["cash", kobo(10)], ["dev_mint", -kobo(10)]]);
  });

  it("the same key with different legs is refused, never taken for a replay", async () => {
    const u = await makeUser("lgconf");
    await fund(u.id, kobo(10), "conflict");
    await expect(fund(u.id, kobo(11), "conflict")).rejects.toBeInstanceOf(IdempotencyConflict);
    expect(await ledger.balances(u.id)).toEqual({ cashKobo: kobo(10), bonusKobo: 0 });
  });

  it("movements with no platform account are refused", async () => {
    const u = await makeUser("lgtype");
    await expect(db.transaction((tx) => ledger.post(tx, { userId: u.id, kind: "cash", amountKobo: 1, type: "made_up", idempotencyKey: `t:lg:${tag}:made_up` }))).rejects.toBeInstanceOf(LedgerImbalance);
  });
});

describe("a person's money never goes below zero", () => {
  it("concurrent charges can't overdraw", async () => {
    const u = await makeUser("lgrace");
    await fund(u.id, kobo(100), "race");
    const tries = Array.from({ length: 8 }, (_, i) => db.transaction((tx) => ledger.charge(tx, { userId: u.id, amountKobo: kobo(30), type: "party_entry", refType: "party", refId: `t-race-${tag}`, idempotencyKey: `t:lg:${tag}:race:${i}` })));
    const results = await Promise.allSettled(tries);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof InsufficientFunds)).toBe(true);
    expect(await ledger.balances(u.id)).toEqual({ cashKobo: kobo(10), bonusKobo: 0 });
  });

  it("the check constraint stops a write that skips the ledger", async () => {
    const u = await makeUser("lgcheck");
    await fund(u.id, kobo(1), "check");
    await expect(db.update(ledgerAccounts).set({ balanceKobo: -1 }).where(dsql`${ledgerAccounts.userId} = ${u.id} and ${ledgerAccounts.kind} = 'cash'`)).rejects.toThrow(/ledger_accounts_person_not_negative/);
  });
});

describe("the books", () => {
  it("every journal written by this suite sums to zero, and every balance is the sum of its entries", async () => {
    const unbalanced = await sql`select journal_id from ledger_entries where journal_id is not null group by journal_id having sum(amount_kobo) <> 0`;
    expect(unbalanced).toHaveLength(0);
    const drift = await sql`select a.id from ledger_accounts a left join ledger_entries e on e.account_id = a.id group by a.id having a.balance_kobo <> coalesce(sum(e.amount_kobo), 0)`;
    expect(drift).toHaveLength(0);
    const [{ total }] = await sql`select coalesce(sum(amount_kobo), 0)::bigint as total from ledger_entries where journal_id is not null`;
    expect(Number(total)).toBe(0);
    expect((await db.select().from(ledgerAccounts).where(eq(ledgerAccounts.kind, "dev_mint"))).length).toBeGreaterThan(0);
  });
});

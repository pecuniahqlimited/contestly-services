import { and, eq, sql as dsql } from "drizzle-orm";
import { db, type Tx } from "./client.js";
import { ledgerAccounts, ledgerEntries } from "./schema.js";

export class InsufficientFunds extends Error { constructor() { super("insufficient_funds"); } }

type Kind = "cash" | "bonus";

async function accountFor(tx: Tx, userId: string, kind: Kind) {
  const [existing] = await tx.select().from(ledgerAccounts).where(and(eq(ledgerAccounts.userId, userId), eq(ledgerAccounts.kind, kind))).for("update");
  if (existing) return existing;
  const [created] = await tx.insert(ledgerAccounts).values({ userId, kind }).onConflictDoNothing().returning();
  if (created) return created;
  const [again] = await tx.select().from(ledgerAccounts).where(and(eq(ledgerAccounts.userId, userId), eq(ledgerAccounts.kind, kind))).for("update");
  return again;
}

/** Post one signed movement to an account. Idempotent on idempotencyKey (a replay is a no-op). */
export async function post(tx: Tx, p: { userId: string; kind: Kind; amountKobo: number; type: string; refType?: string; refId?: string; idempotencyKey: string }) {
  const acct = await accountFor(tx, p.userId, p.kind);
  const inserted = await tx.insert(ledgerEntries).values({ accountId: acct.id, amountKobo: p.amountKobo, type: p.type, refType: p.refType, refId: p.refId, idempotencyKey: p.idempotencyKey }).onConflictDoNothing().returning({ id: ledgerEntries.id });
  if (!inserted.length) return { replayed: true, balanceKobo: acct.balanceKobo };
  const next = acct.balanceKobo + p.amountKobo;
  if (next < 0) throw new InsufficientFunds();
  await tx.update(ledgerAccounts).set({ balanceKobo: next }).where(eq(ledgerAccounts.id, acct.id));
  return { replayed: false, balanceKobo: next };
}

/** Charge an entry fee: bonus coins first, then cash. Throws InsufficientFunds if both together can't cover it. */
export async function charge(tx: Tx, p: { userId: string; amountKobo: number; type: string; refType: string; refId: string; idempotencyKey: string }) {
  if (p.amountKobo === 0) return { fromBonus: 0, fromCash: 0 };
  const bonus = await accountFor(tx, p.userId, "bonus");
  const cash = await accountFor(tx, p.userId, "cash");
  const fromBonus = Math.min(bonus.balanceKobo, p.amountKobo);
  const fromCash = p.amountKobo - fromBonus;
  if (fromCash > cash.balanceKobo) throw new InsufficientFunds();
  if (fromBonus) await post(tx, { ...p, kind: "bonus", amountKobo: -fromBonus, idempotencyKey: p.idempotencyKey + ":bonus" });
  if (fromCash) await post(tx, { ...p, kind: "cash", amountKobo: -fromCash, idempotencyKey: p.idempotencyKey + ":cash" });
  return { fromBonus, fromCash };
}

export async function balances(userId: string) {
  const rows = await db.select().from(ledgerAccounts).where(eq(ledgerAccounts.userId, userId));
  return { cashKobo: rows.find((r) => r.kind === "cash")?.balanceKobo ?? 0, bonusKobo: rows.find((r) => r.kind === "bonus")?.balanceKobo ?? 0 };
}

export async function history(userId: string, limit = 50) {
  return db.select({ id: ledgerEntries.id, kind: ledgerAccounts.kind, amountKobo: ledgerEntries.amountKobo, type: ledgerEntries.type, refType: ledgerEntries.refType, refId: ledgerEntries.refId, createdAt: ledgerEntries.createdAt })
    .from(ledgerEntries).innerJoin(ledgerAccounts, eq(ledgerEntries.accountId, ledgerAccounts.id))
    .where(eq(ledgerAccounts.userId, userId)).orderBy(dsql`${ledgerEntries.createdAt} desc`).limit(limit);
}

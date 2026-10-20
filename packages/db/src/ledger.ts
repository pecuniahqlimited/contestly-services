import { and, eq, inArray, sql as dsql } from "drizzle-orm";
import { WELCOME_BONUS_KOBO } from "@contestly/shared";
import { db, type Tx } from "./client.js";
import { ledgerAccounts, ledgerEntries, users } from "./schema.js";

export class InsufficientFunds extends Error { constructor() { super("insufficient_funds"); } }

/** The platform's internal account the rake is posted to. Created on first use; never plays, never shown. */
export const TREASURY_HANDLE = "contestly.treasury";
export async function treasuryUserId(tx: Tx): Promise<string> {
  const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.handle, TREASURY_HANDLE));
  if (existing) return existing.id;
  const [created] = await tx.insert(users).values({ handle: TREASURY_HANDLE, displayName: "Contestly", avatarEmoji: "🏛️", isSystem: true }).onConflictDoNothing().returning({ id: users.id });
  if (created) return created.id;
  const [again] = await tx.select({ id: users.id }).from(users).where(eq(users.handle, TREASURY_HANDLE));
  return again.id;
}

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

/** The welcome bonus coins, granted exactly once per user however many times it's asked for. */
export const grantWelcome = (tx: Tx, userId: string) =>
  post(tx, { userId, kind: "bonus", amountKobo: WELCOME_BONUS_KOBO, type: "welcome_bonus", idempotencyKey: `welcome:${userId}` });

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

/** Reverse a charge() leg by leg: what came from bonus goes back to bonus, what came from cash goes back to cash. Idempotent. */
export async function refund(tx: Tx, p: { chargeKey: string; type: string; refType: string; refId: string; idempotencyKey: string }) {
  const legs = await tx.select({ userId: ledgerAccounts.userId, kind: ledgerAccounts.kind, amountKobo: ledgerEntries.amountKobo })
    .from(ledgerEntries).innerJoin(ledgerAccounts, eq(ledgerEntries.accountId, ledgerAccounts.id))
    .where(inArray(ledgerEntries.idempotencyKey, [p.chargeKey + ":bonus", p.chargeKey + ":cash"]));
  for (const l of legs) await post(tx, { userId: l.userId, kind: l.kind, amountKobo: -l.amountKobo, type: p.type, refType: p.refType, refId: p.refId, idempotencyKey: `${p.idempotencyKey}:${l.kind}` });
  return { toBonus: -(legs.find((l) => l.kind === "bonus")?.amountKobo ?? 0), toCash: -(legs.find((l) => l.kind === "cash")?.amountKobo ?? 0) };
}

/**
 * Hold cash from a wallet for something it has promised, like a host's cash prize: taken now so it can't be spent
 * elsewhere, then paid out or released. Throws InsufficientFunds if the cash isn't there. Idempotent on idempotencyKey.
 */
export const hold = (tx: Tx, p: { userId: string; amountKobo: number; type: string; refType: string; refId: string; idempotencyKey: string }) =>
  post(tx, { ...p, kind: "cash", amountKobo: -p.amountKobo });

/** Give back exactly what a hold() took under `holdKey`, and nothing if it never took anything. Idempotent. */
export async function release(tx: Tx, p: { holdKey: string; type: string; refType: string; refId: string; idempotencyKey: string }) {
  const [held] = await tx.select({ userId: ledgerAccounts.userId, amountKobo: ledgerEntries.amountKobo })
    .from(ledgerEntries).innerJoin(ledgerAccounts, eq(ledgerEntries.accountId, ledgerAccounts.id))
    .where(eq(ledgerEntries.idempotencyKey, p.holdKey));
  if (!held) return 0;
  await post(tx, { userId: held.userId, kind: "cash", amountKobo: -held.amountKobo, type: p.type, refType: p.refType, refId: p.refId, idempotencyKey: p.idempotencyKey });
  return -held.amountKobo;
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

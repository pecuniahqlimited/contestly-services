/**
 * Bank accounts for withdrawals: the payouts provider's bank list (cached), resolving a number to the holder's
 * name, and saving it only after the person confirms that name. Each account is tied to the provider that
 * resolved it; after a payouts switch it must be resolved again (account_unresolved).
 */
import { randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, payoutAccounts, type PayoutAccount } from "@contestly/db";
import { ACCOUNT_UNRESOLVED, NAME_MISMATCH, PROVIDER_UNAVAILABLE } from "@contestly/shared";
import { paymentsError } from "./common.js";
import { currentSettings } from "./settings.js";
import { providerNamed } from "./providers/index.js";
import type { Bank, BankDirectory, PaymentProvider } from "./types.js";

/** Where the bank list and pending resolutions are kept (Valkey in the API). */
export interface KeyValue {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

/** The provider couldn't answer: a 502 for the app, with the provider's error kept as the cause for the log. */
const unavailable = (cause: unknown) => Object.assign(paymentsError(502, PROVIDER_UNAVAILABLE), { cause });

const BANKS_TTL_SECONDS = 24 * 3600;
const RESOLVE_TTL_SECONDS = 10 * 60;
interface Resolution { userId: string; provider: string; bankCode: string; bankName: string; accountNumber: string; accountName: string }

async function payoutRail(): Promise<{ provider: PaymentProvider; banks: BankDirectory }> {
  const provider = providerNamed((await currentSettings()).payouts);
  if (!provider.payout?.banks) throw paymentsError(409, "provider_has_no_banks", { provider: provider.name });
  return { provider, banks: provider.payout.banks };
}

export async function listBanks(kv: KeyValue): Promise<Bank[]> {
  const { provider, banks } = await payoutRail();
  const cacheKey = `payments:banks:${provider.name}`;
  const cached = await kv.get(cacheKey);
  if (cached) return JSON.parse(cached) as Bank[];
  let list: Bank[];
  try { list = await banks.listBanks(); } catch (e) { throw unavailable(e); }
  await kv.set(cacheKey, JSON.stringify(list), BANKS_TTL_SECONDS);
  return list;
}

/** The holder's name for the person to confirm, and a token to save it with. */
export async function resolveAccount(userId: string, input: { bankCode: string; accountNumber: string }, kv: KeyValue) {
  const { provider, banks } = await payoutRail();
  const bank = (await listBanks(kv)).find((b) => b.code === input.bankCode);
  if (!bank) throw paymentsError(422, "unknown_bank");
  let resolved: { accountName: string } | null;
  try { resolved = await banks.resolveAccount(input); } catch (e) { throw unavailable(e); }
  if (!resolved) throw paymentsError(422, ACCOUNT_UNRESOLVED);
  const r: Resolution = { userId, provider: provider.name, bankCode: bank.code, bankName: bank.name, accountNumber: input.accountNumber, accountName: resolved.accountName };
  const resolveToken = randomBytes(18).toString("base64url");
  await kv.set(`payments:resolve:${resolveToken}`, JSON.stringify(r), RESOLVE_TTL_SECONDS);
  return { bankCode: r.bankCode, bankName: r.bankName, accountNumber: r.accountNumber, accountName: r.accountName, resolveToken };
}

const sameName = (a: string, b: string) => a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();

/** Save the account the person confirmed: the name must be the one the bank gave; then the provider registers it. */
export async function addBankAccount(userId: string, input: { resolveToken: string; accountName: string }, kv: KeyValue): Promise<PayoutAccount> {
  const raw = await kv.get(`payments:resolve:${input.resolveToken}`);
  const r = raw ? (JSON.parse(raw) as Resolution) : null;
  const { provider } = await payoutRail();
  if (!r || r.userId !== userId || r.provider !== provider.name) throw paymentsError(422, ACCOUNT_UNRESOLVED);
  if (!sameName(r.accountName, input.accountName)) throw paymentsError(422, NAME_MISMATCH);
  const [existing] = await db.select().from(payoutAccounts).where(and(eq(payoutAccounts.userId, userId), eq(payoutAccounts.provider, r.provider), eq(payoutAccounts.bankCode, r.bankCode), eq(payoutAccounts.accountNumber, r.accountNumber), isNull(payoutAccounts.removedAt)));
  if (existing) return existing;
  let recipientCode: string;
  try { ({ recipientCode } = await provider.payout!.createRecipient({ kind: "bank", bankCode: r.bankCode, accountNumber: r.accountNumber, accountName: r.accountName })); } catch (e) { throw unavailable(e); }
  const [saved] = await db.insert(payoutAccounts).values({ userId, provider: r.provider, bankCode: r.bankCode, bankName: r.bankName, accountNumber: r.accountNumber, accountName: r.accountName, recipientCode }).onConflictDoNothing().returning();
  await kv.del(`payments:resolve:${input.resolveToken}`);
  return saved ?? (await db.select().from(payoutAccounts).where(and(eq(payoutAccounts.userId, userId), eq(payoutAccounts.provider, r.provider), eq(payoutAccounts.bankCode, r.bankCode), eq(payoutAccounts.accountNumber, r.accountNumber), isNull(payoutAccounts.removedAt))))[0];
}

export async function bankAccountsOf(userId: string) {
  const payoutsProvider = (await currentSettings()).payouts;
  const rows = await db.select().from(payoutAccounts).where(and(eq(payoutAccounts.userId, userId), isNull(payoutAccounts.removedAt))).orderBy(desc(payoutAccounts.createdAt));
  return rows.map((a) => ({ id: a.id, bankCode: a.bankCode, bankName: a.bankName, accountNumberLast4: a.accountNumber.slice(-4), accountName: a.accountName, usable: a.provider === payoutsProvider, createdAt: a.createdAt.toISOString() }));
}

/** Removed, not deleted: withdrawals made to it still point at it. */
export async function removeBankAccount(userId: string, id: string) {
  const [gone] = await db.update(payoutAccounts).set({ removedAt: new Date() }).where(and(eq(payoutAccounts.id, id), eq(payoutAccounts.userId, userId), isNull(payoutAccounts.removedAt))).returning();
  if (!gone) throw paymentsError(404, "not_found");
}

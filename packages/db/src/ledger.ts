import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, sql as dsql } from "drizzle-orm";
import { WELCOME_BONUS_KOBO } from "@contestly/shared";
import { db, type Tx } from "./client.js";
import { ledgerAccounts, ledgerEntries, payoutContradictions, users } from "./schema.js";

export class InsufficientFunds extends Error { constructor() { super("insufficient_funds"); } }
/** A journal whose legs don't sum to zero, or a leg that isn't a whole, non-zero number of kobo. Never caught: it's a bug. */
export class LedgerImbalance extends Error { constructor(detail: string) { super(`ledger_imbalance: ${detail}`); } }
/** The same idempotency key replayed with different legs: a bug or a tampered retry. Never treated as a replay. */
export class IdempotencyConflict extends Error { constructor(key: string) { super(`idempotency_conflict: ${key}`); } }

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

/** A person's own money: these can never go below zero (the lock here, and a check constraint behind it). */
export const USER_ACCOUNT_KINDS = ["cash", "bonus"] as const;
type Kind = (typeof USER_ACCOUNT_KINDS)[number];

/**
 * The platform's side of every movement (ADR 0013), owned by the treasury account. A scope splits one
 * kind where it needs splitting: a party's pot by party id, the payment accounts by provider.
 * - party_pot: entries in, prizes, rake, host cut and refunds out (scope: party id)
 * - bonus_issued: welcome coins out, forfeited coins back
 * - prize_funding: Climb weekly prizes paid by the platform
 * - dev_mint: dev and test top-ups only (never in production)
 * - topup_in: money that came in through a provider (scope: provider)
 * - payout_pending: withdrawals debited and not yet final (scope: provider)
 * - payout_settled: withdrawals the provider confirmed sent (scope: provider)
 * - payout_fees: what the provider charged to send them (scope: provider)
 * - platform_funds: the platform paying a fee it chose to bear
 * - payout_owed: what one person owes after a payout we reversed was paid after all and their cash didn't
 *   cover it (scope: their user id). Every later cash credit to them repays it first (repayOwed).
 * - contradiction_hold: the disputed amount of a duplicate payout, secured at the freeze from the person's
 *   cash and what they owe (scope: their user id); the recovery when it's confirmed, released if it dissolves
 * - fee_variance: when the user bears a payout's fee, the difference between the fee they paid (our estimate)
 *   and what the provider charged; either sign
 */
export const SYSTEM_ACCOUNT_KINDS = ["party_pot", "bonus_issued", "prize_funding", "dev_mint", "topup_in", "payout_pending", "payout_settled", "payout_fees", "platform_funds", "payout_owed", "contradiction_hold", "fee_variance"] as const;
export type SystemKind = (typeof SYSTEM_ACCOUNT_KINDS)[number];

export type AccountRef = { userId: string; kind: Kind } | { system: SystemKind; scope?: string };
export interface Leg { account: AccountRef; amountKobo: number }
export interface Journal { legs: Leg[]; type: string; refType?: string; refId?: string; idempotencyKey: string }

const isUserRef = (a: AccountRef): a is { userId: string; kind: Kind } => "userId" in a;
/** Platform accounts kept per person (scope = their user id): locked with the person's own. */
const PERSON_SCOPED_SYSTEM: readonly string[] = ["payout_owed", "contradiction_hold"];
const isPersonScoped = (a: AccountRef) => isUserRef(a) || PERSON_SCOPED_SYSTEM.includes(a.system);
/** People whose cash this journal credits, net. */
function creditedCash(j: Journal) {
  const net = new Map<string, number>();
  for (const l of j.legs) if (isUserRef(l.account) && l.account.kind === "cash") net.set(l.account.userId, (net.get(l.account.userId) ?? 0) + l.amountKobo);
  return [...net].filter(([, v]) => v > 0).map(([u]) => u);
}

/** Leg 0 carries the journal's key itself (so existing keys keep meaning what they meant); leg i carries key#i. */
export const legKey = (key: string, i: number) => (i === 0 ? key : `${key}#${i}`);

async function existingAccountId(tx: Tx, a: AccountRef): Promise<string | null> {
  const { userId, kind, scope } = isUserRef(a) ? { ...a, scope: "" } : { userId: await treasuryUserId(tx), kind: a.system, scope: a.scope ?? "" };
  const [row] = await tx.select({ id: ledgerAccounts.id }).from(ledgerAccounts).where(and(eq(ledgerAccounts.userId, userId), eq(ledgerAccounts.kind, kind), eq(ledgerAccounts.scope, scope)));
  return row?.id ?? null;
}

async function accountId(tx: Tx, a: AccountRef): Promise<string> {
  const { userId, kind, scope } = isUserRef(a) ? { ...a, scope: "" } : { userId: await treasuryUserId(tx), kind: a.system, scope: a.scope ?? "" };
  const where = and(eq(ledgerAccounts.userId, userId), eq(ledgerAccounts.kind, kind), eq(ledgerAccounts.scope, scope));
  const [existing] = await tx.select({ id: ledgerAccounts.id }).from(ledgerAccounts).where(where);
  if (existing) return existing.id;
  const [created] = await tx.insert(ledgerAccounts).values({ userId, kind, scope }).onConflictDoNothing().returning({ id: ledgerAccounts.id });
  if (created) return created.id;
  const [again] = await tx.select({ id: ledgerAccounts.id }).from(ledgerAccounts).where(where);
  return again.id;
}

function assertBalanced(j: Journal) {
  if (j.legs.length < 2) throw new LedgerImbalance(`${j.idempotencyKey} has ${j.legs.length} leg(s)`);
  for (const l of j.legs) if (!Number.isSafeInteger(l.amountKobo) || l.amountKobo === 0) throw new LedgerImbalance(`${j.idempotencyKey} has a leg of ${l.amountKobo}`);
  const sum = j.legs.reduce((a, l) => a + l.amountKobo, 0);
  if (sum !== 0) throw new LedgerImbalance(`${j.idempotencyKey} sums to ${sum}`);
}

/**
 * The one way money moves: a journal of legs that sum to zero, written in the caller's transaction. Every
 * account it touches is locked (in id order, so two journals can't deadlock each other), then each leg is
 * appended and its balance moved. Idempotent on idempotencyKey: a replay with the same legs is a no-op; a
 * replay with different legs throws IdempotencyConflict. A person's cash or bonus going below zero throws
 * InsufficientFunds (and rolls the transaction back).
 */
export async function journal(tx: Tx, j: Journal): Promise<{ replayed: boolean; balances: Map<string, number> }> {
  assertBalanced(j);
  const ids = [] as string[];
  for (const l of j.legs) ids.push(await accountId(tx, l.account));
  // The lock order (ADR 0013): a person's accounts (theirs, and what they owe or have held) before platform
  // accounts, each by id. Cash credited to someone who owes repays it below, so their owed account is locked
  // now, with the person's, rather than after the platform's.
  const person = new Set<string>(), platform = new Set<string>();
  j.legs.forEach((l, i) => (isPersonScoped(l.account) ? person : platform).add(ids[i]));
  for (const userId of creditedCash(j)) {
    const owed = await existingAccountId(tx, owedAccount(userId));
    if (owed) person.add(owed);
  }
  const lockIds = async (set: Set<string>) => (set.size ? tx.select().from(ledgerAccounts).where(inArray(ledgerAccounts.id, [...set])).orderBy(asc(ledgerAccounts.id)).for("update") : []);
  const locked = [...(await lockIds(person)), ...(await lockIds(platform))];
  const byId = new Map(locked.map((a) => [a.id, a]));
  const keys = j.legs.map((_, i) => legKey(j.idempotencyKey, i));

  const journalId = randomUUID();
  const [first] = await tx.insert(ledgerEntries).values({ journalId, accountId: ids[0], amountKobo: j.legs[0].amountKobo, type: j.type, refType: j.refType, refId: j.refId, idempotencyKey: keys[0] })
    .onConflictDoNothing().returning({ id: ledgerEntries.id });
  if (!first) {
    const prior = await tx.select({ key: ledgerEntries.idempotencyKey, journalId: ledgerEntries.journalId, accountId: ledgerEntries.accountId, amountKobo: ledgerEntries.amountKobo }).from(ledgerEntries).where(inArray(ledgerEntries.idempotencyKey, keys));
    const matches = (i: number) => prior.some((p) => p.key === keys[i] && p.accountId === ids[i] && Number(p.amountKobo) === j.legs[i].amountKobo);
    // A key first written before double entry (no journal) has only the person's leg: that leg matching is the replay.
    const legacy = prior.find((p) => p.key === keys[0])?.journalId === null;
    const same = legacy ? prior.length === 1 && matches(0) : prior.length === keys.length && keys.every((_, i) => matches(i));
    if (!same) throw new IdempotencyConflict(j.idempotencyKey);
    return { replayed: true, balances: new Map(locked.map((a) => [a.id, a.balanceKobo])) };
  }
  if (j.legs.length > 1) {
    await tx.insert(ledgerEntries).values(j.legs.slice(1).map((l, i) => ({ journalId, accountId: ids[i + 1], amountKobo: l.amountKobo, type: j.type, refType: j.refType, refId: j.refId, idempotencyKey: keys[i + 1] })));
  }
  const next = new Map(locked.map((a) => [a.id, a.balanceKobo]));
  j.legs.forEach((l, i) => next.set(ids[i], next.get(ids[i])! + l.amountKobo));
  for (const [id, balance] of next) {
    const acct = byId.get(id)!;
    if (balance === acct.balanceKobo) continue;
    if ((USER_ACCOUNT_KINDS as readonly string[]).includes(acct.kind) && balance < 0) throw new InsufficientFunds();
    await tx.update(ledgerAccounts).set({ balanceKobo: balance }).where(eq(ledgerAccounts.id, id));
  }
  // Cash that just reached a person who owes repays it first, each as its own journal (ADR 0013).
  const credited = new Map<string, { accountId: string; kobo: number }>();
  j.legs.forEach((l, i) => {
    if (!isUserRef(l.account) || l.account.kind !== "cash") return;
    const c = credited.get(l.account.userId) ?? { accountId: ids[i], kobo: 0 };
    credited.set(l.account.userId, { ...c, kobo: c.kobo + l.amountKobo });
  });
  for (const [userId, c] of credited) {
    if (c.kobo <= 0) continue;
    const repaid = await repayOwed(tx, userId, c.kobo, j.idempotencyKey);
    if (repaid) next.set(c.accountId, next.get(c.accountId)! - repaid);
  }
  return { replayed: false, balances: next };
}

/** What a person owes (after a duplicate payout their cash didn't cover): the platform's payout_owed account for them. */
export const owedAccount = (userId: string): AccountRef => ({ system: "payout_owed", scope: userId });
/** The disputed amount of this person's open duplicate payouts, held out of their cash (ADR 0013). */
export const contradictionHoldAccount = (userId: string): AccountRef => ({ system: "contradiction_hold", scope: userId });

/** How much this person owes, in kobo (0 when nothing). */
export async function owedKobo(conn: Tx | typeof db, userId: string): Promise<number> {
  const [treasury] = await conn.select({ id: users.id }).from(users).where(eq(users.handle, TREASURY_HANDLE));
  if (!treasury) return 0;
  const [row] = await conn.select({ b: ledgerAccounts.balanceKobo }).from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.userId, treasury.id), eq(ledgerAccounts.kind, "payout_owed"), eq(ledgerAccounts.scope, userId)));
  return row ? Math.max(0, -row.b) : 0;
}

/**
 * What one contradiction's debt has become (ADR 0013), read from the person's owed account, where every
 * movement names its contradiction (refType "contradiction"): booked at the freeze, repaid, waived,
 * released at a dissolve. outstanding = booked − repaid − waived − released. Read it under the owed
 * account's lock when it sizes a journal.
 */
export async function contradictionDebt(conn: Tx | typeof db, userId: string, contradictionId: string) {
  const rows = await conn.select({ type: ledgerEntries.type, total: dsql<number>`sum(${ledgerEntries.amountKobo})::bigint` })
    .from(ledgerEntries).innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .where(and(eq(ledgerAccounts.kind, "payout_owed"), eq(ledgerAccounts.scope, userId), eq(ledgerEntries.refType, "contradiction"), eq(ledgerEntries.refId, contradictionId)))
    .groupBy(ledgerEntries.type);
  const of = (type: string) => Number(rows.find((r) => r.type === type)?.total ?? 0);
  const booked = -of("contradiction_held");
  const repaid = of("owed_repaid");
  const waived = of("owed_waived");
  const released = of("contradiction_released");
  return { booked, repaid, waived, released, outstanding: booked - repaid - waived - released };
}

/** A person's contradictions with debt outstanding, oldest first: what repayments and waivers pay down, in that order. */
export async function outstandingDebts(tx: Tx, userId: string) {
  const cs = await tx.select({ id: payoutContradictions.id }).from(payoutContradictions)
    .where(and(eq(payoutContradictions.userId, userId), gt(payoutContradictions.owedKobo, 0))).orderBy(asc(payoutContradictions.createdAt), asc(payoutContradictions.id));
  const out: { contradictionId: string; outstanding: number }[] = [];
  for (const c of cs) {
    const d = await contradictionDebt(tx, userId, c.id);
    if (d.outstanding > 0) out.push({ contradictionId: c.id, outstanding: d.outstanding });
  }
  return out;
}

/**
 * A person's open payment issues: what they owe, whether a contradiction of theirs is still open, and what's
 * held for it. Any of them blocks deleting the account; any of them (or a resolved contradiction) on a
 * deleted account blocks withdrawals on a new account with its email or phone (ADR 0013).
 */
export async function paymentIssues(conn: Tx | typeof db, userId: string) {
  const [owed, [open], held] = await Promise.all([
    owedKobo(conn, userId),
    conn.select({ id: payoutContradictions.id }).from(payoutContradictions).where(and(eq(payoutContradictions.userId, userId), inArray(payoutContradictions.status, ["open", "awaiting_second_admin"]))).limit(1),
    conn.select({ b: ledgerAccounts.balanceKobo }).from(ledgerAccounts).where(and(eq(ledgerAccounts.kind, "contradiction_hold"), eq(ledgerAccounts.scope, userId))),
  ]);
  return { owedKobo: owed, openContradiction: !!open, heldKobo: held[0]?.b ?? 0 };
}

/** Lock what's kept per person (their owed account and hold), by id, before reading either to size a journal. */
export async function lockPersonScoped(tx: Tx, userId: string) {
  const ids: string[] = [];
  for (const a of [owedAccount(userId), contradictionHoldAccount(userId)]) {
    const id = await existingAccountId(tx, a);
    if (id) ids.push(id);
  }
  if (ids.length) await tx.select({ id: ledgerAccounts.id }).from(ledgerAccounts).where(inArray(ledgerAccounts.id, ids)).orderBy(asc(ledgerAccounts.id)).for("update");
}

/**
 * Repay what a person owes from cash just credited to them, up to that credit: cash → payout_owed, oldest
 * contradiction's debt first, one journal per debt, keyed owed_repay:<user>:<the credit's key>:<contradiction>
 * (the user too: one journal may credit several people who owe) and naming the contradiction. Only cash:
 * bonus coins never repay. The owed account is locked before anything is read, so two credits at once can't
 * both repay the same debt. Returns what it repaid.
 */
async function repayOwed(tx: Tx, userId: string, creditKobo: number, sourceKey: string): Promise<number> {
  const [treasury] = await tx.select({ id: users.id }).from(users).where(eq(users.handle, TREASURY_HANDLE));
  if (!treasury || treasury.id === userId) return 0;
  const [owed] = await tx.select().from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.userId, treasury.id), eq(ledgerAccounts.kind, "payout_owed"), eq(ledgerAccounts.scope, userId))).for("update");
  if (!owed || owed.balanceKobo >= 0) return 0;
  let left = Math.min(creditKobo, -owed.balanceKobo);
  let repaid = 0;
  for (const d of await outstandingDebts(tx, userId)) {
    if (left <= 0) break;
    const amount = Math.min(left, d.outstanding);
    await journal(tx, {
      type: "owed_repaid", refType: "contradiction", refId: d.contradictionId, idempotencyKey: `owed_repay:${userId}:${sourceKey}:${d.contradictionId}`,
      legs: [{ account: { userId, kind: "cash" }, amountKobo: -amount }, { account: owedAccount(userId), amountKobo: amount }],
    });
    left -= amount;
    repaid += amount;
  }
  return repaid;
}

/**
 * Which platform account is the other side of a movement to or from a person, by its type. post() uses it so
 * every call is a balanced journal without each caller naming the platform's side. A type that isn't here
 * throws: new kinds of movement are added here on purpose (payments use journal() with their own legs).
 */
const CONTRA: Record<string, (p: { refType?: string; refId?: string }) => AccountRef> = {
  party_entry: partyPot, party_leave_refund: partyPot, party_refund: partyPot, party_fund: partyPot,
  party_prize: partyPot, party_rake: partyPot, party_host_cut: partyPot,
  welcome_bonus: () => ({ system: "bonus_issued" }), account_deleted_forfeit: () => ({ system: "bonus_issued" }),
  climb_prize: () => ({ system: "prize_funding" }),
  /** Dev and test top-ups (/wallet/dev-topup, the seed, tests). Real top-ups are payments journals from topup_in. */
  topup: () => ({ system: "dev_mint" }),
};
function partyPot(p: { refType?: string; refId?: string }): AccountRef {
  if (p.refType !== "party" || !p.refId) throw new LedgerImbalance(`a party movement needs refType "party" and the party id (got ${p.refType}:${p.refId})`);
  return { system: "party_pot", scope: p.refId };
}

/**
 * Post one signed movement to a person's account, balanced by the platform account for its type (CONTRA).
 * Idempotent on idempotencyKey (a replay is a no-op).
 */
export async function post(tx: Tx, p: { userId: string; kind: Kind; amountKobo: number; type: string; refType?: string; refId?: string; idempotencyKey: string }) {
  const contra = CONTRA[p.type];
  if (!contra) throw new LedgerImbalance(`no platform account for movement type "${p.type}"`);
  const user: AccountRef = { userId: p.userId, kind: p.kind };
  const out = await journal(tx, { type: p.type, refType: p.refType, refId: p.refId, idempotencyKey: p.idempotencyKey, legs: [{ account: user, amountKobo: p.amountKobo }, { account: contra(p), amountKobo: -p.amountKobo }] });
  const id = await accountId(tx, user);
  return { replayed: out.replayed, balanceKobo: out.balances.get(id)! };
}

/** The welcome bonus coins, granted exactly once per user however many times it's asked for. */
export const grantWelcome = (tx: Tx, userId: string) =>
  post(tx, { userId, kind: "bonus", amountKobo: WELCOME_BONUS_KOBO, type: "welcome_bonus", idempotencyKey: `welcome:${userId}` });

/** A person's cash and bonus accounts, created if new and locked for this transaction. */
export async function lockUserAccounts(tx: Tx, userId: string) {
  const ids = [await accountId(tx, { userId, kind: "bonus" }), await accountId(tx, { userId, kind: "cash" })];
  const rows = await tx.select().from(ledgerAccounts).where(inArray(ledgerAccounts.id, ids)).orderBy(asc(ledgerAccounts.id)).for("update");
  return { bonus: rows.find((r) => r.kind === "bonus")!, cash: rows.find((r) => r.kind === "cash")! };
}

/** Charge an entry fee: bonus coins first, then cash. Throws InsufficientFunds if both together can't cover it. */
export async function charge(tx: Tx, p: { userId: string; amountKobo: number; type: string; refType: string; refId: string; idempotencyKey: string }) {
  if (p.amountKobo === 0) return { fromBonus: 0, fromCash: 0 };
  const { bonus, cash } = await lockUserAccounts(tx, p.userId);
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
    .where(inArray(ledgerEntries.idempotencyKey, [p.chargeKey + ":bonus", p.chargeKey + ":cash"])) as { userId: string; kind: Kind; amountKobo: number }[];
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

/** One page of a user's ledger, newest first. `before` is the previous page's nextBefore ("<iso>|<id>"). */
export async function historyPage(userId: string, opts: { before?: string; limit: number }) {
  const [at, id] = opts.before?.split("|") ?? [];
  const older = at && id ? dsql`(${ledgerEntries.createdAt}, ${ledgerEntries.id}) < (${new Date(at)}, ${id}::uuid)` : undefined;
  const rows = await db.select({ id: ledgerEntries.id, kind: ledgerAccounts.kind, amountKobo: ledgerEntries.amountKobo, type: ledgerEntries.type, refType: ledgerEntries.refType, refId: ledgerEntries.refId, createdAt: ledgerEntries.createdAt })
    .from(ledgerEntries).innerJoin(ledgerAccounts, eq(ledgerEntries.accountId, ledgerAccounts.id))
    .where(older ? and(eq(ledgerAccounts.userId, userId), older) : eq(ledgerAccounts.userId, userId))
    .orderBy(dsql`${ledgerEntries.createdAt} desc, ${ledgerEntries.id} desc`).limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit);
  const last = page[page.length - 1];
  return { entries: page, nextBefore: rows.length > opts.limit && last ? `${last.createdAt.toISOString()}|${last.id}` : null };
}

export async function history(userId: string, limit = 50) {
  return db.select({ id: ledgerEntries.id, kind: ledgerAccounts.kind, amountKobo: ledgerEntries.amountKobo, type: ledgerEntries.type, refType: ledgerEntries.refType, refId: ledgerEntries.refId, createdAt: ledgerEntries.createdAt })
    .from(ledgerEntries).innerJoin(ledgerAccounts, eq(ledgerEntries.accountId, ledgerAccounts.id))
    .where(eq(ledgerAccounts.userId, userId)).orderBy(dsql`${ledgerEntries.createdAt} desc`).limit(limit);
}

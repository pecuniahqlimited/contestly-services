import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { db, ledger, payoutAccounts, payouts } from "@contestly/db";
import {
  addBankAccountSchema, bankAccountSchema, bankAccountsResponseSchema, banksResponseSchema, createTopupSchema, kobo, payoutSchema, payoutsResponseSchema,
  resolveAccountResponseSchema, resolveAccountSchema, topupSchema, topupsResponseSchema, walletLimitsQuerySchema, walletLimitsSchema, withdrawalRequestSchema,
} from "@contestly/shared";
import {
  addBankAccount, bankAccountsOf, createTopup, listBanks, paymentsDevTools, payoutView, removeBankAccount, requestPayout, resolveAccount, topupForUser, topupsOf, topupView, walletLimits,
} from "@contestly/payments";
import { uuidParam } from "../auth.js";
import { actor } from "../acting.js";
import { paymentsDeps, paymentsKv, topupReturnUrl } from "../payments.js";

const WITHDRAWALS_SHOWN = 50;
const TOPUPS_SHOWN = 50;

/**
 * The wallet: a person's own, or with ACT_AS_HEADER a brand's (ADR 0017 §8): its admins and owner see it and top it
 * up; only its owner adds payout accounts and withdraws. Every money rule is the account's, so a brand's is the same.
 */
export async function walletRoutes(app: FastifyInstance) {
  app.get("/wallet", { config: { actAs: "wallet.view" } }, async (req) => {
    const { as: me } = await actor(req);
    const owedKobo = await ledger.owedKobo(db, me.id);
    return { ...(await ledger.balances(me.id)), history: await ledger.history(me.id), owed: owedKobo > 0 ? { amountKobo: owedKobo, reason: "duplicate_payout" as const } : null };
  });

  /** Local-only funding for sims and tests (minted against dev_mint, never a payment). Only with PAYMENTS_DEV_TOOLS, never in production. */
  app.post("/wallet/dev-topup", { config: { actAs: "wallet.topup" } }, async (req, reply) => {
    if (!paymentsDevTools()) return reply.code(404).send();
    const { as: me } = await actor(req);
    const { nairaAmount = 1000 } = (req.body ?? {}) as { nairaAmount?: number };
    const ref = `devtopup:${me.id}:${Date.now()}`;
    await db.transaction((tx) => ledger.post(tx, { userId: me.id, kind: "cash", amountKobo: kobo(nairaAmount), type: "topup", refType: "dev", refId: ref, idempotencyKey: ref }));
    return ledger.balances(me.id);
  });

  /**
   * Start a top-up: the server makes the reference and the pending record, then asks the provider for a
   * checkout. The wallet is credited later, only from the provider's verified confirmation.
   */
  app.post("/wallet/topups", { config: { actAs: "wallet.topup" } }, async (req, reply) => {
    const { as: me, person, brand } = await actor(req);
    const { amountKobo } = createTopupSchema.parse(req.body);
    const payerEmail = brand ? (brand.brand.businessEmailVerifiedAt && brand.brand.businessEmail) || (person.emailVerifiedAt ? person.email ?? undefined : undefined) : undefined;
    const t = await createTopup(me, amountKobo, { returnUrl: topupReturnUrl(), payerEmail });
    return reply.code(201).send(topupSchema.parse(topupView(t)));
  });

  /**
   * What the person can do right now: top-up min, max and what's left of today's cap; the withdrawal minimum
   * and what's left of each daily limit; who bears the transfer fee, its tiers, and (?amountKobo=) the estimate.
   */
  app.get("/wallet/limits", { config: { actAs: "wallet.view" } }, async (req) => {
    const { as: me } = await actor(req);
    const { amountKobo } = walletLimitsQuerySchema.parse(req.query);
    return walletLimitsSchema.parse(await walletLimits(me.id, amountKobo));
  });

  /** The person's top-ups, newest first (creditedKobo once credited). */
  app.get("/wallet/topups", { config: { actAs: "wallet.view" } }, async (req) => {
    const { as: me } = await actor(req);
    return topupsResponseSchema.parse({ topups: (await topupsOf(me.id, TOPUPS_SHOWN)).map(topupView) });
  });

  /** After checkout the app polls this. Our record only: it never asks the provider and never credits. */
  app.get("/wallet/topups/:reference", { config: { actAs: "wallet.view" } }, async (req) => {
    const { as: me } = await actor(req);
    const { reference } = req.params as { reference: string };
    const t = await topupForUser(me.id, reference);
    if (!t) throw Object.assign(new Error("not_found"), { statusCode: 404 });
    return topupSchema.parse(topupView(t));
  });

  app.get("/wallet/banks", { config: { actAs: "payout_accounts" } }, async (req) => {
    await actor(req);
    return banksResponseSchema.parse({ banks: await listBanks(paymentsKv) });
  });

  /** The holder's name for the person to confirm before the account is saved. */
  app.post("/wallet/bank-accounts/resolve", { config: { actAs: "payout_accounts" } }, async (req) => {
    const { as: me } = await actor(req);
    return resolveAccountResponseSchema.parse(await resolveAccount(me.id, resolveAccountSchema.parse(req.body), paymentsKv));
  });

  app.post("/wallet/bank-accounts", { config: { actAs: "payout_accounts" } }, async (req, reply) => {
    const { as: me } = await actor(req);
    await addBankAccount(me.id, addBankAccountSchema.parse(req.body), paymentsKv);
    const accounts = await bankAccountsOf(me.id);
    return reply.code(201).send(bankAccountsResponseSchema.parse({ accounts }));
  });

  app.get("/wallet/bank-accounts", { config: { actAs: "wallet.view" } }, async (req) => {
    const { as: me } = await actor(req);
    return bankAccountsResponseSchema.parse({ accounts: (await bankAccountsOf(me.id)).map((a) => bankAccountSchema.parse(a)) });
  });

  app.delete("/wallet/bank-accounts/:id", { config: { actAs: "payout_accounts" } }, async (req, reply) => {
    const { as: me } = await actor(req);
    await removeBankAccount(me.id, uuidParam(req));
    return reply.code(204).send();
  });

  /** Withdraw cash to a confirmed bank account. Debited now; sent by the worker. A retry with the same clientRequestId is the same withdrawal. */
  app.post("/wallet/withdrawals", { config: { actAs: "wallet.withdraw" } }, async (req, reply) => {
    const { as: me } = await actor(req);
    const { payout, replayed } = await requestPayout(me, withdrawalRequestSchema.parse(req.body), paymentsDeps);
    const [account] = await db.select().from(payoutAccounts).where(eq(payoutAccounts.id, payout.payoutAccountId));
    return reply.code(replayed ? 200 : 201).send({ payout: payoutSchema.parse(payoutView(payout, account)), replayed });
  });

  app.get("/wallet/withdrawals", { config: { actAs: "wallet.view" } }, async (req) => {
    const { as: me } = await actor(req);
    const rows = await db.select({ p: payouts, a: payoutAccounts }).from(payouts).innerJoin(payoutAccounts, eq(payoutAccounts.id, payouts.payoutAccountId))
      .where(and(eq(payouts.userId, me.id))).orderBy(desc(payouts.createdAt)).limit(WITHDRAWALS_SHOWN);
    return payoutsResponseSchema.parse({ payouts: rows.map(({ p, a }) => payoutView(p, a)) });
  });
}

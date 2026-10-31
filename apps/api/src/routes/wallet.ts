import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { db, ledger, payoutAccounts, payouts } from "@contestly/db";
import {
  addBankAccountSchema, bankAccountSchema, bankAccountsResponseSchema, banksResponseSchema, createTopupSchema, kobo, payoutSchema, payoutsResponseSchema,
  resolveAccountResponseSchema, resolveAccountSchema, topupSchema, withdrawalRequestSchema,
} from "@contestly/shared";
import {
  addBankAccount, bankAccountsOf, createTopup, listBanks, payoutView, removeBankAccount, requestPayout, resolveAccount, topupForUser, topupView,
} from "@contestly/payments";
import { requireUser, uuidParam } from "../auth.js";
import { paymentsDeps, paymentsKv, topupReturnUrl } from "../payments.js";

const WITHDRAWALS_SHOWN = 50;

export async function walletRoutes(app: FastifyInstance) {
  app.get("/wallet", async (req) => {
    const me = requireUser(req);
    return { ...(await ledger.balances(me.id)), history: await ledger.history(me.id) };
  });

  /** Local-only funding for sims and tests (minted against dev_mint, never a payment). Gone in production. */
  app.post("/wallet/dev-topup", async (req, reply) => {
    if (process.env.NODE_ENV === "production") return reply.code(404).send();
    const me = requireUser(req);
    const { nairaAmount = 1000 } = (req.body ?? {}) as { nairaAmount?: number };
    const ref = `devtopup:${me.id}:${Date.now()}`;
    await db.transaction((tx) => ledger.post(tx, { userId: me.id, kind: "cash", amountKobo: kobo(nairaAmount), type: "topup", refType: "dev", refId: ref, idempotencyKey: ref }));
    return ledger.balances(me.id);
  });

  /**
   * Start a top-up: the server makes the reference and the pending record, then asks the provider for a
   * checkout. The wallet is credited later, only from the provider's verified confirmation.
   */
  app.post("/wallet/topups", async (req, reply) => {
    const me = requireUser(req);
    const { amountKobo } = createTopupSchema.parse(req.body);
    const t = await createTopup(me, amountKobo, { returnUrl: topupReturnUrl() });
    return reply.code(201).send(topupSchema.parse(topupView(t)));
  });

  /** After checkout the app polls this. Our record only: it never asks the provider and never credits. */
  app.get("/wallet/topups/:reference", async (req) => {
    const me = requireUser(req);
    const { reference } = req.params as { reference: string };
    const t = await topupForUser(me.id, reference);
    if (!t) throw Object.assign(new Error("not_found"), { statusCode: 404 });
    return topupSchema.parse(topupView(t));
  });

  app.get("/wallet/banks", async (req) => {
    requireUser(req);
    return banksResponseSchema.parse({ banks: await listBanks(paymentsKv) });
  });

  /** The holder's name for the person to confirm before the account is saved. */
  app.post("/wallet/bank-accounts/resolve", async (req) => {
    const me = requireUser(req);
    return resolveAccountResponseSchema.parse(await resolveAccount(me.id, resolveAccountSchema.parse(req.body), paymentsKv));
  });

  app.post("/wallet/bank-accounts", async (req, reply) => {
    const me = requireUser(req);
    await addBankAccount(me.id, addBankAccountSchema.parse(req.body), paymentsKv);
    const accounts = await bankAccountsOf(me.id);
    return reply.code(201).send(bankAccountsResponseSchema.parse({ accounts }));
  });

  app.get("/wallet/bank-accounts", async (req) => {
    const me = requireUser(req);
    return bankAccountsResponseSchema.parse({ accounts: (await bankAccountsOf(me.id)).map((a) => bankAccountSchema.parse(a)) });
  });

  app.delete("/wallet/bank-accounts/:id", async (req, reply) => {
    const me = requireUser(req);
    await removeBankAccount(me.id, uuidParam(req));
    return reply.code(204).send();
  });

  /** Withdraw cash to a confirmed bank account. Debited now; sent by the worker. A retry with the same clientRequestId is the same withdrawal. */
  app.post("/wallet/withdrawals", async (req, reply) => {
    const me = requireUser(req);
    const { payout, replayed } = await requestPayout(me, withdrawalRequestSchema.parse(req.body), paymentsDeps);
    const [account] = await db.select().from(payoutAccounts).where(eq(payoutAccounts.id, payout.payoutAccountId));
    return reply.code(replayed ? 200 : 201).send({ payout: payoutSchema.parse(payoutView(payout, account)), replayed });
  });

  app.get("/wallet/withdrawals", async (req) => {
    const me = requireUser(req);
    const rows = await db.select({ p: payouts, a: payoutAccounts }).from(payouts).innerJoin(payoutAccounts, eq(payoutAccounts.id, payouts.payoutAccountId))
      .where(and(eq(payouts.userId, me.id))).orderBy(desc(payouts.createdAt)).limit(WITHDRAWALS_SHOWN);
    return payoutsResponseSchema.parse({ payouts: rows.map(({ p, a }) => payoutView(p, a)) });
  });
}

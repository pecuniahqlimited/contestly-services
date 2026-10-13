import type { FastifyInstance } from "fastify";
import { db, ledger } from "@contestly/db";
import { kobo } from "@contestly/shared";
import { requireUser } from "../auth.js";

export async function walletRoutes(app: FastifyInstance) {
  app.get("/wallet", async (req) => {
    const me = requireUser(req);
    return { ...(await ledger.balances(me.id)), history: await ledger.history(me.id) };
  });

  /** Local-only stand-in for a Paystack top-up. In production this is a verified Paystack webhook, never a user-callable route. */
  app.post("/wallet/dev-topup", async (req, reply) => {
    if (process.env.NODE_ENV === "production") return reply.code(404).send();
    const me = requireUser(req);
    const { nairaAmount = 1000 } = (req.body ?? {}) as { nairaAmount?: number };
    const ref = `devtopup:${me.id}:${Date.now()}`;
    await db.transaction((tx) => ledger.post(tx, { userId: me.id, kind: "cash", amountKobo: kobo(nairaAmount), type: "topup", refType: "paystack", refId: ref, idempotencyKey: ref }));
    return ledger.balances(me.id);
  });
}

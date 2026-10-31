import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ingestWebhook, mockControlsOrNull } from "@contestly/payments";
import { paymentsDeps, topupReturnUrl, webhookIpAllowlist } from "../payments.js";

/**
 * POST /webhooks/:provider. The provider authenticates its own webhook against the raw body (so this context
 * keeps bodies as bytes), then the event is stored and acknowledged; the worker processes it. Exempt from the
 * per-IP rate limit only (a provider retries from a few addresses); everything else applies.
 */
export async function paymentWebhookRoutes(app: FastifyInstance) {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  app.post("/webhooks/:provider", { config: { rateLimit: false } }, async (req) => {
    const { provider } = req.params as { provider: string };
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const out = await ingestWebhook(provider, raw, req.headers, { ipAllowlist: webhookIpAllowlist(), clientIp: req.clientIp }, paymentsDeps);
    return { received: true, duplicate: out.duplicate };
  });
}

const actionSchema = z.object({ action: z.enum(["pay", "fail"]) });
const page = (reference: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mock checkout</title>
<style>body{font:16px system-ui;margin:0;padding:24px;background:#f6f6f6}main{max-width:420px;margin:auto;background:#fff;border-radius:12px;padding:24px}button{font:inherit;padding:12px 18px;margin:8px 8px 0 0;border-radius:8px;border:1px solid #ccc;cursor:pointer}.pay{background:#0a7;color:#fff;border:0}</style></head>
<body><main><h1>Mock checkout</h1><p>Dev only. Reference <code>${reference}</code>.</p><p>Paying here sends the mock provider's webhook to this API, exactly as a real provider would.</p>
<button class="pay" onclick="go('pay')">Pay</button><button onclick="go('fail')">Fail</button><p id="out"></p></main>
<script>async function go(action){const r=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})});const j=await r.json();document.getElementById('out').textContent=r.ok?'Done. Return to the app.':'Error: '+j.error;if(r.ok&&j.returnUrl)location.href=j.returnUrl+(j.returnUrl.includes('?')?'&':'?')+'reference=${reference}';}</script></body></html>`;

/** Dev only: the mock provider's checkout page. Paying posts the mock's signed webhook through the real ingest path. */
export async function mockCheckoutRoutes(app: FastifyInstance) {
  if (process.env.NODE_ENV === "production") return;
  app.get("/payments/mock/checkout/:reference", async (req, reply) => {
    const { reference } = req.params as { reference: string };
    return reply.type("text/html").send(page(reference.replace(/[^a-z0-9-]/gi, "")));
  });
  app.post("/payments/mock/checkout/:reference", async (req) => {
    const mock = mockControlsOrNull();
    if (!mock) throw Object.assign(new Error("not_found"), { statusCode: 404 });
    const { reference } = req.params as { reference: string };
    const { action } = actionSchema.parse(req.body);
    const deliveries = await mock.completeCheckout(reference, action);
    const results = [];
    for (const d of deliveries) {
      // A delivery the provider signed wrongly is refused at ingest, as it would be from outside.
      results.push(await ingestWebhook("mock", d.rawBody, d.headers, { ipAllowlist: false, clientIp: req.clientIp }, paymentsDeps).then(() => "accepted", (e: Error) => e.message));
    }
    return { deliveries: results, returnUrl: topupReturnUrl() };
  });
}

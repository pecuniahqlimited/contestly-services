import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { authMode } from "@contestly/auth";
import { OAUTH_PROVIDERS, authExchangeSchema, emailStartSchema, emailVerifySchema, oauthStartSchema, type OAuthProvider } from "@contestly/shared";
import { requireSession } from "../auth.js";
import { limit } from "../redis.js";
import { checkEmailCode, startEmailCode } from "../signin/emailCode.js";
import { signIn, withSessionToken } from "../signin/account.js";
import { exchangeCode, oauthCallback, startOAuth, type CallbackResult } from "../signin/oauthFlow.js";
import { STUB_AUTHORIZE_PATH, stubCode } from "../signin/oauth/index.js";

const providerParam = z.object({ provider: z.enum(OAUTH_PROVIDERS) });
const callbackQuery = z.object({ code: z.string().max(2048).optional(), state: z.string().max(200).optional(), error: z.string().max(200).optional() });
const stubQuery = z.object({ provider: z.enum(OAUTH_PROVIDERS), state: z.string(), nonce: z.string(), redirect_uri: z.string().url(), login_hint: z.string().email().optional() });

const page = (reply: FastifyReply, text: string, status = 400) =>
  reply.code(status).type("text/html; charset=utf-8").send(`<!doctype html><meta name="viewport" content="width=device-width"><title>Contestly</title><p style="font-family:system-ui;padding:24px">${text}</p>`);

const finish = (reply: FastifyReply, r: CallbackResult) => ("redirect" in r ? reply.redirect(r.redirect, 302) : page(reply, r.page));

/** Sign-in is email-first and nobody leaves the app (ADR 0006). Every route works from a web client. */
export async function authRoutes(app: FastifyInstance) {
  /** Email a 6-digit code. The session (a guest, usually) is who it's for. */
  app.post("/auth/email/start", async (req) => {
    const session = requireSession(req);
    const { email } = emailStartSchema.parse(req.body);
    return startEmailCode(session, email, req.ip);
  });

  /** Check the code and sign in: the guest signs up (same account), or lands on the account that has this email. */
  app.post("/auth/email/verify", async (req) => {
    const session = requireSession(req);
    const { email, code } = emailVerifySchema.parse(req.body);
    await checkEmailCode(session, email, code, req.ip);
    return withSessionToken(await signIn(session, { email }));
  });

  /** Google or Apple: where to open the system browser. */
  app.post("/auth/oauth/start", async (req) => {
    const session = requireSession(req);
    await limit(`oauth-start:ip:${req.ip}`, 30, 600);
    return startOAuth(session, oauthStartSchema.parse(req.body));
  });

  // The provider sends the browser back here: Google with a GET, Apple with a form POST.
  const callback = async (provider: OAuthProvider, params: unknown, reply: FastifyReply) => finish(reply, await oauthCallback(provider, callbackQuery.parse(params)));
  app.get("/auth/oauth/:provider/callback", (req, reply) => callback(providerParam.parse(req.params).provider, req.query, reply));
  app.post("/auth/oauth/:provider/callback", (req, reply) => callback(providerParam.parse(req.params).provider, req.body, reply));

  /** The deep link's one-time code → a Firebase custom token. Same session that started, with its PKCE verifier. */
  app.post("/auth/exchange", async (req) => {
    const session = requireSession(req);
    await limit(`exchange:ip:${req.ip}`, 30, 600);
    return exchangeCode(session, authExchangeSchema.parse(req.body));
  });

  // DEV ONLY: the stand-in provider page (see signin/oauth/stub.ts). Never registered outside AUTH_MODE=dev.
  if (authMode() === "dev") {
    app.get(STUB_AUTHORIZE_PATH, async (req, reply) => {
      const q = stubQuery.parse(req.query);
      if (q.login_hint) {
        const back = new URL(q.redirect_uri);
        back.searchParams.set("code", stubCode({ email: q.login_hint, nonce: q.nonce, provider: q.provider }));
        back.searchParams.set("state", q.state);
        return reply.redirect(back.toString(), 302);
      }
      const hidden = Object.entries({ provider: q.provider, state: q.state, nonce: q.nonce, redirect_uri: q.redirect_uri })
        .map(([k, v]) => `<input type="hidden" name="${k}" value="${v.replace(/"/g, "&quot;")}">`).join("");
      return reply.type("text/html; charset=utf-8").send(`<!doctype html><meta name="viewport" content="width=device-width"><title>Dev sign-in</title>
<form style="font-family:system-ui;padding:24px" method="get"><p>Dev stand-in for <b>${q.provider}</b>. Sign in as:</p>${hidden}
<input name="login_hint" type="email" placeholder="you@example.com" required autofocus style="font-size:18px;padding:8px"> <button>Continue</button></form>`);
    });
  }
}

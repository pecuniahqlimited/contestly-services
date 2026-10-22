/**
 * Google and Apple in the WebView (ADR 0006): the app opens our authorize URL in the system browser
 * (@capacitor/browser; a plain redirect on the web), the provider returns to our callback, and we send
 * the browser back to the app (deep link or https://play…/auth) with a one-time code. The app trades
 * that code, from the same session and with its PKCE verifier, for a Firebase custom token. The code
 * lives 60 s and works once. Nothing about any account changes until that exchange succeeds: the
 * callback only holds the provider's verified identity. No Firebase popup or redirect flow anywhere.
 */
import type { User } from "@contestly/db";
import { AUTH_EXCHANGE_TTL_SECONDS, OAUTH_STATE_TTL_SECONDS, type OAuthProvider, type SignInResult } from "@contestly/shared";
import { valkey } from "../redis.js";
import { httpError } from "../httpError.js";
import { randomToken, s256, sha256 } from "./secrets.js";
import { signIn, withSessionToken, type VerifiedSignIn } from "./account.js";
import { apiPublicUrl, oauthClientsFromEnv } from "./oauth/index.js";

export const oauthClients = oauthClientsFromEnv(process.env);

interface PendingOAuth { provider: OAuthProvider; sessionUserId: string; nonce: string; verifier: string; returnTo: string; challenge: string }
interface PendingExchange { signIn: VerifiedSignIn; sessionUserId: string; challenge: string }

const stateKey = (state: string) => `auth:oauth:${state}`;
/** Keyed by the code's hash, so a Valkey dump doesn't hand out live codes. */
export const exchangeKey = (code: string) => `auth:exchange:${sha256(code)}`;

const callbackUrl = (provider: OAuthProvider) => `${apiPublicUrl()}/auth/oauth/${provider}/callback`;

/** Where the browser may be sent back to: AUTH_RETURN_URLS, comma-separated (contestly://auth, https://play.contestlyapp.com/auth, …). */
const allowedReturns = () => new Set((process.env.AUTH_RETURN_URLS ?? "contestly://auth").split(",").map((u) => u.trim()).filter(Boolean));

export async function startOAuth(session: User, p: { provider: OAuthProvider; returnTo: string; challenge: string }): Promise<{ url: string }> {
  if (!session.isGuest) throw httpError(409, "sign_out_first");
  const client = oauthClients[p.provider];
  if (!client) throw httpError(503, "provider_unavailable");
  if (!allowedReturns().has(p.returnTo)) throw httpError(400, "return_url_not_allowed");
  const state = randomToken(), nonce = randomToken(16), verifier = randomToken();
  const pending: PendingOAuth = { provider: p.provider, sessionUserId: session.id, nonce, verifier, returnTo: p.returnTo, challenge: p.challenge };
  await valkey().set(stateKey(state), JSON.stringify(pending), "EX", OAUTH_STATE_TTL_SECONDS);
  return { url: client.authorizeUrl({ state, nonce, codeChallenge: s256(verifier), redirectUri: callbackUrl(p.provider) }) };
}

const backTo = (returnTo: string, params: Record<string, string>) => {
  const url = new URL(returnTo);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
};

export type CallbackResult = { redirect: string } | { page: string };

/** The provider came back. Returns where to send the browser: the app with a one-time code, or with an error. */
export async function oauthCallback(provider: OAuthProvider, q: { code?: string; state?: string; error?: string }): Promise<CallbackResult> {
  const raw = q.state ? await valkey().getdel(stateKey(q.state)) : null;
  if (!raw) return { page: "This sign-in has expired. Go back to Contestly and try again." };
  const st = JSON.parse(raw) as PendingOAuth;
  if (st.provider !== provider) return { page: "This sign-in didn't match. Go back to Contestly and try again." };
  if (q.error || !q.code) return { redirect: backTo(st.returnTo, { error: "cancelled" }) };
  try {
    const id = await oauthClients[provider]!.identify({ code: q.code, codeVerifier: st.verifier, nonce: st.nonce, redirectUri: callbackUrl(provider) });
    const verified: VerifiedSignIn = { email: id.emailVerified && id.email ? id.email.toLowerCase() : null, identity: { provider, subject: id.subject } };
    const code = randomToken();
    const pending: PendingExchange = { signIn: verified, sessionUserId: st.sessionUserId, challenge: st.challenge };
    await valkey().set(exchangeKey(code), JSON.stringify(pending), "EX", AUTH_EXCHANGE_TTL_SECONDS);
    return { redirect: backTo(st.returnTo, { code }) };
  } catch (e) {
    console.error(`[oauth] ${provider} callback:`, e);
    return { redirect: backTo(st.returnTo, { error: "sign_in_failed" }) };
  }
}

/** The app trades the one-time code for a session token. Same session that started, the right verifier, once, within 60 s. */
export async function exchangeCode(session: User, p: { code: string; verifier: string }): Promise<SignInResult> {
  const raw = await valkey().getdel(exchangeKey(p.code));
  if (!raw) throw httpError(400, "invalid_or_expired_code");
  const x = JSON.parse(raw) as PendingExchange;
  if (x.sessionUserId !== session.id) throw httpError(403, "wrong_session");
  if (s256(p.verifier) !== x.challenge) throw httpError(400, "invalid_verifier");
  return withSessionToken(await signIn(session, x.signIn));
}

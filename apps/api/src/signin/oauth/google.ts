/** Sign in with Google (OpenID Connect, authorization code + PKCE). */
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { OAuthClient } from "./types.js";
import { idTokenRefused, truthy } from "./types.js";

const AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export function googleClient(opts: { clientId: string; clientSecret: string }): OAuthClient {
  return {
    provider: "google",
    authorizeUrl({ state, nonce, codeChallenge, redirectUri }) {
      const q = new URLSearchParams({ client_id: opts.clientId, redirect_uri: redirectUri, response_type: "code", scope: "openid email", state, nonce, code_challenge: codeChallenge, code_challenge_method: "S256", prompt: "select_account" });
      return `${AUTHORIZE}?${q}`;
    },
    async identify({ code, codeVerifier, nonce, redirectUri }) {
      const res = await fetch(TOKEN, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code, client_id: opts.clientId, client_secret: opts.clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: codeVerifier }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw idTokenRefused(`google token ${res.status}`);
      const { id_token } = (await res.json()) as { id_token?: string };
      if (!id_token) throw idTokenRefused("no id_token");
      const { payload } = await jwtVerify(id_token, JWKS, { issuer: ["https://accounts.google.com", "accounts.google.com"], audience: opts.clientId });
      if (payload.nonce !== nonce) throw idTokenRefused("nonce");
      return { subject: payload.sub!, email: typeof payload.email === "string" ? payload.email : null, emailVerified: truthy(payload.email_verified) };
    },
  };
}

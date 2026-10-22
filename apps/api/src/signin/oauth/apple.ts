/**
 * Sign in with Apple on the web flow (Services ID), so it works in the WebView via the system browser.
 * Apple posts the callback (response_mode=form_post, required for the email scope). The client secret
 * is a short-lived ES256 JWT signed with the .p8 key.
 */
import { SignJWT, createRemoteJWKSet, importPKCS8, jwtVerify } from "jose";
import type { OAuthClient } from "./types.js";
import { idTokenRefused, truthy } from "./types.js";

const ISSUER = "https://appleid.apple.com";
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/auth/keys`));
const SECRET_TTL_SECONDS = 5 * 60;

export function appleClient(opts: { servicesId: string; teamId: string; keyId: string; privateKeyPem: string }): OAuthClient {
  const clientSecret = async () => new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: opts.keyId })
    .setIssuer(opts.teamId).setSubject(opts.servicesId).setAudience(ISSUER)
    .setIssuedAt().setExpirationTime(`${SECRET_TTL_SECONDS}s`)
    .sign(await importPKCS8(opts.privateKeyPem.replace(/\\n/g, "\n"), "ES256"));
  return {
    provider: "apple",
    authorizeUrl({ state, nonce, redirectUri }) {
      const q = new URLSearchParams({ client_id: opts.servicesId, redirect_uri: redirectUri, response_type: "code", response_mode: "form_post", scope: "email", state, nonce });
      return `${ISSUER}/auth/authorize?${q}`;
    },
    async identify({ code, redirectUri, nonce }) {
      const res = await fetch(`${ISSUER}/auth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: opts.servicesId, client_secret: await clientSecret(), code, grant_type: "authorization_code", redirect_uri: redirectUri }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw idTokenRefused(`apple token ${res.status}`);
      const { id_token } = (await res.json()) as { id_token?: string };
      if (!id_token) throw idTokenRefused("no id_token");
      const { payload } = await jwtVerify(id_token, JWKS, { issuer: ISSUER, audience: opts.servicesId });
      if (payload.nonce !== nonce) throw idTokenRefused("nonce");
      return { subject: payload.sub!, email: typeof payload.email === "string" ? payload.email : null, emailVerified: truthy(payload.email_verified) };
    },
  };
}

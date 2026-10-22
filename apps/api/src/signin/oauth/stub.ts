/**
 * DEV ONLY (AUTH_MODE=dev, which never runs in production): stands in for Google or Apple when their
 * credentials aren't set. The "provider" is a page on this API that asks for an email (or takes
 * ?login_hint=) and comes back to the callback like the real thing, so the app and the sims run the
 * whole system-browser → deep link → exchange flow locally.
 */
import type { OAuthProvider } from "@contestly/shared";
import type { OAuthClient } from "./types.js";
import { idTokenRefused } from "./types.js";

export const STUB_AUTHORIZE_PATH = "/auth/oauth/stub/authorize";

/** The stub's "provider code": the identity and nonce, readable only by the stub. */
export const stubCode = (p: { email: string; nonce: string; provider: string }) => Buffer.from(JSON.stringify(p)).toString("base64url");

export function stubClient(provider: OAuthProvider, apiBase: string): OAuthClient {
  return {
    provider,
    authorizeUrl({ state, nonce, redirectUri }) {
      return `${apiBase}${STUB_AUTHORIZE_PATH}?${new URLSearchParams({ provider, state, nonce, redirect_uri: redirectUri })}`;
    },
    async identify({ code, nonce }) {
      let p: { email?: string; nonce?: string; provider?: string };
      try {
        p = JSON.parse(Buffer.from(code, "base64url").toString());
      } catch {
        throw idTokenRefused("stub code");
      }
      if (p.nonce !== nonce || p.provider !== provider || !p.email) throw idTokenRefused("stub nonce");
      const email = p.email.toLowerCase();
      return { subject: `stub-${provider}-${email}`, email, emailVerified: true };
    },
  };
}

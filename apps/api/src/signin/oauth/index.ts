/** The sign-in providers this API offers, from env. In AUTH_MODE=dev a provider without credentials is the stub. */
import type { OAuthProvider } from "@contestly/shared";
import { authMode } from "@contestly/auth";
import type { OAuthClient } from "./types.js";
import { googleClient } from "./google.js";
import { appleClient } from "./apple.js";
import { stubClient } from "./stub.js";

export type { OAuthClient, ProviderIdentity } from "./types.js";
export { STUB_AUTHORIZE_PATH, stubCode } from "./stub.js";

/** The API's public base URL, which the providers send the browser back to. */
export const apiPublicUrl = () => (process.env.API_PUBLIC_URL ?? `http://localhost:${process.env.API_PORT ?? 4000}`).replace(/\/+$/, "");

export function oauthClientsFromEnv(env: NodeJS.ProcessEnv): Partial<Record<OAuthProvider, OAuthClient>> {
  const clients: Partial<Record<OAuthProvider, OAuthClient>> = {};
  if (env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET) clients.google = googleClient({ clientId: env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET });
  if (env.APPLE_SERVICES_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY) {
    clients.apple = appleClient({ servicesId: env.APPLE_SERVICES_ID, teamId: env.APPLE_TEAM_ID, keyId: env.APPLE_KEY_ID, privateKeyPem: env.APPLE_PRIVATE_KEY });
  }
  if (authMode(env) === "dev") {
    clients.google ??= stubClient("google", apiPublicUrl());
    clients.apple ??= stubClient("apple", apiPublicUrl());
  }
  return clients;
}

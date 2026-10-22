import type { OAuthProvider } from "@contestly/shared";

/** Who the provider says signed in, after its ID token checked out (signature, issuer, audience, nonce). */
export interface ProviderIdentity {
  subject: string;
  email: string | null;
  emailVerified: boolean;
}

/**
 * One sign-in provider, run by us over the system browser (no Firebase popup or redirect): we send the
 * browser to authorizeUrl, the provider comes back to our callback with a code, and identify() turns
 * that code into a verified identity. Google, Apple and the dev stub implement it.
 */
export interface OAuthClient {
  readonly provider: OAuthProvider;
  authorizeUrl(p: { state: string; nonce: string; codeChallenge: string; redirectUri: string }): string;
  identify(p: { code: string; codeVerifier: string; nonce: string; redirectUri: string }): Promise<ProviderIdentity>;
}

export const idTokenRefused = (why: string) => Object.assign(new Error(`id_token_refused: ${why}`), { statusCode: 401 });

/** Apple sends booleans as strings in its ID token. */
export const truthy = (v: unknown) => v === true || v === "true";

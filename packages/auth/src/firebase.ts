/**
 * Firebase Admin, used only as a session issuer: it verifies ID tokens (anonymous sessions, our custom
 * tokens, and the phone check) and mints custom tokens. The project is config: FIREBASE_PROJECT_ID and a
 * service account (FIREBASE_SERVICE_ACCOUNT_JSON, else application default credentials). With
 * FIREBASE_AUTH_EMULATOR_HOST set, firebase-admin talks to the local emulator and needs no credentials.
 * We never change anything else in the project: no custom claims, no provider settings, no user edits
 * except deleting the throwaway phone-check users we created ourselves.
 */
import type { Auth, DecodedIdToken } from "firebase-admin/auth";

let auth: Auth | undefined;

async function firebaseAuth(): Promise<Auth> {
  if (auth) return auth;
  const { getApps, initializeApp, applicationDefault, cert } = await import("firebase-admin/app");
  const { getAuth } = await import("firebase-admin/auth");
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error("FIREBASE_PROJECT_ID is not set");
  if (!getApps().length) {
    const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const emulator = !!process.env.FIREBASE_AUTH_EMULATOR_HOST;
    initializeApp({ projectId, ...(json ? { credential: cert(JSON.parse(json)) } : emulator ? {} : { credential: applicationDefault() }) });
  }
  auth = getAuth();
  return auth;
}

/** null for a token that doesn't verify (expired, forged, another project). */
export async function verifyIdToken(token: string): Promise<DecodedIdToken | null> {
  const a = await firebaseAuth();
  try {
    return await a.verifyIdToken(token);
  } catch {
    return null;
  }
}

export const isAnonymousToken = (t: DecodedIdToken) => t.firebase?.sign_in_provider === "anonymous";

/** A session token for `uid`, which the app signs in with (signInWithCustomToken). */
export async function createCustomToken(uid: string): Promise<string> {
  return (await firebaseAuth()).createCustomToken(uid);
}

/** Remove a Firebase user we created ourselves and don't keep (the phone check's throwaway user). */
export async function deleteFirebaseUser(uid: string): Promise<void> {
  await (await firebaseAuth()).deleteUser(uid);
}

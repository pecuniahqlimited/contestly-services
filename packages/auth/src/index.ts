import { eq } from "drizzle-orm";
import { db, ledger, users, type User } from "@contestly/db";

export class Unauthorized extends Error { constructor(msg = "unauthorized") { super(msg); } }

const MODE = process.env.AUTH_MODE ?? "dev";

/**
 * Turns request credentials into a User row (or null for a brand-new Firebase account that hasn't completed onboarding).
 * - dev mode: `x-dev-user: <handle>` header. Creates the user on first sight, with the welcome coins
 *   onboarding would grant, so you can test without Firebase.
 * - firebase mode: `Authorization: Bearer <idToken>`; verified with firebase-admin; matched on firebase_uid.
 */
export async function resolveUser(h: { authorization?: string; devUser?: string }): Promise<{ user: User | null; firebaseUid?: string; phone?: string }> {
  if (MODE === "dev") {
    const handle = h.devUser?.trim().toLowerCase();
    if (!handle) throw new Unauthorized("set x-dev-user: <handle> (AUTH_MODE=dev)");
    const [u] = await db.select().from(users).where(eq(users.handle, handle));
    if (u) return { user: u };
    const created = await db.transaction(async (tx) => {
      const [u] = await tx.insert(users).values({ handle, displayName: handle, firebaseUid: `dev:${handle}` }).onConflictDoNothing().returning();
      if (u) await ledger.grantWelcome(tx, u.id);
      return u;
    });
    // Two first requests at once: the other one created it.
    return { user: created ?? (await db.select().from(users).where(eq(users.handle, handle)))[0] };
  }
  const token = h.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) throw new Unauthorized();
  const { getApps, initializeApp, applicationDefault } = await import("firebase-admin/app");
  const { getAuth } = await import("firebase-admin/auth");
  if (!getApps().length) initializeApp({ credential: applicationDefault(), projectId: process.env.FIREBASE_PROJECT_ID });
  const decoded = await getAuth().verifyIdToken(token).catch(() => { throw new Unauthorized("invalid token"); });
  const [u] = await db.select().from(users).where(eq(users.firebaseUid, decoded.uid));
  return { user: u ?? null, firebaseUid: decoded.uid, phone: decoded.phone_number };
}
